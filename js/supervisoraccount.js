import { db, auth } from "../firebase-config.js";
import { protectPage } from "../authguard.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    doc, getDoc, collection, query, where,
    getDocs, updateDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText
} from '../js/theme.js';
import { setupNotificationSystem,
  sendNotification,
  markAllRead,
  clearAllNotifications} from '../js/notifications.js';

initTheme();

let currentSupervisorUid = null;

protectPage('supervisor').then((user) => {
    currentSupervisorUid = user.uid;

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

    loadSupervisorData(user);
    setupTabNavigation(user);
    setupPasswordChange();
});

// ─── SUPERVISOR PROFILE ───────────────────────────────────────
async function loadSupervisorData(user) {
    try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!snap.exists()) return;
        const data = snap.data();

        // ✅ FIX: 'surname' not 'lastName'
        const fullName = data.name
            || `${data.firstName || ''} ${data.surname || ''}`.trim()
            || 'OJT Adviser';

        populateHeaderUser(fullName, user.email);

        setText('user-display-name',     fullName);
        setText('user-display-name-pop', fullName);
        setText('display-name',          fullName);
        setText('display-staff-id',      data.staffId || 'NOT SET');
        setText('display-dept',          data.organization || data.school || 'No School Set');

        const courses   = data.assignedCourses || data.assignedClass || [];
        const formatted = Array.isArray(courses) ? courses.join(', ') : courses;
        setText('display-courses', formatted || 'None Assigned');
        setText('display-contact', data.number || 'NOT SET');

        // Profile tab prefills
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        setVal('profile-fullname',    fullName);
        setVal('profile-email',       user.email);
        setVal('profile-number',      data.number || data.phone || '');
        setVal('profile-school',      data.organization  || data.school || '');
        setVal('profile-courses',     formatted || '');
        setVal('profile-designation', 'OJT Adviser / Coordinator');

        // Avatar initial
        const avatarEl = document.getElementById('adviser-avatar-initial');
        if (avatarEl) avatarEl.textContent = fullName.charAt(0).toUpperCase();

        // Load student count + average progress
        await loadBatchStats(user.uid);

    } catch (e) {
        console.error('[SupAccount] loadSupervisorData:', e);
    }
}

async function loadBatchStats(supervisorUid) {
    try {
        const q    = query(collection(db, "batches"), where("supervisorId", "==", supervisorUid));
        const snap = await getDocs(q);

        let totalStudents = 0;
        const totalBatches = snap.size;

        // Collect all student UIDs across all batches (de-duplicated)
        const studentUids = new Set();
        snap.docs.forEach(batchDoc => {
            const uids = batchDoc.data().studentUids || [];
            uids.forEach(uid => studentUids.add(uid));
            totalStudents = studentUids.size;
        });

        setText('display-student-count', totalStudents);
        setText('display-batch-count',   totalBatches);

        if (studentUids.size === 0) {
            setProgress(0);
            return;
        }

        // ── Step 1: Fetch ALL approved attendance logs for these students ──
        // Schema fields: uid, timeIn, timeOut, status ('approved' lowercase)
        const attSnap = await getDocs(
            query(collection(db, "attendance"))
        );

        // Map: uid → total approved hours
        const approvedHoursMap = {};
        attSnap.docs.forEach(d => {
            const log = d.data();
            if (!studentUids.has(log.uid)) return;
            if ((log.status || '').toLowerCase() !== 'approved') return;

            const hrs = computeHoursDecimal(log.timeIn, log.timeOut);
            approvedHoursMap[log.uid] = (approvedHoursMap[log.uid] || 0) + hrs;
        });

        // ── Step 2: Fetch ALL approved checklist docs for these students ──
        // Schema fields: uid, status ('Approved' capital A)
        const checkSnap = await getDocs(
            query(collection(db, "checklist"))
        );

        // Map: uid → count of approved docs
        const approvedDocsMap = {};
        checkSnap.docs.forEach(d => {
            const item = d.data();
            if (!studentUids.has(item.uid)) return;
            if (item.status !== 'Approved') return;  // checklist uses capital A
            approvedDocsMap[item.uid] = (approvedDocsMap[item.uid] || 0) + 1;
        });

        // ── Step 3: Per-student, fetch requiredHours and compute both % ──
        const TOTAL_DOCS_REQUIRED = 13;
        let totalCombinedPct = 0;
        let counted = 0;

        for (const uid of studentUids) {
            const uSnap = await getDoc(doc(db, "users", uid));
            if (!uSnap.exists()) continue;

            const data        = uSnap.data();
            const requiredHrs = parseFloat(data.requiredHours) || 600;

            // Hours %: based on approved logs (live-computed)
            const completedHrs = approvedHoursMap[uid] || 0;
            const hoursPct     = Math.min(100, (completedHrs / requiredHrs) * 100);

            // Docs %: based on approved checklist items
            const approvedDocs = approvedDocsMap[uid] || 0;
            const docsPct      = Math.min(100, (approvedDocs / TOTAL_DOCS_REQUIRED) * 100);

            // Combined average for this student
            const studentPct = (hoursPct + docsPct) / 2;

            totalCombinedPct += studentPct;
            counted++;
        }

        const avgPct = counted > 0 ? Math.round(totalCombinedPct / counted) : 0;
        setProgress(avgPct);

    } catch (e) {
        console.error('[SupAccount] loadBatchStats:', e);
        setProgress(0);
    }
}

