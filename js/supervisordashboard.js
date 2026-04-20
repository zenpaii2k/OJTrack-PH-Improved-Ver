/**
 * OJTrack PH — supervisordashboard.js
 * ─────────────────────────────────────────────────────────────
 * FIXES:
 *  1. setupThemeToggle for BOTH buttons — WAS MISSING
 *  2. setupProfileDropdown / setupNotifDropdown — WAS MISSING
 *  3. sidebar-logout-btn wired — WAS MISSING
 *  4. Batch progress list populated (batch-progress-list element)
 *  5. attendance query uses correct fields: uid, timestamp
 *  6. getStudentName uses correct field: surname not lastName
 * ─────────────────────────────────────────────────────────────
 */

import { auth, db } from "../firebase-config.js";
import { protectPage } from "../authguard.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection, query, where, getDocs, limit, orderBy,
    onSnapshot, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, formatTimestamp
} from '../js/theme.js';
import { setupNotificationSystem } from '../js/notifications.js';

initTheme();

const nameCache = {};
let state = {
    attendance: [],
    documents:  [],
    myStudentUids: new Set()
};
let currentMonth = new Date();

// ─── AUTH ────────────────────────────────────────────────────
protectPage('supervisor').then((user) => {
    if (!user) return;

    // ✅ FIX: Wire ALL theme + UI controls
    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);

    // ✅ FIX: Wire both logout buttons
    ['logout-link', 'sidebar-logout-btn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', () =>
            signOut(auth).then(() => window.location.replace('/index.html'))
        );
    });

    fetchUserProfile(user);
    renderCalendar(currentMonth);
    setupCalendarNav();
    initDashboard(user);
});

// ─── USER PROFILE ────────────────────────────────────────────
async function fetchUserProfile(user) {
    try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!snap.exists()) return;
        const data = snap.data();
        const name = data.name
            || `${data.firstName || ''} ${data.surname || ''}`.trim()
            || 'Adviser';
        populateHeaderUser(name, user.email);

        // Greeting
        const h    = new Date().getHours();
        const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
        const greetEl = document.getElementById('greeting-text');
        if (greetEl) greetEl.textContent = `${greet}, ${data.firstName || name}!`;
        const subEl = document.getElementById('greeting-sub');
        if (subEl) subEl.textContent = "Here's your students' overview.";
    } catch (e) {
        console.error('[SupDash] fetchUserProfile:', e);
    }
}

// ─── MAIN DASHBOARD ──────────────────────────────────────────
async function initDashboard(user) {
    try {
        const uids = await updateTotalStats(user);
        state.myStudentUids = uids;

        // Real-time attendance listener
        // ✅ FIX: orderBy 'timestamp' (schema field)
        const attendanceQ = query(
            collection(db, "attendance"),
            orderBy("timestamp", "desc"),
            limit(50)
        );

        onSnapshot(attendanceQ, (snapshot) => {
            state.attendance = snapshot.docs.map(d => ({
                id: d.id, ...d.data(), type: "attendance"
            }));
            renderRecentSubmissionsTable();
        });

        // Real-time checklist listener
        const checklistQ = query(
            collection(db, "checklist"),
            orderBy("timestamp", "desc"),
            limit(50)
        );

        onSnapshot(checklistQ, (snapshot) => {
            state.documents = snapshot.docs.map(d => ({
                id: d.id, ...d.data(), type: "document"
            }));
            renderRecentSubmissionsTable();
        });

        // ✅ NEW: Populate batch progress list
        renderBatchProgress(user.uid);

    } catch (e) {
        console.error('[SupDash] initDashboard:', e);
    }
}

// ─── STATS CARDS ─────────────────────────────────────────────
async function updateTotalStats(user) {
    try {
        const batchQ    = query(collection(db, "batches"), where("supervisorId", "==", user.uid));
        const batchSnap = await getDocs(batchQ);

        const uniqueStudents = new Set();
        batchSnap.forEach(d => {
            const data = d.data();
            if (Array.isArray(data.studentUids)) data.studentUids.forEach(u => uniqueStudents.add(u));
        });

        let pendingReports = 0;
        let pendingLogs    = 0;

        if (uniqueStudents.size > 0) {
            const checkSnap = await getDocs(collection(db, "checklist"));
            checkSnap.forEach(d => {
                const data = d.data();
                if (uniqueStudents.has(data.uid) &&
                    (data.status === "Pending" || data.status === "Pending Approval")) {
                    pendingReports++;
                }
            });

            // ✅ FIX: attendance uses 'uid' not 'userId'
            const logSnap = await getDocs(collection(db, "attendance"));
            logSnap.forEach(d => {
                const data = d.data();
                if (uniqueStudents.has(data.uid) &&
                    (data.status === "pending" || !data.status)) {
                    pendingLogs++;
                }
            });
        }

        setText('stat-total-students',  uniqueStudents.size);
        setText('stat-total-batches',   batchSnap.size);
        setText('stat-pending-reports', pendingReports);
        setText('stat-pending-logs',    pendingLogs);

        return uniqueStudents;
    } catch (e) {
        console.error('[SupDash] updateTotalStats:', e);
        return new Set();
    }
}

