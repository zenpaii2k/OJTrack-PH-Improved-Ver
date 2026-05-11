import { protectPage } from "../authguard.js";
import { db, auth } from "../firebase-config.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { collection, query, where, getDocs, doc, updateDoc, getDoc, onSnapshot} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    initTheme,
    setupThemeToggle,
    setupProfileDropdown,
    setupNotifDropdown,
    populateHeaderUser,
    sanitizeText,
    formatTimestamp,
} from '../js/theme.js';

import { setupNotificationSystem,
  sendNotification,
  markAllRead,
  clearAllNotifications, notifyDocumentApproved, notifyDocumentRejected} from '../js/notifications.js';

initTheme();

protectPage('supervisor').then((user) => {
    // Initialize your supervisor-specific data here
});

onAuthStateChanged(auth, async (user) => {
    if (user) {

        setupNotificationSystem(user.uid);      
        await fetchUserProfile(user);
        await initializeSupervisorData(user.uid);

        setupThemeToggle('theme-toggle-btn');
        setupThemeToggle('sidebar-theme-btn');
        setupProfileDropdown();
        setupNotifDropdown();
        setupNotificationSystem(user.uid);

        setupLogout();

    } else {
        location.replace("/index.html");
    }
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

let currentDocId = null;
let currentDocStatus = null;
let allStudents = []; 
let unsubscribeChecklist = null;
let currentStudentUid = null;
let currentFormKey = null;

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

async function fetchUserProfile(user) {
    try {
        const userSnap = await getDoc(doc(db, "users", user.uid)); 
        if (userSnap.exists()) {
            const userData = userSnap.data();

            const fullName =
                userData.name ||
                `${userData.firstName || ''} ${userData.surname || ''}`.trim() ||
                "User";

            // Header + modal text
            if (document.getElementById('user-display-name'))
                document.getElementById('user-display-name').innerText = fullName;

            if (document.getElementById('user-display-name-pop'))
                document.getElementById('user-display-name-pop').innerText = fullName;

            if (document.getElementById('user-full-email'))
                document.getElementById('user-full-email').innerText = user.email;

            const avatarEl = document.getElementById('adviser-avatar-initial');
            if (avatarEl) {
                avatarEl.textContent = fullName.charAt(0).toUpperCase();
            }

            // (Optional but recommended)
            populateHeaderUser(fullName, user.email);
        }
    } catch (e) {
        console.error("Profile Error:", e);
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
    currentStudentUid = studentId; 
    document.getElementById('display-name').innerText = name;
    document.getElementById('display-section').innerText = batchName;

    const checklistQuery = query(
        collection(db, "checklist"),
        where("uid", "==", studentId)
    );

    if (unsubscribeChecklist) unsubscribeChecklist();

    unsubscribeChecklist = onSnapshot(checklistQuery, (snapshot) => {
        const tbody = document.getElementById('verification-tbody');
        const countDisplay = document.getElementById('completion-count');

        tbody.innerHTML = "";
        let approvedCount = 0;

        if (snapshot.empty) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align:center; padding:40px; color:#888;">
                        <div style="display:flex; flex-direction:column; align-items:center; gap:10px;">
                            <span style="font-size:2rem;">📄</span>
                            <strong>No documents submitted yet</strong>
                            <small>The student hasn’t uploaded any requirements at this time.</small>
                        </div>
                    </td>
                </tr>
            `;
            countDisplay.innerText = `0/13`;
            return;
        }

        snapshot.forEach((logDoc) => {
            const data = logDoc.data();

            if (data.status === "Approved") approvedCount++;

            const isApproved = data.status === "Approved";
            const isRejected = data.status === "Rejected";

            let buttonClass = "btn-link ";

            if (isApproved) buttonClass += "btn-approved";
            else if (isRejected) buttonClass += "btn-rejected";
            else buttonClass += "btn-pending";

            const row = document.createElement('tr');

            row.innerHTML = `
                <td><strong>${data.formKey.toUpperCase()}</strong></td>
                <td>${data.dateSubmitted}</td>
                <td>
                    <button class="${buttonClass}"
                        onclick="openReviewModal(
                            '${logDoc.id}',
                            '${data.fileData}',
                            '${data.status}',
                            '${data.fileName || 'No File Name'}',
                            '${data.formKey}'
                        )"
                        ${isRejected ? 'disabled' : ''}>
                        ${isApproved ? 'View Final' : (isRejected ? 'Await Re-upload' : 'View & Review')}
                    </button>
                </td>
                <td>
                    <span class="status-badge ${data.status.toLowerCase().replace(/\s/g, '-')}">
                        ${data.status}
                    </span>
                </td>
                <td>---</td>
            `;

            tbody.appendChild(row);
        });

        countDisplay.innerText = `${approvedCount}/13`;
    });
}

// Review and Feedback Modal Logic

window.openReviewModal = (docId, fileData, status, fileName, formKey) => {
    currentDocId = docId;
    currentDocStatus = status;
    currentFormKey = formKey;
   
    const modal = document.getElementById('feedbackModal');
    const approveBtn = document.getElementById('btn-approve');
    const rejectBtn = document.getElementById('btn-reject');
    const remarksField = document.getElementById('supervisorRemarks');
    const previewArea = document.getElementById('modal-preview-area');

    const docNameDisplay = document.getElementById('modal-doc-name');

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
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#CC9704; gap:10px;">
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

    currentDocId = null;
    currentDocStatus = null;
    currentStudentUid = null;
    currentFormKey = null;
};

window.submitFeedback = async (status) => {
    if (status === "Approved" && (currentDocStatus === "Rejected" || currentDocStatus === "Not Submitted")) {
        return alert("You cannot approve a document that has been rejected or hasn't been re-uploaded.");
    }

    if (currentDocStatus === "Approved") return alert("Document is already finalized.");

    const remarks = document.getElementById('supervisorRemarks').value;

    if (!remarks && status === "Rejected") return alert("Please provide a reason for rejection.");
    if (!remarks && status === "Approved") return alert("Please provide a reason for approval.");

   try {
        const remarks = document.getElementById('supervisorRemarks').value;
        const updateData = {
            status: status,
            remarks: remarks || (status === "Approved" ? "Approved by Supervisor" : "No reason provided"),
            verifiedAt: new Date().toLocaleDateString(),
            fileData: null,
            uid: currentStudentUid 
        };

        if (status === "Rejected") {
            updateData.fileData = null;
            updateData.dateSubmitted = "Waiting for Re-upload";
        }

        await updateDoc(doc(db, "checklist", currentDocId), updateData);

        // 2. Prepare Notification Data
        const userSnap = await getDoc(doc(db, "users", auth.currentUser.uid));
        const adviserName = userSnap.exists() ? 
            (userSnap.data().name || `${userSnap.data().firstName} ${userSnap.data().surname}`) : "Adviser";

        const docFriendlyName = currentFormKey.replace(/-/g, ' ').toUpperCase();

        if (status === "Approved") {
            await notifyDocumentApproved(
                currentStudentUid, // Recipient
                docFriendlyName,   // Document Name
                adviserName        // Sender
            );
        } else if (status === "Rejected") {
            await notifyDocumentRejected(
                currentStudentUid, 
                docFriendlyName, 
                adviserName, 
                remarks || "Please check the requirements and re-upload."
            );
        }

        alert(`Document has been ${status}. The student has been notified.`);
        closeReviewModal();

    } catch (e) {
        console.error("Update Error:", e);
        alert("Error updating document: " + e.message);
    }
};

document.getElementById('btn-approve').onclick = () => submitFeedback("Approved");

document.getElementById('btn-reject').onclick = () => submitFeedback("Rejected");