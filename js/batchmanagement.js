import { protectPage } from "../authguard.js";
import { db, auth } from "../firebase-config.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection, addDoc, query, where, getDocs,
    updateDoc, doc, arrayUnion, arrayRemove, getDoc,
    deleteDoc, orderBy, limit, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    initTheme,
    setupThemeToggle,
    setupProfileDropdown,
    setupNotifDropdown,
    populateHeaderUser,
    sanitizeText
} from '../js/theme.js';
import {
    setupNotificationSystem,
    sendNotification,
    markAllRead,
    clearAllNotifications,
    notifyReportApproved,
    notifyReportRejected,
    notifyAdviserFeedback,
    notifyLogApproved,
    notifyDocumentRejected
} from '../js/notifications.js';

initTheme();

let allBatchesCache  = [];
const nameCache      = {};
let state = {
    attendance:    [],
    documents:     [],
    myStudentUids: new Set()
};
let activeBatchId    = null;
let currentMonth     = new Date();
let studentListeners = [];

// ─── AUTH & INIT ──────────────────────────────────────────────
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

function setupLogout() {
    ['logout-link', 'sidebar-logout-btn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', async (e) => {
            e.preventDefault();
            const confirmed = confirm("Do you really want to log out?");
            if (!confirmed) return;
            try {
                await signOut(auth);
                window.location.replace('/index.html');
            } catch (err) {
                console.error("Logout failed:", err);
                alert("Unable to log out. Please try again.");
            }
        });
    });
}

// ─── USER PROFILE ─────────────────────────────────────────────
async function fetchUserProfile(user) {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (!userSnap.exists()) return;
    const userData = userSnap.data();
    const fullName = userData.name
        || `${userData.firstName || ''} ${userData.surname || ''}`.trim()
        || "User";

    document.getElementById('user-display-name').innerText     = fullName;
    document.getElementById('user-display-name-pop').innerText = fullName;
    document.getElementById('user-full-email').innerText       = user.email;

    const avatarEl = document.getElementById('avatar-initial');
    if (avatarEl) avatarEl.textContent = fullName.charAt(0).toUpperCase();

    populateHeaderUser(fullName, user.email);
}

async function getStudentName(uid) {
    if (nameCache[uid]) return nameCache[uid];
    const snap = await getDoc(doc(db, "users", uid));
    const name = snap.exists() ? (snap.data().name || "Student") : "Unknown";
    nameCache[uid] = name;
    return name;
}

// ─── PROGRESS HELPERS ─────────────────────────────────────────
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
        const userSnap = await getDoc(doc(db, "users", uid));
        if (!userSnap.exists()) return { progress: 0, hours: 0 };
        const data = userSnap.data();
        const requiredHours     = parseFloat(data.requiredHours) || 600;
        const TOTAL_DOCS_REQUIRED = 13;

        const attSnap = await getDocs(query(collection(db, "attendance"), where("uid", "==", uid)));
        let completedHours = 0;
        attSnap.forEach(d => {
            const log = d.data();
            if (normalizeStatus(log.status) === 'Approved')
                completedHours += computeHoursDecimal(log.timeIn, log.timeOut);
        });

        const docSnap = await getDocs(query(collection(db, "checklist"), where("uid", "==", uid)));
        let approvedDocs = 0;
        docSnap.forEach(d => { if (normalizeStatus(d.data().status) === 'Approved') approvedDocs++; });

        const hoursPct = Math.min(100, (completedHours / requiredHours) * 100);
        const docsPct  = Math.min(100, (approvedDocs / TOTAL_DOCS_REQUIRED) * 100);

        return {
            progress: Math.round((hoursPct + docsPct) / 2),
            hours:    completedHours
        };
    } catch (err) {
        console.error("Progress calculation failed:", err);
        return { progress: 0, hours: 0 };
    }
}

