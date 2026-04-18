import { protectPage } from "../authguard.js";
import { db, auth } from "../firebase-config.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, query, where, getDocs, onSnapshot, doc, updateDoc, getDoc, orderBy, limit, arrayUnion } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
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

protectPage('supervisor').then((user) => {
    // Initialize your supervisor-specific data here
});

onAuthStateChanged(auth, async (user) => {
    if (user) {

        setupInteractions(user); 
        initCombinedRealTimeDashboard(user);
        setupNotificationSystem(user.uid);
        
        await fetchUserProfile(user);
        await initializeSupervisorData(user.uid);
    } else {
        location.replace("/index.html");
    }
});

let currentDocId = null;
let currentDocStatus = null;
let allStudents = []; // Store all interns locally for filtering

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

function initCombinedRealTimeDashboard(user) {

    updateTotalStats(user).then((uids) => {
        state.myStudentUids = uids;
        
        // Listener for Attendance
        const attendanceQ = query(collection(db, "attendance"), orderBy("timestamp", "asc"), limit(50));
        onSnapshot(attendanceQ, (snapshot) => {
            state.attendance = snapshot.docs.map(d => ({ id: d.id, ...d.data(), type: 'attendance' }));
            renderUI(user);
        });

        // Listener for Requirements
        const checklistQ = query(collection(db, "checklist"), orderBy("timestamp", "asc"), limit(50));
        onSnapshot(checklistQ, (snapshot) => {
            state.documents = snapshot.docs.map(d => ({ id: d.id, ...d.data(), type: 'document' }));
            renderUI(user);
        });
    });
}

let renderTimeout;

window.dismissSingleNotif = async (id, userId, type) => {
    try {
        const collectionName = type === 'attendance' ? 'attendance' : 'checklist';

        const docRef = doc(db, collectionName, id);

        await updateDoc(docRef, {
            dismissedBy: arrayUnion(userId)
        });

    } catch (e) {
        console.error("Dismiss Error:", e);
    }
};

// Required for the Name lookup
async function getStudentName(uid) {
    if (nameCache[uid]) return nameCache[uid];
    const userDoc = await getDoc(doc(db, "users", uid));
    let name = "Unknown Student";
    if (userDoc.exists()) {
        const d = userDoc.data();
        name = d.name || `${d.firstName || ''} ${d.surname || ''}`.trim() || "Anonymous";
    }
    nameCache[uid] = name;
    return name;
}

// --- 2. Fixed Interaction & Toggle Logic ---

function setupInteractions() {
    const profileMenu = document.getElementById('profile-menu');
    const notifModal = document.getElementById('notif-modal');
    const themeBtn = document.getElementById('theme-toggle-btn');
    const logoutBtn = document.getElementById('logout-link');

    // Dropdowns
    const profileTrigger = document.getElementById('profile-trigger');
    if (profileTrigger) {
        profileTrigger.onclick = (e) => {
            e.stopPropagation();
            profileMenu?.classList.toggle('show');
            notifModal?.classList.remove('show');
        };
    }

    const notifBtn = document.getElementById('notif-btn');
    if (notifBtn) {
        notifBtn.onclick = (e) => {
            e.stopPropagation();
            notifModal?.classList.toggle('show');
            profileMenu?.classList.remove('show');
        };
    }

    // Global click to close menus
    window.onclick = () => {
        profileMenu?.classList.remove('show');
        notifModal?.classList.remove('show');
    };

    const clearBtn = document.getElementById('clear-all-notifs');

    if (clearBtn) {
    clearBtn.onclick = async (e) => {
        e.stopPropagation();

        const updates = [];

        [...state.attendance, ...state.documents].forEach(item => {
            const collectionName = item.type === 'attendance' ? 'attendance' : 'checklist';
            const docRef = doc(db, collectionName, item.id);

            updates.push(updateDoc(docRef, {
                dismissedBy: arrayUnion(user.uid)
            }));
        });

        await Promise.all(updates);
    };
}

    if (logoutBtn) {
        logoutBtn.onclick = () => signOut(auth).then(() => location.replace("/index.html"));
    }
}

