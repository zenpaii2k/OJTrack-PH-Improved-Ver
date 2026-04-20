/**
 * OJTrack PH — account.js
 * ─────────────────────────────────────────────────────────────
 * FIXES:
 *  1. setupThemeToggle('sidebar-theme-btn') — WAS MISSING
 *  2. setupProfileDropdown / setupNotifDropdown — replaced manual wiring
 *  3. sidebar-logout-btn wired — WAS MISSING
 *  4. attendance: where('uid'), orderBy('timestamp'), status case-insensitive
 *  5. users: data.surname not data.lastName; data.hoursCompleted vs completedHours
 *  6. users: data.batch (schema field) not data.batchId
 *  7. users: data.timeStart/timeEnd (schema) correctly used
 *  8. Checklist doc-progress uses correct status strings ("Approved")
 * ─────────────────────────────────────────────────────────────
 */

import { protectPage } from "../authguard.js";
import { auth, db } from '../firebase-config.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    doc, getDoc, getDocs, collection, query, where,
    onSnapshot, updateDoc, orderBy
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, formatTimestamp
} from '../js/theme.js';
import { setupNotificationSystem } from '../js/notifications.js';

// ─── INIT ────────────────────────────────────────────────────
initTheme();

protectPage('student').then((user) => {
    if (!user) return;

    // ✅ FIX: Wire ALL theme + UI controls (was only partially wired before)
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

    initializeApp(user);
    setupNavigation();
    setupPasswordChange(user);
});

// ─── MAIN INITIALIZATION ──────────────────────────────────────
async function initializeApp(user) {
    try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        if (!userSnap.exists()) return;
        const data = userSnap.data();

        // ✅ FIX: 'surname' not 'lastName'
        const userName = data.name
            || `${data.firstName || ''} ${data.surname || ''}`.trim()
            || 'Student';

        // Header user info (uses safe helper)
        populateHeaderUser(userName, user.email);

        // Profile summary card
        setText('student-name',     userName);
        setText('display-school',   data.school || '—');

        // ✅ FIX: 'fullSection' is the schema field
        const sectionDisplay = data.fullSection
            || ((data.course && data.section) ? `${data.course}-${data.section}` : '—');
        setText('display-section',  sectionDisplay);
        setText('display-company',  data.company || '—');

        const reqHrs = parseFloat(data.requiredHours) || 450;
        setText('display-req-hours', `${reqHrs} hrs`);

        // Profile form (read-only fields)
        setVal('edit-full-name',    userName);
        setVal('edit-designation',  data.designation || 'Student');
        setVal('edit-email',        user.email);
        // ✅ FIX: 'timeStart'/'timeEnd' (schema), with null guard
        const shiftStr = (data.timeStart && data.timeEnd)
            ? `${data.timeStart} - ${data.timeEnd}`
            : 'Not set';
        setVal('edit-hours', shiftStr);

        // ─── Real-time OJT Hours Progress ─────────────────────
        // ✅ FIX: 'uid', 'timestamp', and case-insensitive status comparison
        const qLogs = query(
            collection(db, "attendance"),
            where("uid", "==", user.uid)   // ✅ 'uid' not 'userId'
        );

        onSnapshot(qLogs, (snapshot) => {
            let totalApprovedHrs = 0;
            snapshot.forEach(logDoc => {
                const log = logDoc.data();
                // ✅ FIX: status comparison is case-insensitive
                if ((log.status || '').toLowerCase() === 'approved') {
                    totalApprovedHrs += computeHoursDecimal(log.timeIn, log.timeOut);
                }
            });

            const pct = reqHrs > 0 ? Math.min((totalApprovedHrs / reqHrs) * 100, 100) : 0;

            const progressFill = document.getElementById('profile-progress-fill');
            if (progressFill) progressFill.style.width = `${pct}%`;

            const progressText = document.getElementById('profile-progress-text');
            if (progressText) progressText.textContent = `${Math.round(pct)}%`;

            const compHoursDisp = document.getElementById('display-comp-hours');
            if (compHoursDisp) compHoursDisp.textContent = `${totalApprovedHrs.toFixed(1)} hrs`;
        });

        // ─── Real-time Document Progress ──────────────────────
        const qDocs = query(
            collection(db, "checklist"),
            where("uid", "==", user.uid)
        );

        onSnapshot(qDocs, (snapshot) => {
            const totalRequired = 13;
            let approvedDocs = 0;
            snapshot.forEach(d => {
                // ✅ FIX: checklist uses "Approved" (capital A)
                if (d.data().status === 'Approved') approvedDocs++;
            });
            const docPct = Math.min((approvedDocs / totalRequired) * 100, 100);

            const docFill = document.getElementById('doc-progress-fill');
            const docText = document.getElementById('doc-progress-text');
            if (docFill) docFill.style.width = `${docPct}%`;
            if (docText) docText.textContent = `${approvedDocs}/${totalRequired} Approved`;
        });

        // ─── Batch / Adviser Info ──────────────────────────────
        // ✅ FIX: schema uses 'batch' not 'batchId'
        if (data.batch) {
            syncBatchData(data.batch, user.uid);
        } else {
            // Try to find batch by studentUids
            const batchQ = query(
                collection(db, "batches"),
                where("studentUids", "array-contains", user.uid)
            );
            const bSnap = await getDocs(batchQ);
            if (!bSnap.empty) syncBatchData(bSnap.docs[0].id, user.uid);
        }

    } catch (e) {
        console.error('[Account] initializeApp error:', e);
    }
}