// ─── BATCH STATS ──────────────────────────────────────────────
async function updateBatchStats(supervisorId) {
    const totalEl   = document.getElementById("bstat-total");
    const studentEl = document.getElementById("bstat-students");
    const activeEl  = document.getElementById("bstat-active");

    const q    = query(collection(db, "batches"), where("supervisorId", "==", supervisorId));
    const snap = await getDocs(q);

    let totalBatches    = 0;
    let totalStudentsSet = new Set();
    let activeBatches   = 0;

    for (const batchDoc of snap.docs) {
        totalBatches++;
        const data     = batchDoc.data();
        const students = data.studentUids || [];

        let cleanedStudents = [];
        for (const uid of students) {
            if (await isStudentValid(uid)) {
                totalStudentsSet.add(uid);
                cleanedStudents.push(uid);
            }
        }

        if (cleanedStudents.length !== students.length) {
            await updateDoc(doc(db, "batches", batchDoc.id), {
                studentUids: cleanedStudents
            });
        }

        if (cleanedStudents.length > 0) activeBatches++;
    }

    if (totalEl)   totalEl.textContent   = totalBatches;
    if (studentEl) studentEl.textContent = totalStudentsSet.size;
    if (activeEl)  activeEl.textContent  = activeBatches;
}

// ─── DOM READY ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const openModalBtn   = document.getElementById('openModalBtn');
    const createBatchForm = document.getElementById('createBatchForm');

    if (openModalBtn)    openModalBtn.onclick = () => {
        document.getElementById('createBatchModal').style.display = 'flex';
    };

    if (createBatchForm) createBatchForm.onsubmit = createNewBatch;

    const searchInput = document.getElementById("batch-search");
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            filterBatches(e.target.value.toLowerCase().trim());
        });
    }

    document.getElementById("close-create-modal")?.addEventListener("click", () =>
        closeModalById("createBatchModal")
    );
    document.getElementById("cancel-create-btn")?.addEventListener("click", () =>
        closeModalById("createBatchModal")
    );
    document.getElementById("close-student-modal")?.addEventListener("click", () =>
        closeModalById("studentListModal")
    );

    ["createBatchModal", "studentListModal"].forEach(id => {
        const modal = document.getElementById(id);
        modal?.addEventListener("click", (e) => {
            if (e.target === modal) modal.style.display = "none";
        });
    });

    document.getElementById("generateInviteBtn")?.addEventListener("click", (e) => {
        e.preventDefault();
        if (!activeBatchId) { alert("No batch selected."); return; }
        window.generateInviteLink(activeBatchId);
    });

    document.getElementById("copy-invite-btn")?.addEventListener("click", () => {
        const field = document.getElementById("invite-link-field");
        if (!field?.value) return;
        try {
            navigator.clipboard.writeText(field.value).catch(() => fallbackCopy(field.value));
        } catch {
            fallbackCopy(field.value);
        }
    });
});

// ─── CREATE BATCH ─────────────────────────────────────────────
async function createNewBatch(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');

    try {
        btn.disabled  = true;
        btn.innerText = "Creating...";

        await addDoc(collection(db, "batches"), {
            name:        document.getElementById('batchName').value.trim(),
            year:        document.getElementById('academicYear').value.trim(),
            supervisorId: auth.currentUser.uid,
            studentUids: [],
            createdAt:   serverTimestamp()
        });

        closeModal();
        loadBatches(auth.currentUser.uid);

    } catch (error) {
        console.error("Error creating batch:", error);
        alert("Failed to create batch.");
    } finally {
        btn.disabled  = false;
        btn.innerText = "Create Batch";
    }
}