async function fetchUserProfile(user) {
    try {
        const userDocRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userDocRef); 

        if (userSnap.exists()) {
            const userData = userSnap.data();
            const userName = userData.name || "User";

            // Update Header Name
            const displayNameEl = document.getElementById('user-display-name');
            if (displayNameEl) displayNameEl.innerText = userName;

            // Update Pop-up Name
            const displayNamePopEl = document.getElementById('user-display-name-pop');
            if (displayNamePopEl) displayNamePopEl.innerText = userName;

            // Update Pop-up Email
            const emailEl = document.getElementById('user-full-email');
            if (emailEl) emailEl.innerText = user.email;
        } 
    } catch (error) {
        console.error("Profile Fetch Error:", error);
    }
}

async function initializeSupervisorData(uid) {
    const batchFilter = document.getElementById('batch-filter');
    const studentListContainer = document.getElementById('student-list');
    
    // 1. Fetch Batches
    const batchQuery = query(collection(db, "batches"), where("supervisorId", "==", uid));
    const batchSnapshot = await getDocs(batchQuery);
    
    allStudents = []; // Reset local cache
    batchFilter.innerHTML = `<option value="all">All Students</option>`;

    const batchPromises = batchSnapshot.docs.map(async (batchDoc) => {
        const batchData = batchDoc.data();
        const batchId = batchDoc.id;

        // Add to dropdown
        const option = document.createElement('option');
        option.value = batchId;
        option.innerText = batchData.name;
        batchFilter.appendChild(option);

        // 2. Fetch Interns for this batch
        const studentIds = batchData.studentUids || [];
        for (const sId of studentIds) {
            const sSnap = await getDoc(doc(db, "users", sId));
            if (sSnap.exists()) {
                allStudents.push({
                    uid: sId,
                    ...sSnap.data(),
                    batchId: batchId,
                    batchName: batchData.name
                });
            }
        }
    });

    await Promise.all(batchPromises);
    renderStudentList(allStudents); // Initial render
}

function renderStudentList(studentsToDisplay) {
    const studentListContainer = document.getElementById('student-list');
    studentListContainer.innerHTML = "";

    if (studentsToDisplay.length === 0) {
        studentListContainer.innerHTML = `<div class="loading-text">No interns found.</div>`;
        return;
    }

    studentsToDisplay.forEach(student => {
        const div = document.createElement('div');
        div.className = 'student-nav-item';
        div.innerHTML = `
            <strong>${student.firstName} ${student.surname}</strong><br>
            <small>${student.batchName}</small>
        `;
        div.onclick = () => {
            // Remove active class from others
            document.querySelectorAll('.student-nav-item').forEach(el => el.classList.remove('active'));
            div.classList.add('active');
            selectStudent(student.uid, `${student.firstName} ${student.surname}`, student.batchName);
        };
        studentListContainer.appendChild(div);
    });
}

/**
 * Filter Logic (Batch and Search)
 */
function handleFilters() {
    const selectedBatch = document.getElementById('batch-filter').value;
    const searchTerm = document.getElementById('student-search').value.toLowerCase();

    const filtered = allStudents.filter(s => {
        const matchesBatch = selectedBatch === 'all' || s.batchId === selectedBatch;
        const fullName = `${s.firstName} ${s.surname}`.toLowerCase();
        const matchesSearch = fullName.includes(searchTerm);
        return matchesBatch && matchesSearch;
    });

    renderStudentList(filtered);
}

// Event Listeners for Filters
document.getElementById('batch-filter').onchange = handleFilters;
document.getElementById('student-search').oninput = handleFilters;

/**
 * Existing Document Logic
 */
function selectStudent(studentId, name, batchName) {
    document.getElementById('display-name').innerText = name;
    document.getElementById('display-section').innerText = batchName;
    
    const checklistQuery = query(collection(db, "checklist"), where("uid", "==", studentId));
    
    onSnapshot(checklistQuery, (snapshot) => {
        const tbody = document.getElementById('verification-tbody');
        const countDisplay = document.getElementById('completion-count');
        tbody.innerHTML = "";
        let approvedCount = 0;

        snapshot.forEach((logDoc) => {
            const data = logDoc.data();
            if (data.status === "Approved") approvedCount++;

            const row = document.createElement('tr');
            const isApproved = data.status === "Approved";
            const isRejected = data.status === "Rejected";

                        row.innerHTML = `
                            <td><strong>${data.formKey.toUpperCase()}</strong></td>
                            <td>${data.dateSubmitted}</td>
                            <td>
                                <button class="btn-link" 
                                    onclick="openReviewModal('${logDoc.id}', '${data.fileData}', '${data.status}', '${data.fileName || 'No File Name'}')"
                                    ${isRejected ? 'style="color:#888; border-color:#444;"' : ''}>
                                    ${isApproved ? 'View Final' : (isRejected ? 'Await Re-upload' : 'View & Review')}
                                </button>
                            </td>
                            <td><span class="status-badge ${data.status.toLowerCase().replace(/\s/g, '-')}">${data.status}</span></td>
                            <td>---</td>
                        `;
            tbody.appendChild(row);
        });
        countDisplay.innerText = `${approvedCount}/13`;
    });
}

