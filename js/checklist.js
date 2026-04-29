import { auth, db } from "../firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { protectPage } from "../authguard.js";
import {
    collection, setDoc, doc, updateDoc, onSnapshot,
    serverTimestamp, getDoc, query, where, limit, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, showToast
} from '../js/theme.js';
import {  setupNotificationSystem,
  sendNotification,
  markAllRead,
  clearAllNotifications, notifyDocumentSubmittedToAdviser, notifyDocumentApproved, notifyDocumentRejected} from '../js/notifications.js';

// ─── INIT THEME ───────────────────────────────────────────────
initTheme();

// ─── DOCUMENT DEFINITIONS ─────────────────────────────────────
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

const allDocKeys = [...docOptions["Forms"], ...docOptions["Requirements"]];

let currentStudentDocs = {};

// ─── AUTH ────────────────────────────────────────────────────
protectPage('student').then((user) => {
    if (!user) return;

    // ✅ FIX: Wire ALL theme + UI controls (was missing before)
    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid); 

    loadUserProfile(user);
    listenToChecklist(user.uid);

    // ✅ Wire logout for both buttons
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

    listenToChecklist(user.uid);
});

// ─── USER PROFILE ────────────────────────────────────────────
async function loadUserProfile(user) {
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) return;

        const data = snap.data();

        const batchId = data?.batchId || data?.batch || null;

        if (!batchId) {
            showNoBatchState(user, data);
            return;
        }

        const name =
            data.name ||
            `${data.firstName || ''} ${data.surname || ''}`.trim() ||
            'Student';

        populateHeaderUser(name, user.email);

    } catch (e) {
        console.error('[Checklist] loadUserProfile:', e);
    }
}

function showNoBatchState(user, data) {
    const name =
        data?.name ||
        `${data?.firstName || ''} ${data?.surname || ''}`.trim() ||
        'Student';

    populateHeaderUser(name, user.email);
    showToast("You don’t have an adviser yet. Uploading is disabled.");

    document.body.classList.add("no-batch-mode");

    if (document.getElementById("no-batch-notice")) return;

    const notice = document.createElement("div");
    notice.id = "no-batch-notice";

    notice.style.cssText = `
        background: rgba(255, 193, 7, 0.12);
        border: 1px solid rgba(255, 193, 7, 0.35);
        color: #ffd24d;
        padding: 12px 16px;
        margin: 10px 20px 0 20px;
        border-radius: 8px;
        font-size: 0.9rem;
        text-align: center;
    `;

    notice.innerHTML = `
        ⚠️ You don’t have an adviser yet.
        Uploading of OJT documents is disabled until you are assigned to a batch.
    `;

    // 🎯 INSERT BELOW HEADER (like attendance page)
    const header = document.querySelector(".dashboard-header");
    if (header && header.parentNode) {
        header.parentNode.insertBefore(notice, header.nextSibling);
    } else {
        // fallback (just in case layout changes)
        const container = document.querySelector('.main-wrapper') || document.body;
        container.prepend(notice);
    }
}

// ─── LISTEN TO CHECKLIST ──────────────────────────────────────
function listenToChecklist(uid) {
    const tbody         = document.getElementById('checklist-tbody');
    const progressBar   = document.getElementById('overall-progress-bar');
    const completionText = document.getElementById('completion-text');

    // ✅ Query only THIS student's checklist docs (efficient)
    const q = query(
        collection(db, "checklist"),
        where("uid", "==", uid)
    );

    onSnapshot(q, (snapshot) => {
        currentStudentDocs = {};
        let approvedCount = 0;
        const totalDocs   = allDocKeys.length;

        snapshot.docs.forEach(d => {
            const data = d.data();
            currentStudentDocs[data.formKey] = { ...data, docId: d.id };
            if (data.status === "Approved") approvedCount++;
        });

        // Update progress bar
        const percentage = totalDocs > 0 ? Math.round((approvedCount / totalDocs) * 100) : 0;
        if (progressBar)    progressBar.style.width = `${percentage}%`;
        if (completionText) completionText.textContent =
            `${approvedCount} of ${totalDocs} documents approved (${percentage}%)`;

        if (!tbody) return;
        tbody.innerHTML = "";

        // Section: Forms
        const formsHeader = document.createElement('tr');
        formsHeader.className = 'section-divider';
        formsHeader.innerHTML = `<td colspan="4">📄 Forms</td>`;
        tbody.appendChild(formsHeader);

        docOptions["Forms"].forEach(opt => renderChecklistRow(opt, tbody, uid));

        // Section: Requirements
        const reqsHeader = document.createElement('tr');
        reqsHeader.className = 'section-divider';
        reqsHeader.innerHTML = `<td colspan="4">📋 Requirements</td>`;
        tbody.appendChild(reqsHeader);

        docOptions["Requirements"].forEach(opt => renderChecklistRow(opt, tbody, uid));

    }, err => console.error('[Checklist] listener error:', err));
}

