import { auth, db } from "../firebase-config.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { protectPage } from "../authguard.js";
import { collection, setDoc, doc, updateDoc, onSnapshot, serverTimestamp, getDoc, query, limit, where, arrayUnion} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
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

// --- AUTH & INITIALIZATION ---
protectPage('student').then((user) => {
    if (!user) return;

    // Initialize UI Components
    setupHeaderUI(user);
    setupNotificationSystem(user.uid);
    
});

// --- UI SETUP FUNCTIONS ---
function setupHeaderUI(user) {
    const userRef = doc(db, "users", user.uid);
    getDoc(userRef).then((snap) => {
        if (snap.exists()) {
            const data = snap.data();
            document.getElementById('user-display-name').innerText = data.name || "Student";
            document.getElementById('user-display-name-pop').innerText = data.name || "Student";
            document.getElementById('user-full-email').innerText = user.email;
        }
    });

    const profileTrigger = document.getElementById('profile-trigger');
    const profileMenu = document.getElementById('profile-menu');
    profileTrigger.onclick = (e) => {
        e.stopPropagation();
        profileMenu.classList.toggle('show');
    };

    const notifBtn = document.getElementById('notif-btn');
    const notifModal = document.getElementById('notif-modal');
    notifBtn.onclick = (e) => {
        e.stopPropagation();
        notifModal.classList.toggle('show');
    };

    document.getElementById('logout-link').onclick = () => {
        signOut(auth).then(() => window.location.replace("/index.html"));
    };

    window.addEventListener('click', () => {
        if(profileMenu) profileMenu.classList.remove('show');
        if(notifModal) notifModal.classList.remove('show');
    });
}

window.dismissNotif = async (id, type, docId) => {
    try {
        let ref;

        if (type === "approval") {
            ref = doc(db, "checklist", docId);
        } else if (type === "feedback") {
            ref = doc(db, "students", user.uid, "feedback", docId);
        }

        if (!ref) return;

        await updateDoc(ref, {
            dismissedBy: arrayUnion(user.uid)
        });

    } catch (e) {
        console.error("Dismiss error:", e);
    }
};

const docOptions = {
    'Forms': [
        { val: 'info-sheet', text: 'Information Sheet' },
        { val: 'resume', text: 'Resume Template' },
        { val: 'medical', text: 'Medical Letter' },
        { val: 'endorsement-letter', text: 'Endorsement Letter' },
        { val: 'consent-form', text: 'Consent Form' },
        { val: 'proposal-letter', text: 'Proposal Letter' },
        { val: 'memorandum', text: 'Memorandum of Agreement (MOA)' }
    ],
    'Requirements': [
        { val: 'q1-par', text: '1st Quarter P.A.R/DTR' },
        { val: 'q2-par', text: '2nd Quarter P.A.R' },
        { val: 'q3-par', text: '3rd Quarter P.A.R/DTR' },
        { val: 'q4-par', text: '4th Quarter P.A.R' },
        { val: 'training-plan', text: 'Training Plan Template' },
        { val: 'narrative-report', text: 'Narrative Report' }
    ]
};

const allDocKeys = [...docOptions.Forms, ...docOptions.Requirements];

let currentStudentDocs = {}; // Local cache to store document statuses