// ─── LOAD & RENDER BATCHES ────────────────────────────────────
async function loadBatches(uid) {
    const container = document.getElementById('batchContainer');
    if (!container) return;

    const q        = query(collection(db, "batches"), where("supervisorId", "==", uid));
    const snapshot = await getDocs(q);

    await updateBatchStats(uid);

    allBatchesCache   = [];
    container.innerHTML = "";

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
            <p>${sanitizeText(data.year)}</p>
            <small>${(data.studentUids || []).filter(u => u).length} Students Assigned</small>
        </div>
        <div class="batch-card-actions">
            <button class="btn btn-primary"
                onclick="openStudentModal('${batchId}', '${sanitizeText(data.name)}')">
                👥 Manage
            </button>
            <button class="btn btn-danger"
                onclick="deleteBatch('${batchId}', '${sanitizeText(data.name)}')">
                🗑 Delete
            </button>
        </div>`;
    container.appendChild(card);
}

function filterBatches(keyword) {
    const container = document.getElementById('batchContainer');
    container.innerHTML = "";
    const list = keyword
        ? allBatchesCache.filter(b =>
              b.name?.toLowerCase().includes(keyword) ||
              b.year?.toLowerCase().includes(keyword)
          )
        : allBatchesCache;

    if (!list.length) {
        container.innerHTML = '<div class="empty-state">No matching batches found.</div>';
        return;
    }
    list.forEach(b => renderBatchCard(b.id, b));
}

// ─── DELETE BATCH ─────────────────────────────────────────────
window.deleteBatch = async function(batchId, batchName) {
    const proceed = confirm(
        `Are you sure you want to delete the batch "${batchName}"?\n\n` +
        `This will NOT delete the students' accounts, only this specific grouping.`
    );
    if (!proceed) return;

    try {
        await deleteDoc(doc(db, "batches", batchId));
        alert("Batch deleted successfully.");
        if (auth.currentUser) loadBatches(auth.currentUser.uid);
    } catch (error) {
        console.error("Error deleting batch:", error);
        alert("Error: Could not delete batch. Check your Firebase permissions.");
    }
};

window.generateInviteLink = async function(batchIdOverride) {
    const batchId = batchIdOverride || activeBatchId;

    if (!batchId) {
        alert("No batch selected. Please open a batch first.");
        return;
    }

    const emailInput = document.getElementById('studentEmailSearch');
    const email      = (emailInput?.value || "").trim().toLowerCase();

    if (!email) {
        alert("Please enter a student's email address.");
        return;
    }

    // Basic email format guard
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        alert("Please enter a valid email address.");
        return;
    }

    try {
        // STEP 1: Revoke all existing pending invites for this email + batch.
        const existingQ = query(
            collection(db, "invitations"),
            where("email",   "==", email),
            where("batchId", "==", batchId),
            where("status",  "==", "pending")
        );
        const existingSnap = await getDocs(existingQ);

        const revokeOps = existingSnap.docs.map(d =>
            updateDoc(d.ref, { status: "revoked" })
        );
        await Promise.all(revokeOps);

        if (existingSnap.size > 0) {
            console.log(`[Invite] Revoked ${existingSnap.size} existing pending invite(s) for ${email}`);
        }

        // STEP 2: Create the new invite document.
        const inviteRef = await addDoc(collection(db, "invitations"), {
            email,
            batchId,
            supervisorId: auth.currentUser.uid,
            status:       "pending",
            createdAt:    serverTimestamp(),
            usedBy:       null,
            usedAt:       null
        });

        const baseUrl    = window.location.origin;
        const inviteLink = `${baseUrl}/all-pov/register.html?inviteId=${inviteRef.id}`;

        // STEP 3: Show the link in the UI.
        const output = document.getElementById("invite-link-output");
        const field  = document.getElementById("invite-link-field");

        if (output && field) {
            field.value          = inviteLink;
            output.style.display = "flex";
        }

        // STEP 4: Copy to clipboard.
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(inviteLink);
            } else {
                fallbackCopy(inviteLink);
            }
        } catch {
            fallbackCopy(inviteLink);
        }

        alert("Invite link generated and copied to clipboard!");
        if (emailInput) emailInput.value = "";

    } catch (err) {
        console.error("[Invite] generateInviteLink error:", err);
        alert("Failed to generate invite link. Please try again.");
    }
};

function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* silent */ }
    document.body.removeChild(ta);
}

