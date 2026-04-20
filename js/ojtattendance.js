/**
 * OJTrack PH — ojtattendance.js
 * ─────────────────────────────────────────────────────────────
 * FIXES:
 *  1. Writes: 'uid' (not 'userId'), 'timestamp' (not 'createdAt'),
 *             'displayDate', 'attachment' (not 'attachmentBase64')
 *  2. Reads:  where('uid'), orderBy('timestamp')
 *  3. Theme toggle wired for sidebar-theme-btn AND theme-toggle-btn
 *  4. Computed hours from timeIn/timeOut (schema has no hoursRendered)
 * ─────────────────────────────────────────────────────────────
 */

import { protectPage } from '../authguard.js';
import { auth, db } from '../firebase-config.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, addDoc, query, where, onSnapshot,
    serverTimestamp, orderBy, doc, getDoc, limit
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, formatTimestamp
} from '../js/theme.js';
import { setupNotificationSystem } from '../js/notifications.js';

// ─── INIT ────────────────────────────────────────────────────
initTheme();

let currentCalMonth = new Date();
let userData = null;
let loggedDateSet = new Set(); // for calendar highlighting

// ─── AUTH ────────────────────────────────────────────────────
protectPage('student').then((user) => {
    // ✅ Wire BOTH theme toggle buttons
    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);
    setupLogout();

    loadUserProfile(user);
    listenToAttendanceLogs(user.uid);
    renderCalendar(currentCalMonth);
    setupCalendarNav();
    setupForm(user);
    setupNowButtons();
    setupHoursPreview();
    setupFileLabel();

    // Date header
    const dateEl = document.getElementById('current-date-display-inner');
    if (dateEl) {
        dateEl.textContent = `📅 ${new Date().toLocaleDateString('en-PH', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        })}`;
    }
});

function setupLogout() {
    ['logout-link', 'sidebar-logout-btn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', () =>
            signOut(auth).then(() => window.location.replace('/index.html'))
        );
    });
}

// ─── USER PROFILE ────────────────────────────────────────────
async function loadUserProfile(user) {
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) return;
        userData = snap.data();
        const name = userData.name
            || `${userData.firstName || ''} ${userData.surname || ''}`.trim()
            || 'Student';
        populateHeaderUser(name, user.email);
        updateSummary(parseFloat(userData.hoursCompleted) || 0,
                      parseFloat(userData.requiredHours)  || 600);
    } catch (e) {
        console.error('[Attendance] loadUserProfile:', e);
    }
}

// ─── NOW BUTTONS ─────────────────────────────────────────────
function setupNowButtons() {
    document.getElementById('btn-in-now')?.addEventListener('click',  () => setTimeToNow('in'));
    document.getElementById('btn-out-now')?.addEventListener('click', () => setTimeToNow('out'));
}

window.setTimeToNow = function(prefix) {
    const now  = new Date();
    let h      = now.getHours();
    const m    = now.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;

    setVal(`${prefix}-hour`,   h);
    setVal(`${prefix}-minute`, String(m).padStart(2, '0'));
    const ampmEl = document.getElementById(`${prefix}-ampm`);
    if (ampmEl) ampmEl.value = ampm;
    updateHoursPreview();
};

// ─── HOURS PREVIEW ───────────────────────────────────────────
function setupHoursPreview() {
    ['in-hour','in-minute','in-ampm','out-hour','out-minute','out-ampm'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', updateHoursPreview);
        document.getElementById(id)?.addEventListener('input',  updateHoursPreview);
    });
}

function updateHoursPreview() {
    const tIn  = getTimeString('in');
    const tOut = getTimeString('out');
    if (!tIn || !tOut) return;

    const hours = computeHoursDecimal(tIn, tOut);
    const wrap  = document.getElementById('hours-preview');
    const text  = document.getElementById('hours-preview-text');

    if (wrap && text) {
        if (hours > 0) {
            text.textContent     = `${hours.toFixed(2)} hours computed`;
            wrap.style.display   = 'flex';
        } else {
            wrap.style.display   = 'none';
        }
    }
}

function getTimeString(prefix) {
    const h    = document.getElementById(`${prefix}-hour`)?.value;
    const m    = document.getElementById(`${prefix}-minute`)?.value;
    const ampm = document.getElementById(`${prefix}-ampm`)?.value;
    if (!h || m === undefined || m === '') return null;
    return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
}

