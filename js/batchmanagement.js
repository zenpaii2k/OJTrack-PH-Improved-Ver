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

import { setupNotificationSystem } from '../js/notifications.js';

initTheme();

const nameCache = {}; 
let state = {
    attendance: [],
    documents: [],
    myStudentUids: new Set() 
};

let activeBatchId = null; 
let currentMonth = new Date();

// --- 2. AUTH LISTENER ---
protectPage('supervisor').then((user) => {
    if (user) {
       fetchUserProfile(user);
        initCombinedRealTimeDashboard(user);
        loadBatches(user.uid);
        setupInteractions(user);
        setupNotificationSystem(user.uid);
    }
});

function initCombinedRealTimeDashboard(user) {

    updateTotalStats(user).then((uids) => {
        state.myStudentUids = uids;
        
        // Listener for Attendance
        const attendanceQ = query(collection(db, "attendance"), orderBy("timestamp", "asc"), limit(50));
        onSnapshot(attendanceQ, (snapshot) => {
            state.attendance = snapshot.docs.map(d => ({ id: d.id, ...d.data(), type: 'attendance' }));
        });

        // Listener for Requirements
        const checklistQ = query(collection(db, "checklist"), orderBy("timestamp", "asc"), limit(50));
        onSnapshot(checklistQ, (snapshot) => {
            state.documents = snapshot.docs.map(d => ({ id: d.id, ...d.data(), type: 'document' }));
        });
    });
}

function setupInteractions(user) {

    const profileMenu = document.getElementById('profile-menu');
    const notifBtn = document.getElementById('notif-btn');
    const notifModal = document.getElementById('notif-modal');
    if (notifBtn) {
        notifBtn.onclick = (e) => {
            e.stopPropagation();
            notifModal.classList.toggle('show');
        };
    }

    const clearBtn = document.getElementById('clear-all-notifs'); 

    if (clearBtn) {
    clearBtn.onclick = async (e) => {
        e.preventDefault();

        const updates = [];

        [...state.attendance, ...state.documents].forEach(item => {
            const col = item.type === "attendance" ? "attendance" : "checklist";

            updates.push(
                updateDoc(doc(db, col, item.id), {
                    dismissedBy: arrayUnion(user.uid)
                })
            );
        });

        await Promise.all(updates);

        const key = `sup_dismissed_${user.uid}`;
        const allIds = [...state.attendance, ...state.documents].map(i => i.id);
        localStorage.setItem(key, JSON.stringify(allIds));
    };
}

    const navItems = document.querySelectorAll('.settings-list .nav-item');
    const sections = document.querySelectorAll('.content-section');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetSectionId = item.getAttribute('data-section');

            // 1. Update Active Sidebar Class
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            // 2. Hide ALL sections and show the target one
            sections.forEach(section => {
                section.style.display = 'none';
                if (section.id === targetSectionId) {
                    section.style.display = 'block';
                }
            });

            // 3. Trigger Load specifically for batch
            if (targetSectionId === 'batch-content') {
                loadBatchList();
            }
        });
    });

    // Dropdowns
    document.getElementById('profile-trigger').onclick = (e) => {
        e.stopPropagation();
        profileMenu.classList.toggle('show');
    };

    document.getElementById('logout-link').onclick = () => signOut(auth).then(() => location.replace("/index.html"));
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

// --- 5. BATCH MANAGEMENT CORE --- (Existing logic preserved below)
async function fetchUserProfile(user) {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (userSnap.exists()) {
        const userData = userSnap.data();
        document.getElementById('user-display-name').innerText = userData.name || "User";
        document.getElementById('user-display-name-pop').innerText = userData.name;
        document.getElementById('user-full-email').innerText = user.email;
    }
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

    onAuthStateChanged(auth, (user) => {
        if (user) {
            loadBatches(user.uid);
        } else {
            window.location.replace("/index.html");
        }
    });
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

    container.innerHTML = ""; 

    if (snapshot.empty) {
        container.innerHTML = '<div class="empty-state">No batches created yet.</div>';
        return;
    }

    snapshot.forEach((batchDoc) => {
        const data = batchDoc.data();
        const batchId = batchDoc.id;
        const card = document.createElement('div');
        card.className = 'batch-card';
        
        // --- REVISED CARD HTML WITH DELETE BUTTON ---
        card.innerHTML= `
            <div class="batch-info">
                <strong>${data.name}</strong>
                <p>${data.year}</p>
                <small>${data.studentUids ? data.studentUids.length : 0} Students Assigned</small>
            </div>
            <div class="batch-card-actions">
                <button class="btn-manage" onclick="openStudentModal('${batchId}', '${data.name}')">Manage Students</button>
                <button class="btn-delete-batch" onclick="deleteBatch('${batchId}', '${data.name}')" title="Delete Batch">🗑️</button>
            </div>
        `;
        container.appendChild(card);
    });
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
};

async function viewStudentList(batchId) {
    const listBody = document.getElementById('batchStudentList');
    listBody.innerHTML = "<tr><td colspan='3'>Loading...</td></tr>";

    const batchSnap = await getDoc(doc(db, "batches", batchId));
    const uids = batchSnap.data().studentUids || [];

    if (uids.length === 0) {
        listBody.innerHTML = "<tr><td colspan='3'>No students assigned.</td></tr>";
        return;
    }

    listBody.innerHTML = "";
    for (const uid of uids) {
        const userSnap = await getDoc(doc(db, "users", uid));
        if (userSnap.exists()) {
            const userData = userSnap.data();
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${userData.firstName} ${userData.surname}</td>
                <td>${userData.course}-${userData.section}</td>
                <td><button onclick="removeStudent('${uid}')" class="btn-delete-small">Remove</button></td>
            `;
            listBody.appendChild(row);
        }
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