import { protectPage } from '../authguard.js';
import { db, auth } from '../firebase-config.js';
import { signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, addDoc, query, where, getDocs,
    updateDoc, doc, arrayUnion, arrayRemove,
    getDoc, deleteDoc, orderBy, limit, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText
} from '../js/theme.js';
import {
    setupNotificationSystem, sendNotification, markAllRead,
    clearAllNotifications, notifyReportApproved, notifyReportRejected,
    notifyAdviserFeedback, notifyLogApproved, notifyDocumentRejected
} from '../js/notifications.js';

initTheme();

let allBatchesCache = [];
const nameCache = {};
let state = {
    attendance:    [],
    documents:     [],
    myStudentUids: new Set()
};

let activeBatchId   = null;
let currentMonth    = new Date();
let studentListeners = [];

protectPage('supervisor').then((user) => {
    if (!user) return;

    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);

    setupLogout();
    fetchUserProfile(user);
    loadBatches(user.uid);
});

// ─── LOGOUT ────────────────────────────────────────────────────
function setupLogout() {
    ['logout-link', 'sidebar-logout-btn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', async (e) => {
            e.preventDefault();
            const confirmed = confirm('Do you really want to log out?');
            if (!confirmed) return;
            try {
                await signOut(auth);
                window.location.replace('/index.html');
            } catch (err) {
                console.error('[Logout] Failed:', err);
                alert('Unable to log out. Please try again.');
            }
        });
    });
}

// ─── STATS ─────────────────────────────────────────────────────
async function updateTotalStats(user) {
    try {
        const q    = query(collection(db, 'batches'), where('supervisorId', '==', user.uid));
        const snap = await getDocs(q);
        const uniqueStudents = new Set();
        snap.forEach(d => {
            const data = d.data();
            if (data.studentUids) data.studentUids.forEach(uid => uniqueStudents.add(uid));
        });
        return uniqueStudents;
    } catch { return new Set(); }
}

// ─── PROFILE ───────────────────────────────────────────────────
async function getStudentName(uid) {
    if (nameCache[uid]) return nameCache[uid];
    const userDoc = await getDoc(doc(db, 'users', uid));
    const name = userDoc.exists() ? (userDoc.data().name || 'Student') : 'Unknown';
    nameCache[uid] = name;
    return name;
}

async function fetchUserProfile(user) {
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    if (!userSnap.exists()) return;

    const userData = userSnap.data();
    const fullName = userData.name
        || `${userData.firstName || ''} ${userData.surname || ''}`.trim()
        || 'User';

    document.getElementById('user-display-name').innerText     = fullName;
    document.getElementById('user-display-name-pop').innerText = fullName;
    document.getElementById('user-full-email').innerText       = user.email;

    const avatarEl = document.getElementById('avatar-initial');
    if (avatarEl) avatarEl.textContent = fullName.charAt(0).toUpperCase();

    populateHeaderUser(fullName, user.email);
}

// ─── HELPERS ───────────────────────────────────────────────────
function computeHoursDecimal(tIn, tOut) {
    if (!tIn || !tOut) return 0;
    const parse = (t) => {
        const [time, mod] = String(t).split(' ');
        let [h, m] = time.split(':').map(Number);
        if (mod === 'PM' && h < 12) h += 12;
        if (mod === 'AM' && h === 12) h = 0;
        return h + (m || 0) / 60;
    };
    const diff = parse(tOut) - parse(tIn);
    return diff < 0 ? diff + 24 : diff;
}

function normalizeStatus(status) {
    const s = (status || '').toString().trim().toLowerCase();
    if (s === 'approved' || s === 'approve') return 'Approved';
    if (s === 'rejected' || s === 'declined' || s === 'denied') return 'Rejected';
    return 'Pending';
}

