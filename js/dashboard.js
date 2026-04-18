/**
 * OJTrack PH — dashboard.js (Improved)
 * ─────────────────────────────────────────────────────────────
 * Student Dashboard — main page logic.
 *
 * Key Improvements:
 *  1. Imports centralized theme.js and notifications.js
 *  2. No more duplicate initTheme / applyTheme
 *  3. Uses textContent instead of innerHTML where safe
 *  4. Progress ring animation
 *  5. Info strip population (company, batch, adviser, course)
 *  6. No console.log(user.email) in production
 *  7. Feedback section renders securely
 * ─────────────────────────────────────────────────────────────
 */

import { auth, db } from '../firebase-config.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    doc, getDoc, collection, query, where,
    onSnapshot, orderBy, limit
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { protectPage } from '../authguard.js';

// ── Shared modules (replaces per-page duplication)
import {
    initTheme,
    setupThemeToggle,
    setupProfileDropdown,
    setupNotifDropdown,
    populateHeaderUser,
    sanitizeText,
    formatTimestamp,
} from '../js/theme.js';

import { setupNotificationSystem } from '../js/notifications.js';

// ─── INIT THEME (must run before body renders) ───────────────
initTheme();

// ─── STATE ───────────────────────────────────────────────────
let currentMonth = new Date();
let userData     = null;

// ─── AUTH GUARD ──────────────────────────────────────────────
protectPage('student').then((user) => {
    // NOTE: Removed console.log(user.email) — do not log PII in production.
    initDashboard(user);
});

// ─── MAIN INIT ───────────────────────────────────────────────
function initDashboard(user) {
    // 1. Setup UI controls
    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupLogoutButtons(user);
    setupCalendarNav();

    // 2. Load data
    loadUserProfile(user);
    setupNotificationSystem(user.uid);
    syncAttendanceLogs(user.uid);

    // 3. Initial calendar render
    renderCalendar(currentMonth);
}

// ─── LOGOUT ──────────────────────────────────────────────────
function setupLogoutButtons(user) {
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

        const name = `${userData.firstName || ''} ${userData.lastName || ''}`.trim()
                     || userData.name
                     || 'Student';

        // Header display
        populateHeaderUser(name, user.email);

        // Page greeting
        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
        setEl('greeting-text', `${greeting}, ${userData.firstName || name}!`);
        setEl('greeting-sub', `${userData.course || 'OJT'} Student · ${userData.company || 'No company set'}`);

        // Info strip chips
        setEl('chip-company', `🏢 ${userData.company || 'No company set'}`);
        setEl('chip-batch',   `📁 ${userData.batchId || 'No batch assigned'}`);
        setEl('chip-adviser', `👨‍🏫 ${userData.adviserName || 'No adviser set'}`);
        setEl('chip-course',  `🎓 ${userData.course || '—'} · ${userData.section || '—'}`);

        // Stats
        updateProgressStats(userData);

        // Load feedback
        loadFeedback(user.uid);

    } catch (err) {
        console.error('[Dashboard] loadUserProfile error:', err);
    }
}

// ─── PROGRESS STATS ───────────────────────────────────────────
function updateProgressStats(data) {
    const required   = parseFloat(data.requiredHours)  || 600;
    const completed  = parseFloat(data.completedHours) || 0;
    const remaining  = Math.max(0, required - completed);
    const pct        = required > 0 ? Math.min(100, (completed / required) * 100) : 0;

    setEl('hrs-completed', `${completed.toFixed(1)}`);
    setEl('hrs-remaining', `${remaining.toFixed(1)}`);
    setEl('hrs-total-sub', `of ${required}h required`);
    setEl('progress-pct',  `${Math.round(pct)}%`);

    // Progress bar fill
    const bar = document.getElementById('progress-bar');
    if (bar) bar.style.width = `${pct}%`;

    // SVG ring
    animateProgressRing(pct);

    // Days estimate
    const shiftHrs  = estimateDailyHours(data.shiftStart, data.shiftEnd);
    const daysLeft  = shiftHrs > 0 ? Math.ceil(remaining / shiftHrs) : null;
    setEl('days-sub', daysLeft
        ? `~${daysLeft} working day${daysLeft !== 1 ? 's' : ''} left`
        : 'Shift hours not set');
}