function renderChecklistRow(opt, tbody, uid) {
    const data      = currentStudentDocs[opt.val];
    const status    = data ? data.status : 'Not Submitted';
    const statusCls = status.toLowerCase().replace(/\s+/g, '-');
    const dateStr   = data ? data.dateSubmitted : '<span class="text-muted">—</span>';
    const hasFile   = data && data.fileData && data.fileData !== "";
    const isLocked  = data && (data.status === 'Pending Approval' || data.status === 'Approved');
    const remarks   = data && data.remarks && data.remarks !== 'Waiting for review'
        ? `<p class="remark-text">📝 ${sanitizeText(data.remarks)}</p>` : '';
        
    const formKeys = new Set(docOptions["Forms"].map(f => f.val));

    const row = document.createElement('tr');
    row.innerHTML = `
        <td class="doc-name-cell">
            <strong>${sanitizeText(opt.text)}</strong>
            ${remarks}
        </td>
        <td>${dateStr}</td>
        <td><span class="status-pill ${statusCls}">${sanitizeText(status)}</span></td>
        <td>
            <div class="row-actions">
                ${hasFile
                    ? `<button class="btn-icon-view" onclick="previewDoc('${data.docId}')" title="View Document">👁️ View</button>`
                    : ''}
                ${!isLocked
                    ? `<button class="btn-icon-upload"onclick="openUploadModal('${formKeys.has(opt.val) ? 'Forms' : 'Requirements'}', '${opt.val}')" title="Upload">📤 Upload</button>`
                    : `<span style="font-size:0.75rem;color:var(--text-muted);">🔒 ${sanitizeText(status)}</span>`}
            </div>
        </td>`;
    tbody.appendChild(row);
}

// ─── GLOBAL FUNCTIONS (called from HTML onclick) ───────────────

window.openUploadModal = async (type, specificKey = null) => {
    const user = auth.currentUser;
    if (!user) return;

    const userSnap = await getDoc(doc(db, "users", user.uid));
    const userData = userSnap.data();
    const batchId = userData?.batchId || userData?.batch || null;

    if (!batchId) {
        showToast("You need an adviser before uploading documents.");
        return;
    }

    const modal    = document.getElementById('uploadModal');
    const selector = document.getElementById('formSelector');

    const options = specificKey
        ? docOptions[type].filter(o => o.val === specificKey)
        : docOptions[type].filter(opt => {
            const docData = currentStudentDocs[opt.val];
            return !docData || docData.status === "Rejected";
        });

    if (options.length === 0) {
        alert(`All ${type} are either Pending or Approved. No uploads needed.`);
        return;
    }

    document.getElementById('modalTitle').innerText = `Upload OJT ${type}`;
    selector.innerHTML = options.map(o => `<option value="${o.val}">${o.text}</option>`).join('');
    modal.style.display = 'flex';
};

window.previewDoc = (docId) => {
    const modal     = document.getElementById('previewModal');
    const container = document.getElementById('previewContainer');
    // Find the document by docId
    const docData = Object.values(currentStudentDocs).find(d => d.docId === docId);
    if (!docData?.fileData) {
        alert('No file available to preview.');
        return;
    }
    container.innerHTML = `<iframe src="${docData.fileData}" width="100%" height="100%" frameborder="0"></iframe>`;
    modal.style.display = 'flex';
};

document.getElementById('btn-cancel-upload').onclick = () => {
    document.getElementById('uploadModal').style.display = 'none';
};

document.getElementById('btn-close-preview').onclick = () => {
    document.getElementById('previewModal').style.display = 'none';
};

window.processUpload = async () => {
    const user = auth.currentUser;
    const selectedForm = document.getElementById('formSelector').value;
    const fileInput = document.getElementById('fileInput');

    if (!user) return alert("Not authenticated.");
    if (!fileInput.files[0]) return alert("Please select a file!");

    const existingDoc = currentStudentDocs[selectedForm];
    if (existingDoc && (existingDoc.status === "Pending Approval" || existingDoc.status === "Approved")) {
        return alert("This document is already under review or approved.");
    }

    if (fileInput.files[0].size > 5 * 1024 * 1024) {
        return alert("File too large. Max 5MB.");
    }

    const btn = document.querySelector('.btn-primary');
    if (btn) {
        btn.disabled = true;
        btn.innerText = "Uploading…";
    }

    try {
        // ✅ FETCH USER DATA FIRST
        const userSnap = await getDoc(doc(db, "users", user.uid));
        if (!userSnap.exists()) {
            throw new Error("User data not found.");
        }

        const userData = userSnap.data();

        const batchId = userData?.batchId || userData?.batch || null;
        if (!batchId) {
            showToast("Upload blocked: No adviser assigned yet.");
            return;
        }

        // ✅ FETCH BATCH DATA
        const batchRef = doc(db, "batches", batchId);
        const batchSnap = await getDoc(batchRef);

        if (!batchSnap.exists()) {
            throw new Error("Batch not found.");
        }

        const batchData = batchSnap.data();

        const adviserUid =
            batchData?.supervisorId ||
            batchData?.adviserId ||
            batchData?.teacherId ||
            null;

        const studentName =
            userData?.name ||
            `${userData?.firstName || ''} ${userData?.surname || ''}`.trim() ||
            "Student";

        const file = fileInput.files[0];

        const base64File = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });

        const fileName = file.name;
        const dateStr = new Date().toLocaleDateString('en-US', {
            month: 'short',
            day: '2-digit',
            year: 'numeric'
        });

        // ✅ SAVE DOCUMENT
        await setDoc(doc(db, "checklist", `${user.uid}_${selectedForm}`), {
            uid: user.uid,
            studentName,
            formKey: selectedForm,
            fileData: base64File,
            fileName,
            dateSubmitted: dateStr,
            status: "Pending Approval",
            remarks: "Waiting for review",
            timestamp: serverTimestamp(),
            dismissedBy: [],
        });

        // ✅ NOTIFY ADVISER
        if (adviserUid) {
            await notifyDocumentSubmittedToAdviser(
                adviserUid,
                studentName,
                selectedForm
            );
        }

        showToast("Document submitted and sent to your adviser.");
        document.getElementById('uploadModal').style.display = 'none';
        fileInput.value = '';

    } catch (err) {
        console.error('[Checklist] Upload failed:', err);
        alert("Upload failed: " + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Submit File";
        }
    }
};