async function getStudentProgress(uid) {
    try {
        const userSnap = await getDoc(doc(db, 'users', uid));
        if (!userSnap.exists()) return { progress: 0, hours: 0 };

        const data = userSnap.data();
        const requiredHours    = parseFloat(data.requiredHours) || 600;
        const TOTAL_DOCS_REQUIRED = 13;

        const attSnap = await getDocs(query(collection(db, 'attendance'), where('uid', '==', uid)));
        let completedHours = 0;
        attSnap.forEach(d => {
            const log = d.data();
            if (normalizeStatus(log.status) === 'Approved') {
                completedHours += computeHoursDecimal(log.timeIn, log.timeOut);
            }
        });

        const docSnap = await getDocs(query(collection(db, 'checklist'), where('uid', '==', uid)));
        let approvedDocs = 0;
        docSnap.forEach(d => {
            if (normalizeStatus(d.data().status) === 'Approved') approvedDocs++;
        });

        const hoursPct = Math.min(100, (completedHours / requiredHours) * 100);
        const docsPct  = Math.min(100, (approvedDocs / TOTAL_DOCS_REQUIRED) * 100);

        return {
            progress: Math.round((hoursPct + docsPct) / 2),
            hours:    completedHours
        };
    } catch (err) {
        console.error('[Progress] Calculation failed:', err);
        return { progress: 0, hours: 0 };
    }
}

// ─── BATCH STATS ───────────────────────────────────────────────
async function updateBatchStats(supervisorId) {
    const totalEl   = document.getElementById('bstat-total');
    const studentEl = document.getElementById('bstat-students');
    const activeEl  = document.getElementById('bstat-active');

    const q    = query(collection(db, 'batches'), where('supervisorId', '==', supervisorId));
    const snap = await getDocs(q);

    let totalBatches   = 0;
    let totalStudentsSet = new Set();
    let activeBatches  = 0;

    for (const batchDoc of snap.docs) {
        totalBatches++;
        const data     = batchDoc.data();
        const students = data.studentUids || [];

        let cleanedStudents = [];
        for (const uid of students) {
            const valid = await isStudentValid(uid);
            if (valid) {
                totalStudentsSet.add(uid);
                cleanedStudents.push(uid);
            }
        }

        if (cleanedStudents.length !== students.length) {
            await updateDoc(doc(db, 'batches', batchDoc.id), {
                studentUids: cleanedStudents
            });
        }

        if (cleanedStudents.length > 0) activeBatches++;
    }

    if (totalEl)   totalEl.textContent   = totalBatches;
    if (studentEl) studentEl.textContent = totalStudentsSet.size;
    if (activeEl)  activeEl.textContent  = activeBatches;
}

// ─── DOM SETUP ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const openModalBtn    = document.getElementById('openModalBtn');
    const createBatchForm = document.getElementById('createBatchForm');

    if (openModalBtn)    openModalBtn.onclick    = () => { document.getElementById('createBatchModal').style.display = 'flex'; };
    if (createBatchForm) createBatchForm.onsubmit = createNewBatch;

    document.getElementById('batch-search')?.addEventListener('input', (e) => {
        filterBatches(e.target.value.toLowerCase().trim());
    });

    document.getElementById('close-create-modal')?.addEventListener('click', () => closeModalById('createBatchModal'));
    document.getElementById('cancel-create-btn')?.addEventListener('click',  () => closeModalById('createBatchModal'));
    document.getElementById('close-student-modal')?.addEventListener('click', () => closeModalById('studentListModal'));

    ['createBatchModal', 'studentListModal'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', (e) => {
            if (e.target === document.getElementById(id)) document.getElementById(id).style.display = 'none';
        });
    });

    document.getElementById('generateInviteBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        if (!activeBatchId) { alert('No batch selected.'); return; }
        window.generateInviteLink(activeBatchId);
    });
});

