import { protectPage } from "../authguard.js";
import { db, auth } from "../firebase-config.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    collection, addDoc, query, where, getDocs, 
    updateDoc, doc, arrayUnion, arrayRemove, getDoc, deleteDoc, orderBy, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    initTheme,
    setupThemeToggle,
    setupProfileDropdown,
    setupNotifDropdown,
    populateHeaderUser,
    sanitizeText,
    formatTimestamp,
} from '../js/theme.js';

import {  setupNotificationSystem,
  sendNotification,
  markAllRead,
  clearAllNotifications, notifyReportApproved, notifyReportRejected, notifyAdviserFeedback, notifyLogApproved, notifyDocumentRejected  } from '../js/notifications.js';

initTheme();

let allBatchesCache = [];

const nameCache = {}; 
let state = {
    attendance: [],
    documents: [],
    myStudentUids: new Set() 
};

let activeBatchId = null; 
let currentMonth = new Date();
let studentListeners = [];

// --- 2. AUTH LISTENER ---
protectPage('supervisor').then((user) => {
    if (!user) return;

    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);

    ['logout-link', 'sidebar-logout-btn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', () =>
            signOut(auth).then(() => location.replace("/index.html"))
        );
    });

    fetchUserProfile(user);
    loadBatches(user.uid);
});

function initCombinedRealTimeDashboard(user) {

    updateTotalStats(user).then((uids) => {
        state.myStudentUids = uids;
    });
}

async function updateTotalStats(user) {
    try {
        const batchQuery = query(collection(db, "batches"), where("supervisorId", "==", user.uid));
        const batchSnap = await getDocs(batchQuery);
        const uniqueStudents = new Set();
        batchSnap.forEach(doc => {
            const data = doc.data();
            if (data.studentUids) data.studentUids.forEach(uid => uniqueStudents.add(uid));
        });
        return uniqueStudents;
    } catch (e) { return new Set(); }
}

// --- 4. UI & INTERACTION HELPERS ---

async function getStudentName(uid) {
    if (nameCache[uid]) return nameCache[uid];
    const userDoc = await getDoc(doc(db, "users", uid));
    const name = userDoc.exists() ? (userDoc.data().name || "Student") : "Unknown";
    nameCache[uid] = name;
    return name;
}

async function fetchUserProfile(user) {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (userSnap.exists()) {
        const userData = userSnap.data();

        const fullName =
            userData.name ||
            `${userData.firstName || ''} ${userData.surname || ''}`.trim() ||
            "User";

        document.getElementById('user-display-name').innerText = fullName;
        document.getElementById('user-display-name-pop').innerText = fullName;
        document.getElementById('user-full-email').innerText = user.email;

        const avatarEl = document.getElementById('avatar-initial');
        if (avatarEl) {
            avatarEl.textContent = fullName.charAt(0).toUpperCase();
        }

        populateHeaderUser(fullName, user.email);
    }
}

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
        const requiredHours = parseFloat(data.requiredHours) || 600;
        const TOTAL_DOCS_REQUIRED = 13;

        // 1. Calculate Approved Attendance Hours
        const attSnap = await getDocs(query(collection(db, "attendance"), where("uid", "==", uid)));
        let completedHours = 0;
        attSnap.forEach(d => {
            const log = d.data();
            if (normalizeStatus(log.status) === 'Approved') {
                completedHours += computeHoursDecimal(log.timeIn, log.timeOut);
            }
        });

        // 2. Calculate Approved Documents
        const docSnap = await getDocs(query(collection(db, "checklist"), where("uid", "==", uid)));
        let approvedDocs = 0;
        docSnap.forEach(d => {
            if (normalizeStatus(d.data().status) === 'Approved') approvedDocs++;
        });

        const hoursPct = Math.min(100, (completedHours / requiredHours) * 100);
        const docsPct = Math.min(100, (approvedDocs / TOTAL_DOCS_REQUIRED) * 100);

        return {
            progress: Math.round((hoursPct + docsPct) / 2),
            hours: completedHours
        };
    } catch (err) {
        console.error("Progress calculation failed:", err);
        return { progress: 0, hours: 0 };
    }
}