// ─── MODAL HELPERS ────────────────────────────────────────────
window.closeModal = function() {
    document.getElementById('createBatchModal').style.display = 'none';
    document.getElementById('createBatchForm').reset();
};

function closeModalById(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
}

function clearStudentListeners() {
    studentListeners.forEach(unsub => unsub());
    studentListeners = [];
}

// ─── STUDENT LIST MODAL ───────────────────────────────────────
window.openStudentModal = function(batchId, batchName) {
    clearStudentListeners();
    activeBatchId = batchId;

    const emailInput = document.getElementById('studentEmailSearch');
    if (emailInput) emailInput.value = "";

    const output = document.getElementById("invite-link-output");
    if (output) output.style.display = "none";

    document.getElementById('currentBatchTitle').innerText =
        `Manage: ${sanitizeText(batchName)}`;
    document.getElementById('studentListModal').style.display = 'flex';

    viewStudentList(batchId);
};

window.closeStudentModal = function() {
    clearStudentListeners();
    document.getElementById('studentListModal').style.display = 'none';
};

async function viewStudentList(batchId) {
    const listBody = document.getElementById('batchStudentList');
    listBody.innerHTML = "<tr><td colspan='6'>Loading students...</td></tr>";

    clearStudentListeners();

    const batchSnap = await getDoc(doc(db, "batches", batchId));
    const data = batchSnap.data();
    let uids = data?.studentUids || [];

    uids = await cleanInvalidStudents(batchId, uids);

    if (uids.length === 0) {
        listBody.innerHTML = "<tr><td colspan='6'>No students assigned.</td></tr>";
        return;
    }

    listBody.innerHTML = "";

    for (const uid of uids) {
        const row       = document.createElement('tr');
        row.innerHTML   = `<td colspan="6">Loading...</td>`;
        listBody.appendChild(row);

        const userRef   = doc(db, "users", uid);
        let latestAttSnap  = null;
        let latestDocSnap  = null;

        const processData = (userData) => {
            if (!latestAttSnap || !latestDocSnap) return;

            let completedHours = 0;
            let approvedDocs   = 0;
            const requiredHours      = parseFloat(userData.requiredHours) || 600;
            const TOTAL_DOCS_REQUIRED = 13;

            latestAttSnap.forEach(d => {
                const log = d.data();
                if (normalizeStatus(log.status) === 'Approved')
                    completedHours += computeHoursDecimal(log.timeIn, log.timeOut);
            });

            latestDocSnap.forEach(d => {
                if (normalizeStatus(d.data().status) === 'Approved') approvedDocs++;
            });

            const hoursPct = Math.min(100, (completedHours / requiredHours) * 100);
            const docsPct  = Math.min(100, (approvedDocs / TOTAL_DOCS_REQUIRED) * 100);
            const progress = Math.round((hoursPct + docsPct) / 2);

            if (!document.body.contains(row)) return;

            row.innerHTML = `
                <td><strong>${sanitizeText(`${userData.firstName || ''} ${userData.surname || ''}`.trim())}</strong></td>
                <td>${sanitizeText(userData.course   || '-')}</td>
                <td>${sanitizeText(userData.section  || '-')}</td>
                <td>${completedHours.toFixed(1)} hrs</td>
                <td>
                    <div style="width:100px;background:var(--bg-elevated);border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);">
                        <div style="width:${progress}%;background:var(--brand-gold);height:8px;"></div>
                    </div>
                    <small>${progress}% Complete</small>
                </td>
                <td class="action-cell">
                    <button onclick="removeStudent('${uid}')" class="btn-delete-small">
                        Remove
                    </button>
                </td>`;
        };

        const unsubUser = onSnapshot(userRef, (userSnap) => {
            if (!userSnap.exists()) return;
            const userData = userSnap.data();

            const attQuery = query(collection(db, "attendance"), where("uid", "==", uid));
            const docQuery = query(collection(db, "checklist"),  where("uid", "==", uid));

            const unsubAtt = onSnapshot(attQuery, (attSnap) => {
                latestAttSnap = attSnap;
                processData(userData);
            });
            const unsubDoc = onSnapshot(docQuery, (docSnap) => {
                latestDocSnap = docSnap;
                processData(userData);
            });

            studentListeners.push(unsubAtt, unsubDoc);
        });

        studentListeners.push(unsubUser);
    }
}