// ─── BATCH CRUD ─────────────────────────────────────────────────
async function createNewBatch(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');

    try {
        btn.disabled  = true;
        btn.innerText = 'Creating...';

        await addDoc(collection(db, 'batches'), {
            name:        document.getElementById('batchName').value,
            year:        document.getElementById('academicYear').value,
            supervisorId: auth.currentUser.uid,
            studentUids:  [],
            createdAt:    serverTimestamp()
        });

        closeModal();
        loadBatches(auth.currentUser.uid);
    } catch (error) {
        console.error('[Batch] Create error:', error);
        alert('Failed to create batch.');
    } finally {
        btn.disabled  = false;
        btn.innerText = 'Create Batch';
    }
}

async function loadBatches(uid) {
    const container = document.getElementById('batchContainer');
    if (!container) return;

    const q        = query(collection(db, 'batches'), where('supervisorId', '==', uid));
    const snapshot = await getDocs(q);

    await updateBatchStats(uid);

    allBatchesCache = [];
    container.innerHTML = '';

    if (snapshot.empty) {
        container.innerHTML = '<div class="empty-state">No batches created yet.</div>';
        return;
    }

    snapshot.forEach((batchDoc) => {
        const data = batchDoc.data();
        allBatchesCache.push({ id: batchDoc.id, ...data });
        renderBatchCard(batchDoc.id, data);
    });
}

function renderBatchCard(batchId, data) {
    const container = document.getElementById('batchContainer');
    const card      = document.createElement('div');
    card.className  = 'batch-card';
    card.innerHTML  = `
        <div class="batch-info">
            <strong>${sanitizeText(data.name)}</strong>
            <p>${sanitizeText(data.year || '')}</p>
            <small>${(data.studentUids || []).filter(uid => uid).length} Students Assigned</small>
        </div>
        <div class="batch-card-actions">
            <button class="btn btn-primary" onclick="openStudentModal('${batchId}', '${sanitizeText(data.name)}')">
                👥 Manage
            </button>
            <button class="btn btn-danger"  onclick="deleteBatch('${batchId}', '${sanitizeText(data.name)}')">
                🗑 Delete
            </button>
        </div>`;
    container.appendChild(card);
}

function filterBatches(keyword) {
    const container = document.getElementById('batchContainer');
    container.innerHTML = '';

    const source = keyword
        ? allBatchesCache.filter(b =>
            b.name?.toLowerCase().includes(keyword) ||
            b.year?.toLowerCase().includes(keyword))
        : allBatchesCache;

    if (source.length === 0) {
        container.innerHTML = '<div class="empty-state">No matching batches found.</div>';
        return;
    }

    source.forEach(b => renderBatchCard(b.id, b));
}

window.deleteBatch = async function (batchId, batchName) {
    const proceed = confirm(
        `Are you sure you want to delete the batch "${batchName}"?\n\n` +
        `This will NOT delete the students' accounts, only this specific grouping.`
    );
    if (!proceed) return;

    try {
        await deleteDoc(doc(db, 'batches', batchId));
        alert('Batch deleted successfully.');
        if (auth.currentUser) loadBatches(auth.currentUser.uid);
    } catch (error) {
        console.error('[Batch] Delete error:', error);
        alert('Error: Could not delete batch. Check your Firebase permissions.');
    }
};

// ─── GENERATE INVITE LINK ──────────────────────────────────────
window.generateInviteLink = async function (batchIdOverride) {
    const batchId = batchIdOverride || activeBatchId;
    if (!batchId) { alert('No batch selected. Please open a batch first.'); return; }

    const emailInput = document.getElementById('studentEmailSearch');
    const email      = (emailInput?.value || '').trim().toLowerCase();
    if (!email) { alert("Please enter the student's email."); return; }

    try {
        // This addDoc requires the Firestore rule:
        //   allow create: if isAuth()
        //     && request.resource.data.supervisorId == request.auth.uid
        //     && request.resource.data.status == "pending"
        // Both conditions are satisfied by the payload below.
        const inviteRef = await addDoc(collection(db, 'invitations'), {
            email,
            batchId,
            supervisorId: auth.currentUser.uid,
            status:       'pending',
            createdAt:    serverTimestamp(),
            usedBy:       null,
            usedAt:       null
        });

        const inviteLink = `${window.location.origin}/all-pov/register.html?inviteId=${inviteRef.id}`;

        const output = document.getElementById('invite-link-output');
        const field  = document.getElementById('invite-link-field');
        if (output && field) {
            field.value        = inviteLink;
            output.style.display = 'flex';
        }

        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(inviteLink);
            } else {
                fallbackCopy(inviteLink);
            }
        } catch {
            fallbackCopy(inviteLink);
        }

        alert('Invite link generated & copied!');
        if (emailInput) emailInput.value = '';

    } catch (err) {
        console.error('[Invite] Generate error:', err);
        alert('Failed to generate invite link.');
    }
};

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* silent */ }
    document.body.removeChild(ta);
}