async function updateBatchStats(uid) {
    const totalEl = document.getElementById("bstat-total");
    const studentEl = document.getElementById("bstat-students");
    const activeEl = document.getElementById("bstat-active");

    const q = query(collection(db, "batches"), where("supervisorId", "==", uid));
    const snap = await getDocs(q);

    let totalBatches = 0;
    let totalStudentsSet = new Set();
    let activeBatches = 0;

    snap.forEach(docSnap => {
        totalBatches++;

        const data = docSnap.data();
        const students = data.studentUids || [];

        // count students uniquely
        students.forEach(uid => totalStudentsSet.add(uid));

        // active batch = has students
        if (students.length > 0) activeBatches++;
    });

    // update UI
    if (totalEl) totalEl.textContent = totalBatches;
    if (studentEl) studentEl.textContent = totalStudentsSet.size;
    if (activeEl) activeEl.textContent = activeBatches;
}

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    const openModalBtn = document.getElementById('openModalBtn');
    const createBatchForm = document.getElementById('createBatchForm');

    if (openModalBtn) {
        openModalBtn.onclick = () => {
            document.getElementById('createBatchModal').style.display = 'flex';
        };
    }

    if (createBatchForm) {
        createBatchForm.onsubmit = createNewBatch;
    }
});

// --- CORE FUNCTIONS ---

async function createNewBatch(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    
    try {
        btn.disabled = true;
        btn.innerText = "Creating...";

        const batchData = {
            name: document.getElementById('batchName').value,
            year: document.getElementById('academicYear').value,
            supervisorId: auth.currentUser.uid,
            studentUids: [],
            createdAt: new Date().toISOString()
        };

        await addDoc(collection(db, "batches"), batchData);
        
        closeModal();
        // Refresh with the current user's UID
        loadBatches(auth.currentUser.uid);
    } catch (error) {
        console.error("Error:", error);
        alert("Failed to create batch.");
    } finally {
        btn.disabled = false;
        btn.innerText = "Create Batch";
    }
}

async function loadBatches(uid) {
    const container = document.getElementById('batchContainer');
    if (!container) return;

    const q = query(collection(db, "batches"), where("supervisorId", "==", uid));
    const snapshot = await getDocs(q);

    await updateBatchStats(uid);

    allBatchesCache = []; // reset cache
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

    const card = document.createElement('div');
    card.className = 'batch-card';

    card.innerHTML = `
        <div class="batch-info">
            <strong>${data.name}</strong>
            <p>${data.year}</p>
            <small>${data.studentUids ? data.studentUids.length : 0} Students Assigned</small>
        </div>
        <div class="batch-card-actions">
            <button class="btn btn-primary"
                onclick="openStudentModal('${batchId}', '${data.name}')">
                👥 Manage
            </button>

            <button class="btn btn-danger"
                onclick="deleteBatch('${batchId}', '${data.name}')">
                🗑 Delete
            </button>
        </div>
    `;

    container.appendChild(card);
}

document.addEventListener("DOMContentLoaded", () => {
    const searchInput = document.getElementById("batch-search");

    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            const value = e.target.value.toLowerCase().trim();
            filterBatches(value);
        });
    }
});

function filterBatches(keyword) {
    const container = document.getElementById('batchContainer');
    container.innerHTML = "";

    if (!keyword) {
        allBatchesCache.forEach(b => renderBatchCard(b.id, b));
        return;
    }

    const filtered = allBatchesCache.filter(batch => {
        return (
            batch.name?.toLowerCase().includes(keyword) ||
            batch.year?.toLowerCase().includes(keyword)
        );
    });

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state">No matching batches found.</div>`;
        return;
    }

    filtered.forEach(b => renderBatchCard(b.id, b));
}

