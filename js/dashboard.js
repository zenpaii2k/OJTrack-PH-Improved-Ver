/**
 * OJTrack PH — dashboard.js
 * ─────────────────────────────────────────────────────────────
 * FIXES IN THIS VERSION:
 *  1. attendance: where('uid') not where('userId')
 *  2. attendance: orderBy('timestamp') not orderBy('createdAt')
 *  3. attendance: log.displayDate not log.date; log.attachment not log.attachmentUrl
 *  4. users: data.hoursCompleted not data.completedHours
 *  5. users: data.timeStart/timeEnd not data.shiftStart/shiftEnd
 *  6. users: data.surname not data.lastName (for name building)
 *  7. Feedback: orderBy('timestamp') matches the write in checkstudentdatabase.js
 * ─────────────────────────────────────────────────────────────
 */

import { auth, db } from '../firebase-config.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    doc, getDoc, collection, query, where,
    onSnapshot, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { protectPage } from '../authguard.js';
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, formatTimestamp,
} from '../js/theme.js';
import { setupNotificationSystem } from '../js/notifications.js';

// ─── INIT ────────────────────────────────────────────────────
initTheme();

let currentMonth = new Date();
let userData     = null;

// ─── AUTH ────────────────────────────────────────────────────
protectPage('student').then((user) => {
    initDashboard(user);
});

function initDashboard(user) {
    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupLogoutButtons(user);
    setupCalendarNav();

    loadUserProfile(user);
    setupNotificationSystem(user.uid);
    syncAttendanceLogs(user.uid);
    renderCalendar(currentMonth);
}

// ─── LOGOUT ──────────────────────────────────────────────────
function setupLogoutButtons() {
    ['logout-link', 'sidebar-logout-btn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', async () => {
            await signOut(auth);
            window.location.replace('/index.html');
        });
    });
}

// ─── USER PROFILE ────────────────────────────────────────────
async function loadUserProfile(user) {
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) return;
        userData = snap.data();

        // ✅ FIX: schema uses 'surname' not 'lastName'
        const name = userData.name
            || `${userData.firstName || ''} ${userData.surname || ''}`.trim()
            || 'Student';

        populateHeaderUser(name, user.email);

        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        setEl('greeting-text', `${greeting}, ${userData.firstName || name}!`);
        setEl('greeting-sub',  `${userData.course || 'OJT'} Student · ${userData.company || 'No company set'}`);

        // Info strip
        setEl('chip-company', `🏢 ${userData.company || 'No company set'}`);
        setEl('chip-school',   `📁 ${userData.school  || 'No batch assigned'}`);
        setEl('chip-course',  `🎓 ${userData.course || '—'} · ${userData.fullSection || userData.section || '—'}`);

        updateProgressStats(userData);
        loadFeedback(user.uid);

    } catch (err) {
        console.error('[Dashboard] loadUserProfile error:', err);
    }
}

// ─── PROGRESS STATS ──────────────────────────────────────────
function updateProgressStats(data) {
    const required  = parseFloat(data.requiredHours) || 600;
    // ✅ FIX: schema uses 'hoursCompleted' not 'completedHours'
    const completed = parseFloat(data.hoursCompleted) || 0;
    const remaining = Math.max(0, required - completed);
    const pct       = required > 0 ? Math.min(100, (completed / required) * 100) : 0;

    setEl('hrs-completed', completed.toFixed(1));
    setEl('hrs-remaining', remaining.toFixed(1));
    setEl('hrs-total-sub', `of ${required}h required`);
    setEl('progress-pct',  `${Math.round(pct)}%`);

    const bar = document.getElementById('progress-bar');
    if (bar) bar.style.width = `${pct}%`;

    animateProgressRing(pct);

    // ✅ FIX: schema uses 'timeStart'/'timeEnd' not 'shiftStart'/'shiftEnd'
    const shiftHrs = estimateDailyHours(data.timeStart, data.timeEnd);
    const daysLeft = shiftHrs > 0 ? Math.ceil(remaining / shiftHrs) : null;
    setEl('days-sub', daysLeft
        ? `~${daysLeft} working day${daysLeft !== 1 ? 's' : ''} left`
        : 'Shift hours not set');
}

function estimateDailyHours(start, end) {
    if (!start || !end) return 0;
    const toDecimal = (t) => {
        const [h, m] = String(t).split(':').map(Number);
        return h + (m || 0) / 60;
    };
    const diff = toDecimal(end) - toDecimal(start);
    return diff > 0 ? diff : 0;
}

function animateProgressRing(pct) {
    const circle = document.getElementById('ring-circle');
    if (!circle) return;
    const circumference = 2 * Math.PI * 32;
    circle.style.strokeDasharray  = circumference;
    circle.style.strokeDashoffset = circumference - (pct / 100) * circumference;
}