window.closeModal = function () {
    document.getElementById('createBatchModal').style.display = 'none';
    document.getElementById('createBatchForm').reset();
};

function clearStudentListeners() {
    studentListeners.forEach(unsub => unsub());
    studentListeners = [];
}

window.openStudentModal = function (batchId, batchName) {
    clearStudentListeners();
    activeBatchId = batchId;

    const emailInput = document.getElementById('studentEmailSearch');
    if (emailInput) emailInput.value = '';

    const output = document.getElementById('invite-link-output');
    if (output) output.style.display = 'none';

    document.getElementById('currentBatchTitle').innerText = `Manage: ${sanitizeText(batchName)}`;
    document.getElementById('studentListModal').style.display = 'flex';

    viewStudentList(batchId);
};

window.closeStudentModal = function () {
    document.getElementById('studentListModal').style.display = 'none';
    clearStudentListeners();
};

// ─── STUDENT LIST ──────────────────────────────────────────────
async function viewStudentList(batchId) {
    const listBody = document.getElementById('batchStudentList');
    listBody.innerHTML = "<tr><td colspan='6'>Loading students...</td></tr>";

    clearStudentListeners();

    const batchSnap = await getDoc(doc(db, 'batches', batchId));
    const data      = batchSnap.data();
    let uids        = data?.studentUids || [];

    uids = await cleanInvalidStudents(batchId, uids);

    if (uids.length === 0) {
        listBody.innerHTML = "<tr><td colspan='6'>No students assigned.</td></tr>";
        return;
    }

    listBody.innerHTML = '';

    for (const uid of uids) {
        const row      = document.createElement('tr');
        row.innerHTML  = `<td colspan="6">Loading...</td>`;
        listBody.appendChild(row);

        const userRef = doc(db, 'users', uid);

        const unsubUser = onSnapshot(userRef, (userSnap) => {
            if (!userSnap.exists()) return;

            const userData = userSnap.data();
            let latestAttSnap = null;
            let latestDocSnap = null;

            const processData = () => {
                if (!latestAttSnap || !latestDocSnap) return;

                let completedHours = 0;
                let approvedDocs   = 0;
                const requiredHours     = parseFloat(userData.requiredHours) || 600;
                const TOTAL_DOCS_REQUIRED = 13;

                latestAttSnap.forEach(d => {
                    const log = d.data();
                    if (normalizeStatus(log.status) === 'Approved') {
                        completedHours += computeHoursDecimal(log.timeIn, log.timeOut);
                    }
                });

                latestDocSnap.forEach(d => {
                    if (normalizeStatus(d.data().status) === 'Approved') approvedDocs++;
                });

                const hoursPct = Math.min(100, (completedHours / requiredHours) * 100);
                const docsPct  = Math.min(100, (approvedDocs / TOTAL_DOCS_REQUIRED) * 100);
                const progress = Math.round((hoursPct + docsPct) / 2);

                if (!document.body.contains(row)) return;

                row.innerHTML = `
                    <td><strong>${sanitizeText(userData.firstName || '')} ${sanitizeText(userData.surname || '')}</strong></td>
                    <td>${sanitizeText(userData.course   || '–')}</td>
                    <td>${sanitizeText(userData.section  || '–')}</td>
                    <td>${completedHours.toFixed(1)} hrs</td>
                    <td>
                        <div style="width:100px;background:var(--bg-elevated);border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);">
                            <div style="width:${progress}%;background:var(--brand-gold);height:8px;"></div>
                        </div>
                        <small>${progress}% Complete</small>
                    </td>
                    <td>
                        <button onclick="removeStudent('${uid}')" class="btn-delete-small">Remove</button>
                    </td>`;
            };

            const attQuery = query(collection(db, 'attendance'), where('uid', '==', uid));
            const docQuery = query(collection(db, 'checklist'),  where('uid', '==', uid));

            const unsubAtt = onSnapshot(attQuery, (snap) => { latestAttSnap = snap; processData(); });
            const unsubDoc = onSnapshot(docQuery, (snap) => { latestDocSnap = snap; processData(); });

            studentListeners.push(unsubAtt, unsubDoc);
        });

        studentListeners.push(unsubUser);
    }
}