// ─── VALIDITY CHECK ───────────────────────────────────────────
async function isStudentValid(uid) {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists();
}

async function cleanInvalidStudents(batchId, studentUids) {
    const results  = await Promise.all(studentUids.map(uid => getDoc(doc(db, "users", uid))));
    const validUids = studentUids.filter((uid, i) => results[i].exists());

    if (validUids.length !== studentUids.length) {
        await updateDoc(doc(db, "batches", batchId), { studentUids: validUids });
    }

    return validUids;
}

// ─── REMOVE STUDENT ───────────────────────────────────────────
/**
 * FIX 1 — batch: "" → batch: null, supervisorId: "" → supervisorId: null
 *
 * ORIGINAL BUG:
 *   await updateDoc(userRef, { batch: "", supervisorId: "" })
 *
 *   Empty strings are the wrong sentinel value here. The student
 *   dashboard checks: if (userData.batch) { ... }  — "" is falsy in
 *   JS, so this seems to work. But Firestore field-level checks in
 *   rules use field existence differently from empty-string presence,
 *   and the register.js invite flow uses:
 *       batch: inviteData?.batchId ?? null
 *   which writes null. Mixing "" and null for the same semantic
 *   (no batch assigned) causes inconsistent state across documents.
 *
 *   Additionally, the Firestore rule for adviser updating user docs is:
 *     allow update: if isAdviser()
 *       && affectedKeys().hasOnly(['batch', 'supervisorId', 'updatedAt'])
 *   The original write doesn't include updatedAt but the rule allows
 *   a subset of those keys, so the write passes. Adding updatedAt is
 *   best practice for audit trails.
 *
 * FIX 2 — Revoke pending invites for the removed student's email.
 *
 * ORIGINAL BUG:
 *   After removing a student, no existing pending invite links were
 *   invalidated. If the adviser had previously generated an invite
 *   link for this student, that link remained valid indefinitely.
 *   The removed student (or anyone with the URL) could click the old
 *   link and rejoin the batch without a new invite from the adviser.
 *
 * FIX:
 *   After the batch array removal and user-doc clearing, query the
 *   invitations collection for any pending invite matching this
 *   student's email + this batch, and revoke all of them.
 */
window.removeStudent = async function(uid) {
    if (!activeBatchId) {
        alert("No active batch selected.");
        return;
    }

    const confirmRemove = confirm("Remove this student from the batch?\n\nTheir account is NOT deleted. They can be re-invited later.");
    if (!confirmRemove) return;

    const listBody = document.getElementById('batchStudentList');

    // Stop live listeners before writing to prevent snapshot race conditions
    clearStudentListeners();

    if (listBody) {
        listBody.innerHTML = "<tr><td colspan='6' style='text-align:center;padding:16px;color:var(--text-muted);'>Removing student…</td></tr>";
    }

    try {
        const batchRef = doc(db, "batches", activeBatchId);
        const userRef  = doc(db, "users",   uid);

        // STEP 1: Remove uid from batch.studentUids
        await updateDoc(batchRef, {
            studentUids: arrayRemove(uid)
        });

        // STEP 2: Clear batch fields on the student's user document.
        //
        // FIX 1: Use null instead of "" so the entire codebase uses a
        //         consistent sentinel (null = "no batch assigned").
        //         The register.js invite flow also writes null, so both
        //         sides now agree on the same value.
        //
        // This is allowed by the Firestore rule:
        //   allow update: if isAdviser()
        //     && affectedKeys().hasOnly(['batch', 'supervisorId', 'updatedAt'])
        await updateDoc(userRef, {
            batch:        null,
            supervisorId: null,
            updatedAt:    serverTimestamp()
        });

        // STEP 3: Revoke all pending invites for this student's email
        //         on this batch so old invite links cannot be reused.
        //
        // FIX 2: Fetch the student's email from Firestore (we already
        //         read the user doc above, so this is from cache effectively).
        await revokeStudentInvites(uid, activeBatchId);

        alert("Student removed successfully.");

        // Refresh both the student list and the batch stats card
        await Promise.all([
            viewStudentList(activeBatchId),
            auth.currentUser ? loadBatches(auth.currentUser.uid) : Promise.resolve()
        ]);

    } catch (err) {
        console.error("[removeStudent] Error:", err);

        if (listBody) {
            listBody.innerHTML = "<tr><td colspan='6' style='text-align:center;padding:16px;color:var(--danger);'>❌ Removal failed. Please try again.</td></tr>";
        }

        alert("Failed to remove student. Please check your connection and try again.");
    }
};