// ─── ATTENDANCE LOGS ──────────────────────────────────────────
function syncAttendanceLogs(uid) {
    // ✅ FIX: 'uid' field not 'userId'; 'timestamp' not 'createdAt'
    const q = query(
        collection(db, 'attendance'),
        where('uid', '==', uid),
        orderBy('timestamp', 'desc'),
        limit(10),
    );

    onSnapshot(q, (snap) => {
        const tbody = document.getElementById('logs-tbody');
        if (!tbody) return;

        if (snap.empty) {
            tbody.innerHTML = `
              <tr>
                <td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted);">
                  No attendance logs yet.
                  <a href="ojtattendance.html" style="color:var(--brand-gold);">Log your first day →</a>
                </td>
              </tr>`;
            return;
        }

        tbody.innerHTML = snap.docs.map(d => {
            const log = d.data();
            // ✅ FIX: 'displayDate' not 'date'; 'attachment' not 'attachmentUrl'
            const date  = sanitizeText(log.displayDate || formatTimestamp(log.timestamp));
            const tIn   = sanitizeText(log.timeIn  || '—');
            const tOut  = sanitizeText(log.timeOut || '—');

            // Compute hours from timeIn/timeOut since schema has no hoursRendered
            const hrs = computeHoursDisplay(log.timeIn, log.timeOut);

            const statusMap = {
                approved: '<span class="badge badge-success">Approved</span>',
                rejected: '<span class="badge badge-danger">Rejected</span>',
                pending:  '<span class="badge badge-warning">Pending</span>',
            };
            const statusBadge = statusMap[(log.status || 'pending').toLowerCase()] || statusMap.pending;

            // ✅ FIX: use 'attachment' field
            const hasFile = log.attachment;
            const fileBtn = hasFile
                ? `<button class="view-btn" onclick="openAttachment(this)" data-src="${sanitizeText(log.attachment)}">View</button>`
                : `<span style="color:var(--text-muted);font-size:0.78rem;">—</span>`;

            return `
              <tr>
                <td>${date}</td>
                <td>${tIn}</td>
                <td>${tOut}</td>
                <td>${hrs}</td>
                <td>${statusBadge}</td>
                <td>${fileBtn}</td>
              </tr>`;
        }).join('');

        // Wire view buttons safely (no inline event with user data)
        tbody.querySelectorAll('.view-btn[data-src]').forEach(btn => {
            btn.addEventListener('click', () => openAttachment(btn));
        });

        // Recalculate completed hours from approved logs
        const totalApproved = snap.docs.reduce((sum, d) => {
            const log = d.data();
            if ((log.status || '').toLowerCase() !== 'approved') return sum;
            return sum + computeHoursDecimal(log.timeIn, log.timeOut);
        }, 0);

        if (userData) {
            userData.hoursCompleted = totalApproved;
            updateProgressStats(userData);
        }

    }, (err) => {
        console.error('[Dashboard] syncAttendanceLogs error:', err);
    });
}

// ─── FEEDBACK ────────────────────────────────────────────────
function loadFeedback(uid) {
    // ✅ FIX: orderBy('timestamp') — matches what checkstudentdatabase.js writes
    const q = query(
        collection(db, 'students', uid, 'feedback'),
        orderBy('timestamp', 'desc'),
        limit(5),
    );

    onSnapshot(q, (snap) => {
        const container = document.getElementById('feedback-container');
        if (!container) return;

        if (snap.empty) {
            container.innerHTML = '<p class="empty-text">No feedback from your adviser yet.</p>';
            return;
        }

        container.innerHTML = snap.docs.map(d => {
            const fb     = d.data();
            // ✅ FIX: adviser writes 'senderName' not 'adviserName'
            const author = sanitizeText(fb.senderName || fb.adviserName || 'Adviser');
            const msg    = sanitizeText(fb.message || '');
            const time   = formatTimestamp(fb.timestamp);

            return `
              <div class="feedback-card">
                <div class="fb-meta">
                  <span class="fb-author">👨‍🏫 ${author}</span>
                  <span class="fb-time">${time}</span>
                </div>
                <div class="fb-body">${msg}</div>
              </div>`;
        }).join('');
    });
}

// ─── CALENDAR ────────────────────────────────────────────────
function setupCalendarNav() {
    document.getElementById('prevMonth')?.addEventListener('click', () => {
        currentMonth.setMonth(currentMonth.getMonth() - 1);
        renderCalendar(currentMonth);
    });
    document.getElementById('nextMonth')?.addEventListener('click', () => {
        currentMonth.setMonth(currentMonth.getMonth() + 1);
        renderCalendar(currentMonth);
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
        const el = document.createElement('div');
        el.textContent = i;
        if (i === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
            el.className = 'today-circle';
        }
        grid.appendChild(el);
    }
}

// ─── ATTACHMENT VIEWER ────────────────────────────────────────
window.openAttachment = function(btnOrUrl) {
    const src = typeof btnOrUrl === 'string'
        ? btnOrUrl
        : btnOrUrl.dataset.src;
    if (!src) return;

    if (src.startsWith('https://') || src.startsWith('http://')) {
        window.open(src, '_blank', 'noopener,noreferrer');
    } else if (src.startsWith('data:')) {
        try {
            const [meta, data] = src.split(';base64,');
            const type  = meta.split(':')[1];
            const raw   = atob(data);
            const arr   = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
            const url = URL.createObjectURL(new Blob([arr], { type }));
            window.open(url, '_blank', 'noopener,noreferrer');
        } catch {
            alert('Could not open attachment. Please contact support.');
        }
    }
};

// ─── HELPERS ─────────────────────────────────────────────────
function setEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

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

function computeHoursDisplay(timeIn, timeOut) {
    const h = computeHoursDecimal(timeIn, timeOut);
    return h > 0 ? `${h.toFixed(1)}h` : '—';
}