function closeModalById(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

async function isStudentValid(uid) {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists();
}

async function cleanInvalidStudents(batchId, studentUids) {
    const results   = await Promise.all(studentUids.map(uid => getDoc(doc(db, 'users', uid))));
    const validUids = studentUids.filter((_, i) => results[i].exists());

    if (validUids.length !== studentUids.length) {
        await updateDoc(doc(db, 'batches', batchId), { studentUids: validUids });
        console.log(`[Batch] Cleaned invalid students in ${batchId}`);
    }

    return validUids;
}

// ─── REMOVE STUDENT ────────────────────────────────────────────
window.removeStudent = async function (uid) {
    if (!activeBatchId) { alert('No active batch selected.'); return; }

    const confirmRemove = confirm('Remove this student from the batch?');
    if (!confirmRemove) return;

    try {
        const batchRef = doc(db, 'batches', activeBatchId);
        const userRef  = doc(db, 'users',   uid);

        // Step 1 — Remove from batch array
        await updateDoc(batchRef, {
            studentUids: arrayRemove(uid)
        });

        // Step 2 — Clear student's batch reference
        //
        // BUG #4 FIX:
        // ORIGINAL: used empty strings { batch: "", supervisorId: "" }
        //   - Empty string is falsy in JS, but Firestore treats it as a
        //     defined value, not a missing field. Any check like
        //     `if (userData.batch)` evaluates to false for both null and "".
        //     However, Firestore queries like `where("batch", "==", null)`
        //     will NOT match documents with batch = "" — they are different
        //     values. This causes stale data in batch queries.
        //   - The Firestore rule also did not allow advisers to update
        //     student documents at all (only isSelf() was allowed), so
        //     this updateDoc was always denied silently. The student's
        //     batch and supervisorId fields were never cleared.
        //
        // FIX:
        //   1. Use null (not "") so Firestore null-queries work correctly.
        //   2. The Firestore rule now includes:
        //        allow update: if isAdviser()
        //          && request.resource.data.diff(resource.data)
        //              .affectedKeys().hasOnly(['batch','supervisorId','updatedAt']);
        //      which allows exactly this write and nothing else.
        await updateDoc(userRef, {
            batch:        null,
            supervisorId: null,
            updatedAt:    serverTimestamp()
        });

        alert('Student removed successfully.');

        viewStudentList(activeBatchId);
        if (auth.currentUser) loadBatches(auth.currentUser.uid);

    } catch (err) {
        console.error('[removeStudent] Error:', err);
        alert('Failed to remove student. Check your connection and try again.');
    }
};

async function removeStudentFromAllBatches(uid) {
    const q    = query(collection(db, 'batches'), where('studentUids', 'array-contains', uid));
    const snap = await getDocs(q);

    const updates = snap.docs.map(d =>
        updateDoc(doc(db, 'batches', d.id), { studentUids: arrayRemove(uid) })
    );

    await Promise.all(updates);
}
