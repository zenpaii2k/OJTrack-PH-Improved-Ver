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
let unsubscribeChecklist = null;

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
protectPage('student').then(async (user) => {
    if (!user) return;

    const hasBatch = await loadUserProfile(user);

    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid); 

    if (hasBatch) {
        listenToChecklist(user.uid);
    } else {
        clearChecklistUI();
    }

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
});

// ─── USER PROFILE ────────────────────────────────────────────
async function loadUserProfile(user) {
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) return false;

        const data = snap.data();
        const batchId = data?.batchId || data?.batch || null;

        const name =
            data.name ||
            `${data.firstName || ''} ${data.surname || ''}`.trim() ||
            'Student';

        populateHeaderUser(name, user.email);

        if (!batchId) {
            showNoBatchState(user, data);
            return false;
        }

        return true; 
    } catch (e) {
        console.error('[Checklist] loadUserProfile:', e);
        return false;
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

    // INSERT BELOW HEADER (like attendance page)
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

    if (unsubscribeChecklist) {
        unsubscribeChecklist();
    }

    const tbody = document.getElementById('checklist-tbody');
    const progressBar = document.getElementById('overall-progress-bar');
    const completionText = document.getElementById('completion-text');

    const q = query(
        collection(db, "checklist"),
        where("uid", "==", uid)
    );

    unsubscribeChecklist = onSnapshot(q, (snapshot) => {
        currentStudentDocs = {};
        let approvedCount = 0;
        const totalDocs = allDocKeys.length;

        snapshot.docs.forEach(d => {
            const data = d.data();
            currentStudentDocs[data.formKey] = { ...data, docId: d.id };
            if (data.status === "Approved") approvedCount++;
        });

        const percentage = totalDocs > 0
            ? Math.round((approvedCount / totalDocs) * 100)
            : 0;

        if (progressBar) progressBar.style.width = `${percentage}%`;
        if (completionText) {
            completionText.textContent =
                `${approvedCount} of ${totalDocs} documents approved (${percentage}%)`;
        }

        if (!tbody) return;
        tbody.innerHTML = "";

        // render sections...
        const formsHeader = document.createElement('tr');
        formsHeader.className = 'section-divider';
        formsHeader.innerHTML = `<td colspan="4">📄 Forms</td>`;
        tbody.appendChild(formsHeader);

        docOptions["Forms"].forEach(opt => renderChecklistRow(opt, tbody, uid));

        const reqsHeader = document.createElement('tr');
        reqsHeader.className = 'section-divider';
        reqsHeader.innerHTML = `<td colspan="4">📋 Requirements</td>`;
        tbody.appendChild(reqsHeader);

        docOptions["Requirements"].forEach(opt => renderChecklistRow(opt, tbody, uid));

    }, err => console.error('[Checklist] listener error:', err));
}

function clearChecklistUI() {
    // stop firestore listener
    if (unsubscribeChecklist) {
        unsubscribeChecklist();
        unsubscribeChecklist = null;
    }

    // reset local state
    currentStudentDocs = {};

    // clear table
    const tbody = document.getElementById('checklist-tbody');
    if (tbody) tbody.innerHTML = "";

    // reset progress bar
    const progressBar = document.getElementById('overall-progress-bar');
    if (progressBar) progressBar.style.width = "0%";

    const completionText = document.getElementById('completion-text');
    if (completionText) {
        completionText.textContent = "No active batch assigned.";
    }
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

// ─── GLOBAL FUNCTIONS ───────────────

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

function dataUriToBlobUrl(dataUri) {
    const [meta, base64Data] = dataUri.split(';base64,');
    const mimeType  = meta.replace('data:', '');
    const byteChars = atob(base64Data);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
        byteArray[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteArray], { type: mimeType });
    return URL.createObjectURL(blob);
}
 
/**
 * Extracts the MIME type from a data URI.
 * @param {string} dataUri
 * @returns {string}  e.g. "application/pdf", "image/jpeg"
 */
function getMimeType(dataUri) {
    const match = dataUri.match(/^data:([^;]+);/);
    return match ? match[1] : '';
}
 
// Track the current blob URL so we can revoke it when the modal closes
// (prevents memory leaks from large PDF blobs).
let _currentBlobUrl = null;
 
/**
 * Fixed previewDoc — handles PDF, image, and unsupported file types.
 *
 * @param {string} docId  The docId stored in currentStudentDocs
 */