onAuthStateChanged(auth, (user) => {
    if (user) {
        // Sync Theme on load
        const savedTheme = localStorage.getItem('ojtrack-theme') || 'dark';
        document.body.className = savedTheme + '-theme';
        document.documentElement.className = savedTheme + '-theme';
 
        listenToChecklist(user.uid);
        setupHeaderUI(user); 
        
    } else {
        window.location.replace("/index.html");
    }
});

    function listenToChecklist(uid) {
    const tbody = document.getElementById('checklist-tbody');
    const progressBar = document.getElementById('overall-progress-bar');
    const completionText = document.getElementById('completion-text');
    
    onSnapshot(collection(db, "checklist"), (snapshot) => {
        currentStudentDocs = {}; 
        let approvedCount = 0;
        const totalDocs = allDocKeys.length;

        snapshot.docs.forEach(d => {
            const data = d.data();
            if (data.uid === uid) {
                currentStudentDocs[data.formKey] = data;
                // Count as "done" if status is Approved
                if (data.status === "Approved") approvedCount++;
            }
        });

        // Update Progress Bar UI
        const percentage = Math.round((approvedCount / totalDocs) * 100);
        progressBar.style.width = `${percentage}%`;
        completionText.innerText = `${approvedCount} of ${totalDocs} documents approved (${percentage}%)`;

        tbody.innerHTML = "";
        
        allDocKeys.forEach(opt => {
            const data = currentStudentDocs[opt.val];
            const row = document.createElement('tr');
            
            // Status Logic
            const status = data ? data.status : 'Not Submitted';
            const statusClass = status.toLowerCase().replace(/\s/g, '-');
            
            // Date Logic
            const dateDisplay = data ? data.dateSubmitted : '<span class="text-muted">No date</span>';
            
            row.innerHTML = `
                <td class="doc-name-cell">
                    <strong>${opt.text}</strong>
                    ${data && data.remarks !== "Waiting for review" ? `<p class="remark-text">Note: ${data.remarks}</p>` : ''}
                </td>
                <td>${dateDisplay}</td>
                <td>
                    <span class="status-pill ${statusClass}">${status}</span>
                </td>
                <td>
                    <div class="row-actions">
                        ${data ? `<button class="btn-icon-view" onclick="previewDoc('${data.fileData}')" title="View Document">👁️</button>` : ''}
                        ${(!data || data.status === 'Rejected') ? `<span class="action-required">⚠️ Upload Needed</span>` : ''}
                    </div>
                </td>`;
            tbody.appendChild(row);
        });

        // Inside your onSnapshot or render function for the checklist table:
function renderChecklistRow(docId, data) {
    const row = document.createElement('tr');
    
    // Logic to determine if a file is actually present
    const hasFile = data.fileData && data.fileData !== "";
    const isRejected = data.status === "Rejected";

    row.innerHTML = `
        <td>${data.formKey.toUpperCase()}</td>
        <td>${data.status}</td>
        <td>
            ${hasFile ? 
                `<button onclick="viewFile('${data.fileData}')" class="btn-view">View File</button>` : 
                `<span class="no-file">No File Uploaded</span>`
            }
        </td>
        <td>
            ${(!hasFile || isRejected) ? 
                `<input type="file" id="file-${docId}" onchange="handleUpload('${docId}', this)">` : 
                `<span class="text-locked">Locked (Pending/Approved)</span>`
            }
        </td>
    `;
    return row;
}

        async function handleUpload(docId, input) {
            const file = input.files[0];
            if (!file) return;

            // Convert to Base64 (as you are likely doing)
            const base64 = await convertToBase64(file);

            try {
                await updateDoc(doc(db, "checklist", docId), {
                    fileData: base64,
                    status: "Pending", // Reset status to Pending for Adviser to see
                    dateSubmitted: new Date().toLocaleDateString(),
                    remarks: "" // Clear old rejection remarks
                });
                alert("Re-uploaded successfully!");
            } catch (e) {
                alert("Upload failed: " + e.message);
            }
        }
    });
}

// Global functions
window.openUploadModal = (type) => {
    const modal = document.getElementById('uploadModal');
    const selector = document.getElementById('formSelector');
    
    // FILTER LOGIC: Only show options that haven't been submitted OR are Rejected
    const availableOptions = docOptions[type].filter(opt => {
        const docData = currentStudentDocs[opt.val];
        // If doc doesn't exist, it's available. If it exists, it's only available if Rejected.
        return !docData || docData.status === "Rejected";
    });

    if (availableOptions.length === 0) {
        alert(`All ${type} are either Pending or Approved. No further uploads required.`);
        return;
    }

    document.getElementById('modalTitle').innerText = `Add OJT ${type}`;
    selector.innerHTML= availableOptions.map(opt => `<option value="${opt.val}">${opt.text}</option>`).join('');
    modal.style.display = 'flex';
};

document.getElementById('btn-cancel-upload').onclick = () => {
    document.getElementById('uploadModal').style.display = 'none';
};

window.previewDoc = (base64) => {
    const modal = document.getElementById('previewModal');
    const container = document.getElementById('previewContainer');
    container.innerHTML = `<iframe src="${base64}" width="100%" height="100%" frameborder="0"></iframe>`;
    modal.style.display = 'flex';
};

document.getElementById('btn-close-preview').onclick = () => {
    document.getElementById('previewModal').style.display = 'none';
};

window.processUpload = async () => {
    const user = auth.currentUser;
    const selectedForm = document.getElementById('formSelector').value;
    const fileInput = document.getElementById('fileInput');
    const fileName = fileInput.files[0] ? fileInput.files[0].name : "No file selected";

    if (!fileInput.files[0]) return alert("Please select a file!");

    // Security Check: Verify status one last time before allowing upload
    const existingDoc = currentStudentDocs[selectedForm];
    if (existingDoc && (existingDoc.status === "Pending Approval" || existingDoc.status === "Approved")) {
        alert("This document is already under review or approved.");
        return;
    }

    const btn = document.querySelector('.btn-primary');
    btn.disabled = true;
    btn.innerText = "Uploading...";

    try {
        const reader = new FileReader();
        reader.readAsDataURL(fileInput.files[0]);
        reader.onload = async () => {
            const base64File = reader.result;
            const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });

            // Use studentUID_formKey as document ID to overwrite if it was previously rejected
            await setDoc(doc(db, "checklist", `${user.uid}_${selectedForm}`), {
                uid: user.uid,
                studentName: user.displayName || "Student",
                formKey: selectedForm,
                fileData: base64File,
                fileName: fileName,
                dateSubmitted: dateStr,
                status: "Pending Approval",
                remarks: "Waiting for review",
                timestamp: serverTimestamp()
            });

            alert("File submitted successfully.");
            document.getElementById('uploadModal').style.display = 'none';
            fileInput.value = ''; // Reset file input
        };
    } catch (err) {
        console.error(err);
        alert("Upload failed.");
    } finally {
        btn.disabled = false;
        btn.innerText = "Submit File";
    }
};