// ─── Helpers ─────────────────────────────────────────────────

function setProgress(pct) {
    const avgFill = document.getElementById('avg-progress-fill');
    const avgText = document.getElementById('avg-progress-text');

    if (avgFill) {
        avgFill.style.width = `${pct}%`;
        // Color-code the bar based on progress level
        if (pct >= 75)      avgFill.style.background = 'var(--success)';
        else if (pct >= 40) avgFill.style.background = 'var(--brand-gold)';
        else                avgFill.style.background = 'var(--danger)';
    }
    if (avgText) avgText.textContent = `${pct}%`;
}

function computeHoursDecimal(timeIn, timeOut) {
    if (!timeIn || !timeOut) return 0;
    const parse = (t) => {
        const [part, mod] = String(t).split(' ');
        let [h, m] = part.split(':').map(Number);
        if (mod === 'PM' && h < 12) h += 12;
        if (mod === 'AM' && h === 12) h = 0;
        return h + (m || 0) / 60;
    };
    const diff = parse(timeOut) - parse(timeIn);
    return diff < 0 ? diff + 24 : diff;
}

// ─── TAB NAVIGATION ──────────────────────────────────────────
function setupTabNavigation(user) {
    const navItems = document.querySelectorAll('.settings-list .nav-item');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');

            const targetId = item.dataset.section;
            document.querySelectorAll('.content-section').forEach(s => s.style.display = 'none');
            const target = document.getElementById(targetId);
            if (target) target.style.display = 'block';

            // Lazy-load content for specific tabs
            if (targetId === 'batch-content')    loadBatchList(user.uid);
            if (targetId === 'students-content') loadAllStudents(user.uid);
        });
    });
}

// ─── BATCH LIST TAB ───────────────────────────────────────────
async function loadBatchList(supervisorUid) {
    const container = document.getElementById('batch-groups-wrapper');
    if (!container) return;

    container.innerHTML = '<p class="empty-text" style="padding:16px;">Loading batches…</p>';

    try {
        const q    = query(collection(db, "batches"), where("supervisorId", "==", supervisorUid));
        const snap = await getDocs(q);

        if (snap.empty) {
            container.innerHTML = `
                <div style="text-align:center; padding:40px; border:2px dashed var(--border); border-radius:var(--radius-md);">
                    <p style="color:var(--text-muted);">No batches found. Create batches in the Batch Management section.</p>
                </div>`;
            return;
        }

        container.innerHTML = '';

        for (const batchDoc of snap.docs) {
            const batch    = batchDoc.data();
            const students = batch.studentUids || [];

            const section = document.createElement('div');
            section.className = 'batch-group';

            const gridId = `grid-${batchDoc.id}`;
            section.innerHTML = `
                <div class="batch-group-header">
                    <span class="batch-group-name">📂 ${sanitizeText(batch.name || 'Batch')}
                        <span style="font-size:0.75rem;color:var(--text-muted);margin-left:6px;">${sanitizeText(batch.year || '')}</span>
                    </span>
                    <span class="batch-meta">${students.length} student${students.length !== 1 ? 's' : ''}</span>
                </div>
                <div id="${gridId}" class="batch-group-students">
                    ${students.length === 0 ? '<p class="empty-text">No students yet.</p>' : ''}
                </div>`;
            container.appendChild(section);

            const grid = document.getElementById(gridId);
            if (grid && students.length > 0) {
                await populateStudentGrid(grid, students);
            }
        }

    } catch (e) {
        console.error('[SupAccount] loadBatchList:', e);
        container.innerHTML = '<p class="empty-text">Could not load batches.</p>';
    }
}