// Review and Feedback Modal Logic (Kept from previous version)

window.openReviewModal = (docId, fileData, status, fileName) => {
    currentDocId = docId;
    currentDocStatus = status;
   
    const modal = document.getElementById('feedbackModal');
    const approveBtn = document.getElementById('btn-approve');
    const rejectBtn = document.getElementById('btn-reject');
    const remarksField = document.getElementById('supervisorRemarks');
    const previewArea = document.getElementById('modal-preview-area');

    const docNameDisplay = document.getElementById('modal-doc-name'); // <--- Select the P tag

    if (docNameDisplay) {
        docNameDisplay.innerText = fileName; 
    }

    modal.style.display = 'flex';

    // RESET STATE
    approveBtn.disabled = false;
    approveBtn.style.opacity = "1";
    approveBtn.innerText = "Approve";
    rejectBtn.style.display = "inline-block";
    remarksField.disabled = false;

    if (status === "Approved") {
        approveBtn.disabled = true;
        approveBtn.innerText = "Already Approved";
        approveBtn.style.opacity = "0.5";
        rejectBtn.style.display = "none";
        remarksField.disabled = true;
        previewArea.innerHTML = `<iframe src="${fileData}" width="100%" height="100%" frameborder="0"></iframe>`;
    } 
    else if (status === "Rejected" || !fileData || fileData === "null") {
        // LOCK APPROVAL if rejected or no file exists
        approveBtn.disabled = true;
        approveBtn.innerText = "Waiting for Re-upload";
        approveBtn.style.opacity = "0.5";
        rejectBtn.style.display = "none";
        remarksField.disabled = true;
        
        previewArea.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#ff4d4d; gap:10px;">
                <span style="font-size: 3rem;">⚠️</span>
                <p>No document to review.</p>
                <small style="color:#888;">The document was rejected or is empty.</small>
            </div>`;
    } 
    else {
        // Standard Review State (Pending Approval)
        previewArea.innerHTML = `<iframe src="${fileData}" width="100%" height="100%" frameborder="0"></iframe>`;
    }
};

window.closeReviewModal = () => {
    document.getElementById('feedbackModal').style.display = 'none';
    document.getElementById('supervisorRemarks').value = "";
};

window.submitFeedback = async (status) => {
    // Hard block: Prevent approving if the current status is rejected and we are trying to approve
    if (status === "Approved" && (currentDocStatus === "Rejected" || currentDocStatus === "Not Submitted")) {
        return alert("You cannot approve a document that has been rejected or hasn't been re-uploaded.");
    }

    if (currentDocStatus === "Approved") return alert("Document is already finalized.");
    
    const remarks = document.getElementById('supervisorRemarks').value;
    if (!remarks && status === "Rejected") return alert("Please provide a reason for rejection.");
    if (!remarks && status === "Approved") return alert("Please provide a reason for approval.");

    try {
        const updateData = {
            status: status,
            remarks: remarks || "Approved by Supervisor",
            verifiedAt: new Date().toLocaleDateString()
        };

        if (status === "Rejected") {
            updateData.fileData = null; 
            updateData.dateSubmitted = "Waiting for Re-upload";
        }

        await updateDoc(doc(db, "checklist", currentDocId), updateData);
        alert(`Document has been ${status}.`);
        closeReviewModal();
    } catch (e) {
        console.error("Update Error:", e);
        alert("Error updating document.");
    }
};

document.getElementById('btn-approve').onclick = () => submitFeedback("Approved");
document.getElementById('btn-reject').onclick = () => submitFeedback("Rejected");