window.previewDoc = (docId) => {
    const modal     = document.getElementById('previewModal');
    const container = document.getElementById('previewContainer');
 
    if (!modal || !container) {
        console.error('[previewDoc] Modal or container element not found.');
        return;
    }
 
    const docData = Object.values(currentStudentDocs).find(d => d.docId === docId);
 
    if (!docData?.fileData) {
        alert('No file available to preview.');
        return;
    }
 
    // Revoke any previous blob URL to free memory
    if (_currentBlobUrl) {
        URL.revokeObjectURL(_currentBlobUrl);
        _currentBlobUrl = null;
    }
 
    // Clear previous content
    container.innerHTML = '';
    container.className = ''; // reset is-image class
 
    const mimeType = getMimeType(docData.fileData);
 
    // ── IMAGES (JPG, PNG, GIF, WEBP) ─────────────────────────
    if (mimeType.startsWith('image/')) {
        container.classList.add('is-image');
 
        const img = document.createElement('img');
        img.src       = docData.fileData;   // data URI is fine for images
        img.alt       = docData.fileName || 'Preview';
        img.className = 'preview-img';
 
        // Remove old inline styles that might constrain the image
        img.style.maxWidth = '100%';
 
        container.appendChild(img);
        modal.style.display = 'flex';
        return;
    }
 
    // ── PDFs ──────────────────────────────────────────────────
    if (mimeType === 'application/pdf') {
        // Convert data URI → Blob URL for iOS Safari compatibility.
        // data: URIs for PDFs render blank in all iOS browsers.
        // Blob URLs work correctly everywhere.
        try {
            _currentBlobUrl = dataUriToBlobUrl(docData.fileData);
        } catch (err) {
            console.error('[previewDoc] Blob URL creation failed:', err);
            _currentBlobUrl = docData.fileData; // fallback to data URI
        }
 
        // Use <embed> instead of <iframe> for PDFs.
        // <embed> is the W3C-recommended element for PDF embedding
        // and has better multi-page support in Chrome and Firefox.
        // It also respects the container's CSS dimensions properly.
        const embed = document.createElement('embed');
        embed.src   = _currentBlobUrl;
        embed.type  = 'application/pdf';
        embed.style.cssText = 'width:100%;height:100%;border:none;';
 
        // iOS fallback: <embed> also doesn't work on iOS Safari.
        // Show a download link inside the container alongside the embed.
        const iosFallback = document.createElement('div');
        iosFallback.className = 'ios-pdf-fallback';
        iosFallback.style.cssText = `
            display: none;
            padding: 20px;
            text-align: center;
            color: var(--text-secondary);
            font-size: 0.88rem;
        `;
        iosFallback.innerHTML = `
            <p style="margin-bottom:12px;">
                📱 PDF preview is not supported on this device's browser.
            </p>
            <a href="${_currentBlobUrl}"
               download="${docData.fileName || 'document.pdf'}"
               style="
                   display:inline-block;
                   padding:10px 20px;
                   background:var(--brand-gold);
                   color:#000;
                   border-radius:8px;
                   text-decoration:none;
                   font-weight:700;
               ">
               ⬇ Download PDF
            </a>`;
 
        // Detect iOS (all iOS browsers use WebKit and can't embed PDFs)
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
                    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
 
        if (isIOS) {
            // On iOS, skip the embed and only show the download link
            iosFallback.style.display = 'block';
            container.appendChild(iosFallback);
        } else {
            container.appendChild(embed);
            container.appendChild(iosFallback); // hidden, won't show on desktop
        }
 
        modal.style.display = 'flex';
        return;
    }
 
    // ── UNSUPPORTED FORMATS (DOCX, XLSX, PPTX, etc.) ─────────
    // Browsers cannot render Office documents natively.
    // Show a download button instead of a blank iframe.
    const fileName = docData.fileName || 'document';
 
    try {
        _currentBlobUrl = dataUriToBlobUrl(docData.fileData);
    } catch {
        _currentBlobUrl = docData.fileData;
    }
 
    container.classList.add('is-image'); // use static positioning
    container.innerHTML = `
        <div style="
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 32px;
            text-align: center;
            gap: 16px;
            height: 100%;
            min-height: 200px;
        ">
            <div style="font-size: 3rem;">📄</div>
            <p style="color: var(--text-primary); font-weight: 600;">
                ${fileName}
            </p>
            <p style="color: var(--text-secondary); font-size: 0.84rem;">
                This file type (${mimeType || 'unknown'}) cannot be previewed in the browser.
            </p>
            <a href="${_currentBlobUrl}"
               download="${fileName}"
               style="
                   padding: 10px 24px;
                   background: var(--brand-gold);
                   color: #000;
                   border-radius: 8px;
                   text-decoration: none;
                   font-weight: 700;
                   font-size: 0.9rem;
               ">
               ⬇ Download File
            </a>
        </div>`;
 
    modal.style.display = 'flex';
};

document.getElementById('btn-close-preview')?.addEventListener('click', () => {
    document.getElementById('previewModal').style.display = 'none';
    if (_currentBlobUrl) {
        URL.revokeObjectURL(_currentBlobUrl);
        _currentBlobUrl = null;
    }
    const container = document.getElementById('previewContainer');
    if (container) {
        container.innerHTML = '';
        container.className = '';
    }
});

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