// ─── FILE LABEL ───────────────────────────────────────────────
function setupFileLabel() {
    const fileInput = document.getElementById('attendance-file');
    const fileText  = document.getElementById('file-name-text');
    fileInput?.addEventListener('change', () => {
        if (fileInput.files[0]) {
            const name = fileInput.files[0].name;
            if (fileText) fileText.textContent = name.length > 36 ? name.slice(0,33)+'…' : name;
        }
    });
}

// ─── FORM SUBMISSION ──────────────────────────────────────────
function setupForm(user) {
    const form = document.getElementById('attendance-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showError('');

        const tIn  = getTimeString('in');
        const tOut = getTimeString('out');
        if (!tIn || !tOut) {
            showError('Please enter both Time In and Time Out.');
            return;
        }

        const hours = computeHoursDecimal(tIn, tOut);
        if (hours <= 0 || hours > 24) {
            showError('Invalid time range. Time Out must be after Time In.');
            return;
        }

        const note  = sanitizeStr(document.getElementById('attendance-note')?.value || '');
        const today = new Date();
        // ✅ Correct fields per schema
        const displayDate = today.toLocaleDateString('en-US', {
            month: 'short', day: '2-digit', year: 'numeric'
        });

        const btn = document.getElementById('submit-log-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

        try {
            let attachment = null;
            const fileInput = document.getElementById('attendance-file');
            if (fileInput?.files[0]) {
                attachment = await fileToBase64(fileInput.files[0]);
            }

            // ✅ Write correct schema fields
            await addDoc(collection(db, 'attendance'), {
                uid:         user.uid,           // ✅ 'uid' not 'userId'
                displayDate: displayDate,         // ✅ 'displayDate' not 'date'
                timeIn:      tIn,
                timeOut:     tOut,
                note:        note,
                attachment:  attachment,          // ✅ 'attachment' not 'attachmentBase64'
                status:      'pending',
                timestamp:   serverTimestamp(),   // ✅ 'timestamp' not 'createdAt'
                dismissedBy: [],
            });

            form.reset();
            const fileText = document.getElementById('file-name-text');
            if (fileText) fileText.textContent = 'Click to choose file — JPG, PNG, PDF, DOCX';
            const preview = document.getElementById('hours-preview');
            if (preview) preview.style.display = 'none';

        } catch (err) {
            console.error('[Attendance] submit error:', err);
            showError('Failed to submit. Please try again.');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🕒 Submit Attendance Log'; }
        }
    });
}

// ─── REALTIME LOG LISTENER ────────────────────────────────────
function listenToAttendanceLogs(uid) {
    // ✅ FIX: where('uid'), orderBy('timestamp')
    const q = query(
        collection(db, 'attendance'),
        where('uid', '==', uid),
        orderBy('timestamp', 'desc'),
        limit(30)
    );

    onSnapshot(q, (snap) => {
        const listEl = document.getElementById('log-list');
        loggedDateSet.clear();

        if (!listEl) return;

        if (snap.empty) {
            listEl.innerHTML = '<p class="empty-text">No attendance records yet.</p>';
            updateSummary(0, parseFloat(userData?.requiredHours) || 600);
            return;
        }

        let totalApproved = 0;

        listEl.innerHTML = snap.docs.map(d => {
            const log  = d.data();
            // ✅ FIX: use 'displayDate' not 'date'
            const date  = sanitizeText(log.displayDate || formatTimestamp(log.timestamp));
            const tIn   = sanitizeText(log.timeIn  || '—');
            const tOut  = sanitizeText(log.timeOut || '—');
            const hrs   = computeHoursDecimal(log.timeIn, log.timeOut);
            const hrsStr = hrs > 0 ? `${hrs.toFixed(2)}h` : '—';
            const note  = log.note ? sanitizeText(log.note) : '';

            if ((log.status || '').toLowerCase() === 'approved') totalApproved += hrs;

            // For calendar
            if (log.timestamp?.toDate) {
                const d = log.timestamp.toDate();
                loggedDateSet.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
            }

            const statusMap = {
                approved: '<span class="badge badge-success">✅ Approved</span>',
                rejected: '<span class="badge badge-danger">❌ Rejected</span>',
                pending:  '<span class="badge badge-warning">⏳ Pending</span>',
            };
            const badge = statusMap[(log.status || 'pending').toLowerCase()] || statusMap.pending;

            // ✅ FIX: use 'attachment' field
            const hasFile = log.attachment;
            const fileBtn = hasFile
                ? `<button class="view-btn" data-src="${sanitizeText(log.attachment).slice(0,50)}...">View</button>`
                : '—';

            return `
              <div class="log-entry">
                <span class="log-date">${date}</span>
                <span class="log-time">${tIn}</span>
                <span class="log-time">${tOut}</span>
                <span style="font-family:var(--font-display);font-weight:700;color:var(--brand-gold);">${hrsStr}</span>
                ${badge}
                <span>${hasFile ? `<button class="view-btn" onclick="openAttachmentById('${sanitizeText(d.id)}')">View</button>` : '—'}</span>
              </div>
              ${note ? `<div style="padding:2px 0 8px 0;font-size:0.78rem;color:var(--text-muted);">📝 ${note}</div>` : ''}`;
        }).join('');

        // Store log data for view buttons
        window._attendanceLogs = {};
        snap.docs.forEach(d => {
            window._attendanceLogs[d.id] = d.data();
        });

        updateSummary(totalApproved, parseFloat(userData?.requiredHours) || 600);
        renderCalendar(currentCalMonth); // re-render with logged days
    }, err => console.error('[Attendance] listener error:', err));
}