/**
 * Revokes all pending invites for a given student email + batch combination.
 * Called after removeStudent() so old invite links cannot be reused.
 *
 * @param {string} studentUid   - UID of the student being removed
 * @param {string} batchId      - ID of the batch they are being removed from
 */
async function revokeStudentInvites(studentUid, batchId) {
    try {
        // Fetch the student's email from their user document
        const userSnap = await getDoc(doc(db, "users", studentUid));
        if (!userSnap.exists()) return;

        const email = userSnap.data().email;
        if (!email) return;

        // Find all pending invites for this email + batch
        const q = query(
            collection(db, "invitations"),
            where("email",   "==", email.toLowerCase()),
            where("batchId", "==", batchId),
            where("status",  "==", "pending")
        );
        const snap = await getDocs(q);

        if (snap.empty) return;

        // Revoke them all
        const revokeOps = snap.docs.map(d =>
            updateDoc(d.ref, { status: "revoked" })
        );
        await Promise.all(revokeOps);

        console.log(`[removeStudent] Revoked ${snap.size} pending invite(s) for ${email}`);

    } catch (err) {
        // Non-fatal — log but don't block the removal flow
        console.warn("[revokeStudentInvites] Could not revoke invites:", err.message);
    }
}

// ─── INTERNAL: Remove student from ALL batches (used in cleanup) ──
/**
 * FIX: Also clears the user document's batch fields.
 *
 * ORIGINAL BUG:
 *   The original removeStudentFromAllBatches() only called arrayRemove
 *   on every batch document but never touched the user document.
 *   The user's batch and supervisorId fields remained pointing to the
 *   old batch, causing stale data on the student dashboard.
 *
 * NOTE: This internal function is not currently called by any UI path
 *   (only by register.js as a cleanup step before applyInvite). It is
 *   kept here for completeness and future use.
 */
async function removeStudentFromAllBatches(uid) {
    const q    = query(collection(db, "batches"), where("studentUids", "array-contains", uid));
    const snap = await getDocs(q);

    // Remove from every batch array in parallel
    await Promise.all(
        snap.docs.map(d =>
            updateDoc(doc(db, "batches", d.id), {
                studentUids: arrayRemove(uid)
            })
        )
    );

    // FIX: Also clear the user document's batch fields so the student's
    //       dashboard reflects the removal immediately.
    try {
        const userSnap = await getDoc(doc(db, "users", uid));
        if (userSnap.exists() && (userSnap.data().batch || userSnap.data().supervisorId)) {
            await updateDoc(doc(db, "users", uid), {
                batch:        null,
                supervisorId: null,
                updatedAt:    serverTimestamp()
            });
        }
    } catch (e) {
        console.warn("[removeStudentFromAllBatches] User doc update skipped:", e.message);
    }
}

async function updateTotalStats(user) {
    try {
        const q    = query(collection(db, "batches"), where("supervisorId", "==", user.uid));
        const snap = await getDocs(q);
        const set  = new Set();
        snap.forEach(d => { (d.data().studentUids || []).forEach(uid => set.add(uid)); });
        return set;
    } catch { return new Set(); }
}