window.deleteBatch = async function(batchId, batchName) {
    // Standard confirmation dialog
    const proceed = confirm(`Are you sure you want to delete the batch "${batchName}"?\n\nThis will NOT delete the students' accounts, only this specific grouping.`);
    
    if (!proceed) return;

    try {
        const batchRef = doc(db, "batches", batchId);
        await deleteDoc(batchRef);
        
        alert("Batch deleted successfully.");
        
        // Refresh the list using the current authenticated user's ID
        if (auth.currentUser) {
            loadBatches(auth.currentUser.uid);
        }
    } catch (error) {
        console.error("Error deleting batch:", error);
        alert("Error: Could not delete batch. Check your Firebase permissions.");
    }
};

// Inside batchmanagement.js -> window.generateinvitelink

// --- NEW: INVITATION LOGIC ---

window.generateInviteLink = async function() {
    const emailInput = document.getElementById('studentEmailSearch');
    const email = emailInput.value.trim().toLowerCase();
    
    if (!email) {
        alert("Please enter a student's email.");
        return;
    }

    if (!activeBatchId) {
        alert("Error: No batch selected. Please reopen the modal.");
        return;
    }

    try {
        const inviteData = {
            email: email,
            batchId: activeBatchId, // Now this will work!
            supervisorId: auth.currentUser.uid,
            status: "pending",
            createdAt: new Date().toISOString()
        };
        // Add to a new 'invitations' collection
        const inviteRef = await addDoc(collection(db, "invitations"), inviteData);

        // 2. Generate the URL
        // Note: Replace 'yourdomain.com' with your actual hosting domain (e.g., localhost:5500)
        const baseUrl = window.location.origin; 
        const inviteLink = `${baseUrl}/all-pov/register.html?inviteId=${inviteRef.id}&batchId=${activeBatchId}&advId=${auth.currentUser.uid}`;

        // 3. Display the link to the Supervisor
        // You can replace this alert with a more sophisticated UI modal/copy-to-clipboard later
        const confirmCopy = confirm(`Invitation generated for ${email}!\n\nClick OK to copy this link and send it to the student:\n${inviteLink}`);
        
        if (confirmCopy) {
            await navigator.clipboard.writeText(inviteLink);
            alert("Link copied to clipboard!");
        }

        emailInput.value = "";
    } catch (error) {
        console.error("Error generating invite:", error);
        alert("Failed to generate invitation.");
    }
};

// --- MODAL & STUDENT CONTROLS (ATTACHED TO WINDOW) ---

window.closeModal = function() {
    document.getElementById('createBatchModal').style.display = 'none';
    document.getElementById('createBatchForm').reset();
};

window.openStudentModal = function(batchId, batchName) {
    activeBatchId = batchId;
    document.getElementById('currentBatchTitle').innerText = `Manage: ${batchName}`;
    document.getElementById('studentListModal').style.display = 'flex';
    viewStudentList(batchId);
};

window.closeStudentModal = function() {
    document.getElementById('studentListModal').style.display = 'none';

    studentListeners.forEach(unsub => unsub());
    studentListeners = [];
};