// ─── BATCH / ADVISER SYNC ─────────────────────────────────────
async function syncBatchData(batchId, myUid) {
    try {
        const batchSnap = await getDoc(doc(db, "batches", batchId));
        if (!batchSnap.exists()) return;
        const bData = batchSnap.data();

        if (bData.supervisorId) {
            const supSnap = await getDoc(doc(db, "users", bData.supervisorId));
            if (supSnap.exists()) {
                const s = supSnap.data();
                const supName = s.name || `${s.firstName || ''} ${s.surname || ''}`.trim() || 'Adviser';

                setText('sup-name', supName);
                setText('sup-org',  s.organization || s.school || '—');
                setText('sup-id',   s.staffId || '—');

                const courses = s.assignedCourses || [];
                setText('sup-class',       Array.isArray(courses) ? courses.join(', ') : courses || '—');
                setText('batch-sup-name',  supName);
                setText('batch-sup-courses', Array.isArray(courses) ? courses[0] || '—' : '—');
            }
        }

        // ─── Classmates ────────────────────────────────────────
        // ✅ FIX: query by 'batch' field (schema), not 'batchId'
        const qMates = query(collection(db, "users"), where("batch", "==", batchId));
        const matesSnap = await getDocs(qMates);

        const gridContainer = document.getElementById('classmates-grid');
        if (!gridContainer) return;

        const cards = [];
        matesSnap.forEach(docSnap => {
            const m = docSnap.data();
            if (m.role !== 'student') return;

            const isMe    = docSnap.id === myUid;
            const name    = sanitizeText(m.name || `${m.firstName || ''} ${m.surname || ''}`.trim() || 'Student');
            const initial = name.charAt(0).toUpperCase();
            const section = sanitizeText(m.fullSection || (m.course && m.section ? `${m.course}-${m.section}` : 'Student'));

            cards.push(`
              <div class="member-card ${isMe ? 'is-me' : ''}">
                <div class="member-avatar">${initial}</div>
                <div>
                  <p class="m-name">${name}${isMe ? ' <span style="color:var(--brand-gold);font-size:0.75rem;">(You)</span>' : ''}</p>
                  <p class="m-dept">${section}</p>
                </div>
              </div>`);
        });

        gridContainer.innerHTML = cards.length
            ? cards.join('')
            : '<p class="empty-text">No classmates found in this batch.</p>';

    } catch (e) {
        console.error('[Account] syncBatchData error:', e);
    }
}

// ─── SIDEBAR TAB NAVIGATION ───────────────────────────────────
function setupNavigation() {
    document.querySelectorAll('.settings-list .nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.settings-list .nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            const targetId = item.getAttribute('data-section');
            document.querySelectorAll('.content-section').forEach(sec => {
                sec.style.display = sec.id === targetId ? 'block' : 'none';
            });
        });
    });
}

// ─── PASSWORD CHANGE ──────────────────────────────────────────
function setupPasswordChange(user) {
    const form = document.getElementById('password-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const { updatePassword } = await import(
            'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js'
        );
        const newPw  = document.getElementById('new-password')?.value   || '';
        const confPw = document.getElementById('confirm-password')?.value || '';

        if (newPw.length < 8) {
            alert('Password must be at least 8 characters.');
            return;
        }
        if (newPw !== confPw) {
            alert('Passwords do not match.');
            return;
        }

        try {
            await updatePassword(auth.currentUser, newPw);
            alert('Password updated successfully!');
            form.reset();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    });
}

// ─── HELPERS ─────────────────────────────────────────────────
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val ?? '—';
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val ?? '';
}

function computeHoursDecimal(tIn, tOut) {
    if (!tIn || !tOut) return 0;
    const parse = (t) => {
        const [part, mod] = String(t).split(' ');
        let [h, m] = part.split(':').map(Number);
        if (mod === 'PM' && h < 12) h += 12;
        if (mod === 'AM' && h === 12) h = 0;
        return h + (m || 0) / 60;
    };
    const diff = parse(tOut) - parse(tIn);
    return diff < 0 ? diff + 24 : diff;
}