// ─── ALL STUDENTS TAB ─────────────────────────────────────────
async function loadAllStudents(supervisorUid) {
    const grid    = document.getElementById('all-students-grid');
    const search  = document.getElementById('students-search');
    if (!grid) return;

    grid.innerHTML = '<p class="empty-text">Loading students…</p>';

    try {
        const q    = query(collection(db, "batches"), where("supervisorId", "==", supervisorUid));
        const snap = await getDocs(q);

        const allUids = new Set();
        snap.docs.forEach(d => {
            (d.data().studentUids || []).forEach(u => allUids.add(u));
        });

        if (allUids.size === 0) {
            grid.innerHTML = '<p class="empty-text">No students assigned yet.</p>';
            return;
        }

        let students = [];
        for (const uid of allUids) {
            const uSnap = await getDoc(doc(db, "users", uid));
            if (uSnap.exists()) students.push({ uid, ...uSnap.data() });
        }

        const renderStudents = async (list) => {
            if (list.length === 0) {
                grid.innerHTML = '<p class="empty-text">No students match your search.</p>';
                return;
            }
            const cards = await Promise.all(list.map(s => buildStudentCard(s)));
            grid.innerHTML = cards.join('');
        };


        await renderStudents(students);

        search.addEventListener('input', async () => {
            const term = search.value.toLowerCase();

            const filtered = students.filter(s => {
                const name = (s.name || `${s.firstName || ''} ${s.surname || ''}`).toLowerCase();
                const section = (s.fullSection || s.section || '').toLowerCase();
                return name.includes(term) || section.includes(term);
            });

            await renderStudents(filtered);
        });

    } catch (e) {
        console.error('[SupAccount] loadAllStudents:', e);
        grid.innerHTML = '<p class="empty-text">Could not load students.</p>';
    }
}

async function buildStudentCard(student) {
    const name = student.name
        || `${student.firstName || ''} ${student.surname || ''}`.trim()
        || 'Student';

    const section  = sanitizeText(student.fullSection || student.section || '—');
    const course   = sanitizeText(student.course || '—');
    const initial  = name.charAt(0).toUpperCase();
    const required = parseFloat(student.requiredHours) || 600;

    // ── Fetch attendance logs for this student ──
    let completed = 0;

    try {
        const attSnap = await getDocs(
            query(collection(db, "attendance"), where("uid", "==", student.uid))
        );

        attSnap.forEach(doc => {
            const log = doc.data();
            if ((log.status || '').toLowerCase() !== 'approved') return;

            completed += computeHoursDecimal(log.timeIn, log.timeOut);
        });

    } catch (e) {
        console.error("Error loading attendance for student:", student.uid, e);
    }

    const pct = Math.min(100, Math.round((completed / required) * 100));

    return `
      <div class="member-card">
        <div class="member-avatar">${initial}</div>
        <div>
          <p class="m-name">${sanitizeText(name)}</p>
          <p class="m-dept">${course} · ${section}</p>
          <div style="margin-top:5px;">
            <div style="background:var(--bg-elevated);border-radius:4px;height:5px;overflow:hidden;width:100%;">
              <div style="height:100%;background:var(--brand-gold);width:${pct}%;"></div>
            </div>
            <small style="color:var(--text-muted);font-size:0.68rem;">
              ${completed.toFixed(0)}/${required}h (${pct}%)
            </small>
          </div>
        </div>
      </div>`;
}

async function populateStudentGrid(grid, studentUids) {
    grid.innerHTML = '';

    try {
        const cards = await Promise.all(
            studentUids.map(async (uid) => {
                const snap = await getDoc(doc(db, "users", uid));
                if (!snap.exists()) return null;

                const s = snap.data();
                return await buildStudentCard({ uid, ...s });
            })
        );

        grid.innerHTML = cards.filter(Boolean).join('');

    } catch (e) {
        console.error("populateStudentGrid error:", e);
        grid.innerHTML = '<p class="empty-text">Failed to load students.</p>';
    }
}

// ─── PASSWORD CHANGE ──────────────────────────────────────────
function setupPasswordChange() {
    const form = document.getElementById('password-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const { updatePassword } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
        const newPw  = document.getElementById('new-password')?.value || '';
        const confPw = document.getElementById('confirm-password')?.value || '';
        const msgEl  = document.getElementById('pw-change-msg');

        if (newPw.length < 8) {
            if (msgEl) { msgEl.textContent = 'Password must be at least 8 characters.'; msgEl.style.color = 'var(--danger)'; msgEl.style.display = 'block'; }
            return;
        }

        if (newPw !== confPw) {
            if (msgEl) { msgEl.textContent = 'Passwords do not match.'; msgEl.style.color = 'var(--danger)'; msgEl.style.display = 'block'; }
            return;
        }

        try {
            await updatePassword(auth.currentUser, newPw);
            if (msgEl) { msgEl.textContent = 'Password updated successfully!'; msgEl.style.color = 'var(--success)'; msgEl.style.display = 'block'; }
            form.reset();
        } catch (err) {
            if (msgEl) { msgEl.textContent = `Error: ${err.message}`; msgEl.style.color = 'var(--danger)'; msgEl.style.display = 'block'; }
        }
    });
}

// ─── HELPERS ─────────────────────────────────────────────────
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}