function estimateDailyHours(start, end) {
    if (!start || !end) return 0;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const diff = (eh + em / 60) - (sh + sm / 60);
    return diff > 0 ? diff : 0;
}

// ─── SVG PROGRESS RING ────────────────────────────────────────
function animateProgressRing(pct) {
    const circle = document.getElementById('ring-circle');
    if (!circle) return;

    const radius      = 32;
    const circumference = 2 * Math.PI * radius; // ≈ 201.06
    const offset      = circumference - (pct / 100) * circumference;

    circle.style.strokeDasharray  = circumference;
    circle.style.strokeDashoffset = offset;
}

// ─── ATTENDANCE LOGS ──────────────────────────────────────────
function syncAttendanceLogs(uid) {
    const q = query(
        collection(db, 'attendance'),
        where('userId', '==', uid),
        orderBy('createdAt', 'desc'),
        limit(10),
    );

    onSnapshot(q, (snap) => {
        const tbody = document.getElementById('logs-tbody');
        if (!tbody) return;

        if (snap.empty) {
            tbody.innerHTML = `
              <tr>
                <td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted);">
                  No attendance logs yet. <a href="ojtattendance.html" style="color:var(--brand-gold);">Log your first day →</a>
                </td>
              </tr>`;
            return;
        }

        tbody.innerHTML = snap.docs.map(d => {
            const log  = d.data();
            const date = sanitizeText(log.date || formatTimestamp(log.createdAt));
            const tIn  = sanitizeText(log.timeIn  || '—');
            const tOut = sanitizeText(log.timeOut || '—');
            const hrs  = typeof log.hoursRendered === 'number'
                ? `${log.hoursRendered.toFixed(1)}h`
                : '—';

            const statusMap = {
                approved: '<span class="badge badge-success">Approved</span>',
                rejected: '<span class="badge badge-danger">Rejected</span>',
                pending:  '<span class="badge badge-warning">Pending</span>',
            };
            const statusBadge = statusMap[log.status] || statusMap.pending;

            const fileBtn = log.attachmentUrl
                ? `<button class="view-btn" onclick="openAttachment('${sanitizeText(log.attachmentUrl)}')">View</button>`
                : '<span style="color:var(--text-muted);font-size:0.78rem;">—</span>';

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

        // Recount total completed hours from approved logs
        const totalApproved = snap.docs.reduce((sum, d) => {
            const log = d.data();
            return log.status === 'approved'
                ? sum + (parseFloat(log.hoursRendered) || 0)
                : sum;
        }, 0);

        // Update progress if userData is loaded
        if (userData) {
            userData.completedHours = totalApproved;
            updateProgressStats(userData);
        }

    }, (err) => {
        console.error('[Dashboard] syncAttendanceLogs error:', err);
    });
}

// ─── FEEDBACK ────────────────────────────────────────────────
function loadFeedback(uid) {
    const q = query(
        collection(db, 'students', uid, 'feedback'),
        orderBy('createdAt', 'desc'),
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
            const author = sanitizeText(fb.adviserName || 'Adviser');
            const msg    = sanitizeText(fb.message || '');
            const time   = formatTimestamp(fb.createdAt);

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

    const firstDay     = new Date(year, month, 1).getDay();
    const daysInMonth  = new Date(year, month + 1, 0).getDate();
    const today        = new Date();

    for (let i = 0; i < firstDay; i++) {
        grid.appendChild(document.createElement('div'));
    }

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
window.openAttachment = function(url) {
    if (url && url.startsWith('https://')) {
        window.open(url, '_blank', 'noopener,noreferrer');
    } else if (url && url.startsWith('data:')) {
        // Legacy base64 handling
        try {
            const parts       = url.split(';base64,');
            const contentType = parts[0].split(':')[1];
            const raw         = window.atob(parts[1]);
            const arr         = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
            const blob   = new Blob([arr], { type: contentType });
            const blobUrl = URL.createObjectURL(blob);
            window.open(blobUrl, '_blank', 'noopener,noreferrer');
        } catch {
            alert('Could not open attachment. Please contact support.');
        }
    }
};

// ─── UTILITY ─────────────────────────────────────────────────
/** Safely sets textContent on an element by ID. */
function setEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}