window.openAttachmentById = function(id) {
    const log = window._attendanceLogs?.[id];
    if (!log?.attachment) return;
    openFileData(log.attachment);
};

function openFileData(src) {
    if (!src) return;
    if (src.startsWith('https://') || src.startsWith('http://')) {
        window.open(src, '_blank', 'noopener,noreferrer');
        return;
    }
    if (src.startsWith('data:')) {
        try {
            const [meta, data] = src.split(';base64,');
            const type  = meta.split(':')[1];
            const raw   = atob(data);
            const arr   = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
            window.open(URL.createObjectURL(new Blob([arr], { type })), '_blank', 'noopener,noreferrer');
        } catch {
            alert('Could not open attachment.');
        }
    }
}

function updateSummary(completed, required) {
    const pct = required > 0 ? Math.min(100, (completed / required) * 100) : 0;
    const totalEl = document.getElementById('total-hours');
    if (totalEl) totalEl.innerHTML = `${completed.toFixed(1)}<span style="font-size:1.2rem">h</span>`;
    const barEl = document.getElementById('progress-bar');
    if (barEl) barEl.style.width = `${pct}%`;
    const textEl = document.getElementById('progress-text');
    if (textEl) textEl.textContent = `of ${required}h required (${Math.round(pct)}%)`;
}

// ─── CALENDAR ────────────────────────────────────────────────
function setupCalendarNav() {
    document.getElementById('prevMonth')?.addEventListener('click', () => {
        currentCalMonth.setMonth(currentCalMonth.getMonth() - 1);
        renderCalendar(currentCalMonth);
    });
    document.getElementById('nextMonth')?.addEventListener('click', () => {
        currentCalMonth.setMonth(currentCalMonth.getMonth() + 1);
        renderCalendar(currentCalMonth);
    });
}

function renderCalendar(date) {
    const grid    = document.getElementById('mini-calendar');
    const display = document.getElementById('monthDisplay');
    if (!grid || !display) return;

    grid.innerHTML = '';
    const year  = date.getFullYear();
    const month = date.getMonth();
    display.textContent = date.toLocaleString('default', { month: 'long', year: 'numeric' });

    ['S','M','T','W','T','F','S'].forEach(d => {
        const b = document.createElement('b');
        b.textContent = d;
        grid.appendChild(b);
    });

    const firstDay    = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today       = new Date();

    for (let i = 0; i < firstDay; i++) grid.appendChild(document.createElement('div'));

    for (let i = 1; i <= daysInMonth; i++) {
        const el  = document.createElement('div');
        el.textContent = i;
        const key = `${year}-${month}-${i}`;
        if (i === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
            el.className = 'today-circle';
        } else if (loggedDateSet.has(key)) {
            el.className = 'has-log';
        }
        grid.appendChild(el);
    }
}

// ─── UTILITIES ───────────────────────────────────────────────
function computeHoursDecimal(timeIn, timeOut) {
    if (!timeIn || !timeOut) return 0;
    const parse = (t) => {
        const [part, mod] = String(t).split(' ');
        let [h, m] = part.split(':').map(Number);
        if (mod === 'PM' && h < 12) h += 12;
        if (mod === 'AM' && h === 12) h = 0;
        return h + m / 60;
    };
    const diff = parse(timeOut) - parse(timeIn);
    return diff < 0 ? diff + 24 : diff;
}

function showError(msg) {
    const el = document.getElementById('error-message');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

function sanitizeStr(str, max = 500) {
    return String(str).trim().slice(0, max);
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function fileToBase64(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res(r.result);
        r.onerror = () => rej(new Error('File read failed'));
        r.readAsDataURL(file);
    });
}