// ─── BATCH PROGRESS LIST ──────────────────────────────────────
// ✅ NEW: Populates the batch-progress-list element in supervisordashboard.html
async function renderBatchProgress(supervisorUid) {
    const container = document.getElementById('batch-progress-list');
    if (!container) return;

    try {
        const q    = query(collection(db, "batches"), where("supervisorId", "==", supervisorUid));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = '<p class="empty-text">No batches created yet.</p>';
            return;
        }

        container.innerHTML = '';

        for (const batchDoc of snap.docs) {
            const batch    = batchDoc.data();
            const students = Array.isArray(batch.studentUids) ? batch.studentUids : [];
            if (students.length === 0) continue;

            // Calculate average completion for this batch
            let totalPct = 0;
            let counted  = 0;

            for (const uid of students) {
                const uSnap = await getDoc(doc(db, "users", uid));
                if (uSnap.exists()) {
                    const uData    = uSnap.data();
                    const required = parseFloat(uData.requiredHours) || 600;
                    const completed = parseFloat(uData.hoursCompleted) || 0;
                    totalPct += required > 0 ? Math.min(100, (completed / required) * 100) : 0;
                    counted++;
                }
            }

            const avgPct = counted > 0 ? Math.round(totalPct / counted) : 0;

            const row = document.createElement('div');
            row.className = 'batch-progress-row';
            row.innerHTML = `
                <div class="batch-name">${sanitizeText(batch.name || 'Batch')}</div>
                <div class="batch-meta">${students.length} student${students.length !== 1 ? 's' : ''}</div>
                <div class="batch-bar-wrap">
                    <div class="batch-bar-fill" style="width:${avgPct}%"></div>
                </div>
                <div class="batch-pct">${avgPct}%</div>`;
            container.appendChild(row);
        }

    } catch (e) {
        console.error('[SupDash] renderBatchProgress:', e);
        container.innerHTML = '<p class="empty-text">Could not load batch data.</p>';
    }
}

// ─── RECENT SUBMISSIONS TABLE ─────────────────────────────────
async function renderRecentSubmissionsTable() {
    const tbody = document.getElementById('recent-submissions-body');
    if (!tbody) return;

    const items = [...state.attendance, ...state.documents]
        // ✅ FIX: attendance uses 'uid' field
        .filter(item => state.myStudentUids.has(item.uid))
        .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0))
        .slice(0, 8);

    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">No recent student activity.</td></tr>`;
        return;
    }

    const rows = await Promise.all(items.map(async (item) => {
        const name = await getStudentName(item.uid);
        const isLog = item.type === 'attendance';

        const batch = await getStudentBatch(item.uid);
        const hours = isLog
            ? computeHoursDisplay(item.timeIn, item.timeOut)
            : '—';

        const pct = await getStudentProgress(item.uid);

        const statusBadge = isLog
            ? `<span class="badge badge-success">Logged ${item.timeIn || '—'}</span>`
            : `<span class="badge badge-info">Uploaded ${sanitizeText((item.formKey || '').toUpperCase())}</span>`;

        const link     = isLog ? "checkstudentdatabase.html" : "checkstudentreq.html";
        const linkText = isLog ? "Review Logs" : "Review Docs";

        return `<tr>
            <td style="font-weight:600;">${sanitizeText(name)}</td>
            <td>${sanitizeText(batch)}</td>
            <td>${hours}</td>
            <td>
                <div class="progress-bar-track" style="height:6px;min-width:80px;">
                    <div class="progress-bar-fill" style="width:${pct}%"></div>
                </div>
                <small style="color:var(--text-muted);font-size:0.72rem;">${pct}%</small>
            </td>
            <td>${statusBadge}</td>
            <td><a href="${link}" style="color:var(--brand-gold);font-weight:600;text-decoration:none;">${linkText}</a></td>
        </tr>`;
    }));

    tbody.innerHTML = rows.join('');
}

async function getStudentBatch(uid) {
    try {
        const q    = query(collection(db, "batches"), where("studentUids", "array-contains", uid));
        const snap = await getDocs(q);
        if (snap.empty) return '—';
        return sanitizeText(snap.docs[0].data().name || '—');
    } catch { return '—'; }
}

async function getStudentProgress(uid) {
    try {
        const snap = await getDoc(doc(db, "users", uid));
        if (!snap.exists()) return 0;
        const d = snap.data();
        const req = parseFloat(d.requiredHours)  || 600;
        const com = parseFloat(d.hoursCompleted) || 0;
        return Math.min(100, Math.round((com / req) * 100));
    } catch { return 0; }
}

async function getStudentName(uid) {
    if (nameCache[uid]) return nameCache[uid];
    try {
        const snap = await getDoc(doc(db, "users", uid));
        let name = "Unknown Student";
        if (snap.exists()) {
            const d = snap.data();
            // ✅ FIX: schema uses 'surname' not 'lastName'
            name = d.name || `${d.firstName || ''} ${d.surname || ''}`.trim() || "Student";
        }
        nameCache[uid] = name;
        return name;
    } catch { return "Unknown Student"; }
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
        const b = document.createElement('b'); b.textContent = d; grid.appendChild(b);
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

// ─── HELPERS ─────────────────────────────────────────────────
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function computeHoursDecimal(tIn, tOut) {
    if (!tIn || !tOut) return 0;
    const parse = (t) => {
        const [part, mod] = String(t).split(' ');
        let [h, m] = part.split(':').map(Number);
        if (mod === 'PM' && h < 12) h += 12;
        if (mod === 'AM' && h === 12) h = 0;
        return h + m / 60;
    };
    const diff = parse(tOut) - parse(tIn);
    return diff < 0 ? diff + 24 : diff;
}

function computeHoursDisplay(tIn, tOut) {
    const h = computeHoursDecimal(tIn, tOut);
    return h > 0 ? `${h.toFixed(1)}h` : '—';
}