async function viewStudentList(batchId) {
    const listBody = document.getElementById('batchStudentList');
    listBody.innerHTML = "<tr><td colspan='6'>Loading students...</td></tr>";

    // تنظيف previous listeners
    studentListeners.forEach(unsub => unsub());
    studentListeners = [];

    const batchSnap = await getDoc(doc(db, "batches", batchId));
    const uids = batchSnap.data().studentUids || [];

    if (uids.length === 0) {
        listBody.innerHTML = "<tr><td colspan='6'>No students assigned.</td></tr>";
        return;
    }

    listBody.innerHTML = "";

    for (const uid of uids) {

        const row = document.createElement('tr');
        row.innerHTML = `
            <td colspan="6">Loading...</td>
        `;
        listBody.appendChild(row);

        // Listen to user info (optional real-time)
        const userRef = doc(db, "users", uid);

        const unsubUser = onSnapshot(userRef, async (userSnap) => {
            if (!userSnap.exists()) return;

            const userData = userSnap.data();

            // Listen to attendance + checklist in real-time
            const attQuery = query(collection(db, "attendance"), where("uid", "==", uid));
            const docQuery = query(collection(db, "checklist"), where("uid", "==", uid));

            const unsubAttendance = onSnapshot(attQuery, async (attSnap) => {
                const unsubChecklist = onSnapshot(docQuery, async (docSnap) => {

                    let completedHours = 0;
                    let approvedDocs = 0;

                    const requiredHours = parseFloat(userData.requiredHours) || 600;
                    const TOTAL_DOCS_REQUIRED = 13;

                    attSnap.forEach(d => {
                        const log = d.data();
                        if (normalizeStatus(log.status) === 'Approved') {
                            completedHours += computeHoursDecimal(log.timeIn, log.timeOut);
                        }
                    });

                    docSnap.forEach(d => {
                        if (normalizeStatus(d.data().status) === 'Approved') {
                            approvedDocs++;
                        }
                    });

                    const hoursPct = Math.min(100, (completedHours / requiredHours) * 100);
                    const docsPct = Math.min(100, (approvedDocs / TOTAL_DOCS_REQUIRED) * 100);
                    const progress = Math.round((hoursPct + docsPct) / 2);

                    // Update row
                    row.innerHTML = `
                        <td><strong>${userData.firstName || ''} ${userData.surname || ''}</strong></td>
                        <td>${userData.course || '-'}</td>
                        <td>${userData.section || '-'}</td>
                        <td>${completedHours.toFixed(1)} hrs</td>
                        <td>
                            <div style="width:100px; background:var(--bg-elevated); border-radius:6px; overflow:hidden; border: 1px solid rgba(255,255,255,0.1);">
                                <div style="width:${progress}%; background:var(--brand-gold); height:8px;"></div>
                            </div>
                            <small>${progress}% Complete</small>
                        </td>
                        <td>
                            <button onclick="removeStudent('${uid}')" class="btn-delete-small">Remove</button>
                        </td>
                    `;
                });

                studentListeners.push(unsubChecklist);
            });

            studentListeners.push(unsubAttendance);
        });

        studentListeners.push(unsubUser);
    }
}

window.removeStudent = async function(uid) {
    if (confirm("Remove student from this batch?")) {
        const batchRef = doc(db, "batches", activeBatchId);
        await updateDoc(batchRef, {
            studentUids: arrayRemove(uid)
        });
        viewStudentList(activeBatchId);
        loadBatches(auth.currentUser.uid);
    }
};

function closeModalById(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
}

// SAFE modal bindings
document.addEventListener("DOMContentLoaded", () => {

    // CREATE MODAL
    document.getElementById("close-create-modal")?.addEventListener("click", () => {
        closeModalById("createBatchModal");
    });

    document.getElementById("cancel-create-btn")?.addEventListener("click", () => {
        closeModalById("createBatchModal");
    });

    // STUDENT MODAL
    document.getElementById("close-student-modal")?.addEventListener("click", () => {
        closeModalById("studentListModal");
    });

    // CLICK OUTSIDE MODAL CLOSE
    ["createBatchModal", "studentListModal"].forEach(id => {
        const modal = document.getElementById(id);
        modal?.addEventListener("click", (e) => {
            if (e.target === modal) modal.style.display = "none";
        });
    });

    // INVITE BUTTON FIX
    document.getElementById("generateInviteBtn")?.addEventListener("click", (e) => {
        e.preventDefault();
        window.generateInviteLink?.();
    });

    // SIDEBAR BUTTON FIXES
    document.getElementById("sidebar-theme-btn")?.addEventListener("click", () => {
        document.documentElement.classList.toggle("dark-theme");
        localStorage.setItem(
            "ojtrack-theme",
            document.documentElement.classList.contains("dark-theme") ? "dark" : "light"
        );
    });

    document.getElementById("sidebar-logout-btn")?.addEventListener("click", () => {
        signOut(auth).then(() => location.replace("/index.html"));
    });
});