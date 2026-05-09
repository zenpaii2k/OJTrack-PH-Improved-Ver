import { protectPage } from "../authguard.js";
import { db, auth } from "../firebase-config.js";
import { signOut} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    updateDoc, collection, query, where, onSnapshot, doc, getDoc, getDocs, addDoc, serverTimestamp, orderBy, limit 
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
  clearAllNotifications, notifyAdviserFeedback, notifyLogApproved, notifyLogRejected} from '../js/notifications.js';

initTheme();

const nameCache = {}; 
let state = {
    attendance: [],
    documents: [],
    myStudentUids: new Set()
};

let loggedDates = new Map();
let currentCalMonth = new Date();
let activeStudentUid = null;
let unsubscribeAttendance = null;
let unsubscribeStudentLogs = null;

protectPage('supervisor').then((user) => {

    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);

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

        fetchUserProfile(user);      
        renderCalendar(currentCalMonth);
        initCombinedRealTimeDashboard(user); 
        setupInteractions(user);      
        initDashboard(); 
});

function initCombinedRealTimeDashboard(user) {

    updateTotalStats(user).then((uids) => {
        state.myStudentUids = uids;
    });
}

function buildLogCard(id, log) {
     const date  = log.displayDate || formatTimestamp(log.timestamp);  
   const tIn   = log.timeIn  || '—';
     const tOut  = log.timeOut || '—';
    const hours = computeHoursDecimal(tIn, tOut).toFixed(2);
    const status = log.status || 'Pending';

    const statusBadge =
         status === 'Approved' ? '<span class="badge badge-success">Approved</span>' :
        status === 'Rejected' ? '<span class="badge badge-danger">Rejected</span>' :
                          '<span class="badge badge-warning">Pending</span>';

     const hasFile = log.attachment; 
     const fileBtn = hasFile
         ? `<button class="view-btn" onclick="openFile('${id}')">View</button>`
        : '';

    return `
      <div class="log-card-item">
         <span class="log-time">${tIn} → ${tOut}</span>
        <span>${hours}h</span>
         ${statusBadge}
        ${fileBtn}
       </div>`;
}

// Helper to keep the safeguard active
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

async function getStudentName(uid) {
     if (nameCache[uid]) return nameCache[uid];
    const snap = await getDoc(doc(db, "users", uid));
    let name = "Unknown";
    if (snap.exists()) {
        const d = snap.data();
        name = d.name || `${d.firstName || ''} ${d.surname || ''}`.trim() || "Student";

    }
     nameCache[uid] = name;
    return name;
 }

window.dismissSingleNotif = async (id, uid, type) => {
    try {
        const collectionName = type === "attendance" ? "attendance" : "checklist";
        const ref = doc(db, collectionName, id);

        await updateDoc(ref, {
            dismissedBy: arrayUnion(uid)
        });

    } catch (err) {
        console.error("Dismiss error:", err);
    }
};

// Initialize Dashboard Logic
function initDashboard() {
    const select = document.getElementById('section-select');
    const backBtn = document.getElementById('back-to-list');

    if (select) {
        // Load the batches
        loadBatchDropdown();
        
        select.onchange = (e) => {
            if (e.target.value) {
                loadStudentList(e.target.value);
            }
        };
    }

    if (backBtn) {
        backBtn.onclick = () => {
            document.getElementById('student-list-view').style.display = 'block';
            document.getElementById('student-detail-view').style.display = 'none';
        };
    }
}

// Load Specific Batches
async function loadBatchDropdown() {
    const select = document.getElementById('section-select');
    if (!select) return;

    select.innerHTML = '<option value="" disabled selected>Loading your batches...</option>';

    try {
        const user = auth.currentUser;
        if (!user) return;
        
        const q = query(
            collection(db, "batches"), 
            where("supervisorId", "==", user.uid)
        );

        const querySnapshot = await getDocs(q);
        
        // Reset the dropdown
        select.innerHTML = '<option value="" selected>-- Select a Batch --</option>';

        if (querySnapshot.empty) {
            select.innerHTML = '<option value="">No batches created yet</option>';
            return;
        }

        querySnapshot.forEach((docSnap) => {
            const batch = docSnap.data();
            const option = document.createElement('option');
            option.value = docSnap.id;

            option.innerHTML = batch.name || `Batch ${docSnap.id.substring(0,5)}`;
            select.appendChild(option);
        });

        console.log(`Successfully loaded ${querySnapshot.size} batches.`);
        
    } catch (error) {
        console.error("Batch Dropdown Error:", error);
        select.innerHTML = '<option value="">Error loading batches</option>';
    }
}

function setupInteractions(user) {
    const prevBtn = document.getElementById('prevMonth');
    const nextBtn = document.getElementById('nextMonth');

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            currentCalMonth = new Date(
                currentCalMonth.getFullYear(),
                currentCalMonth.getMonth() - 1,
                1
            );
            renderCalendar(currentCalMonth);
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            currentCalMonth = new Date(
                currentCalMonth.getFullYear(),
                currentCalMonth.getMonth() + 1,
                1
            );
            renderCalendar(currentCalMonth);
        });
    }
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

            populateHeaderUser(fullName, user.email);
        }
    } catch (e) {
        console.error("Profile Error:", e);
    }
}

async function loadStudentList(batchId) {
    const container = document.getElementById('student-rows-container');
    container.innerHTML = '<div class="loading-text">Loading students...</div>';

    try {
        const batchSnap = await getDoc(doc(db, "batches", batchId));

        if (!batchSnap.exists()) {
            container.innerHTML = 'Batch not found';
            return;
        }

        const studentUids = batchSnap.data().studentUids || [];

        if (studentUids.length === 0) {
            container.innerHTML = '<div class="empty-text">No students in this batch</div>';
            return;
        }

        const chunks = [];
        for (let i = 0; i < studentUids.length; i += 10) {
            chunks.push(studentUids.slice(i, i + 10));
        }

        const allStudents = [];

        for (const chunk of chunks) {
            const q = query(
                collection(db, "users"),
                where("__name__", "in", chunk)
            );

            const snap = await getDocs(q);
            snap.forEach(doc => {
                allStudents.push({ id: doc.id, ...doc.data() });
            });
        }

        container.innerHTML = "";

        if (allStudents.length === 0) {
            container.innerHTML = '<div class="empty-text">No student records found</div>';
            return;
        }

        allStudents.forEach(student => {
            const row = document.createElement('div');
            row.className = 'student-row';

            row.innerHTML = `
                <div class="student-info" style="display:flex;justify-content:space-between;width:100%;">
                    <span>${student.name}</span>
                    <span>${student.course || ''}-${student.section || ''}</span>
                </div>
            `;

            row.onclick = () => viewStudentDetails(student.id, student);
            container.appendChild(row);
        });

    } catch (err) {
        console.error(err);
        container.innerHTML = '<div class="error-text">Failed to load students</div>';
    }
}

// handle "approved" hours calculation
async function viewStudentDetails(docId, studentData) {
    document.getElementById('student-list-view').style.display = 'none';
    document.getElementById('student-detail-view').style.display = 'block';
    
    activeStudentUid = studentData.uid || docId;

    document.getElementById('selected-student-display').innerText =
        `${studentData.name} - OJT Progress`;

    const logContainer = document.getElementById('log-cards-container');

    if (unsubscribeStudentLogs) {
        unsubscribeStudentLogs();
    }

    const logQuery = query(
        collection(db, "attendance"),
        where("uid", "==", activeStudentUid), 
        orderBy("timestamp", "desc")
    );

    const requiredHours = studentData.requiredHours || 600;

    unsubscribeStudentLogs = onSnapshot(logQuery, (snapshot) => {
        logContainer.innerHTML = "";
        loggedDates.clear(); 
        
        let totalApprovedMinutes = 0;

        if (snapshot.empty) {
            logContainer.innerHTML = "<p style='color:#888; padding:20px;'>No logs found for this student.</p>";
            updateProgressBar(0, requiredHours);
            renderCalendar(currentCalMonth);
            return;
        }

        snapshot.forEach((logDoc) => {
            const log = logDoc.data();
            const logId = logDoc.id;
            const status = log.status || "Pending";
            
            loggedDates.set(log.displayDate, status);

            if (status === "Approved" && log.timeIn && log.timeOut) {
                totalApprovedMinutes += calculateMinutes(log.timeIn, log.timeOut);
            }

            const isLocked = status !== "Pending";
            const card = document.createElement('div');
            card.className = "log-review-card";

            card.innerHTML = `
                <div class="log-card-inner" style= padding:15px; border-radius:8px; margin-bottom:12px; border-left: 5px solid ${status === 'Approved' ? '#90EE90' : status === 'Rejected' ? '#e74c3c' : '#CC9704'};">
                    <div style="display:flex; align-items:flex-start; gap:15px;">
                        <div style="flex:1; min-width:0;">
                            <div style="display:flex; align-items:center; gap:10px;">
                                <strong style="color:#CC9704 font-size: 1.1rem;">${log.displayDate}</strong>
                                <span style="font-size:0.65rem; padding:3px 8px; border-radius:12px; background:${status === 'Approved' ? '#90EE90' : status === 'Rejected' ? '#e74c3c' : '#CC9704'}; color:${status === 'Pending' ? '#000' : '#fff'}; font-weight:bold;">
                                    ${status.toUpperCase()}
                                </span>
                            </div>

                            <div style="color:#aaa; font-size:0.85rem; margin-top:8px;">
                                <span style="background: rgba(255,212,0,0.1); color: #CC9704; padding: 2px 6px; border-radius: 4px; font-weight: bold;">
                                    🕒 ${log.timeIn} — ${log.timeOut}
                                </span>
                                ${status === "Approved" ? `<span style="color:#2ecc71; margin-left:10px; font-weight: bold;">(+${(calculateMinutes(log.timeIn, log.timeOut)/60).toFixed(1)} hrs)</span>` : ''}
                            </div>

                            <div class="log-note-box" style="margin-top:12px; padding:10px; background: rgba(255,255,255,0.05); border-radius: 6px; border-left: 3px solid #444;">
                                <small style="display:block; color:#888; margin-bottom:4px; font-size:0.7rem; text-transform:uppercase;">Daily Accomplishment Note:</small>
                                <p style="margin:0; font-size:0.9rem; color:#888; line-height:1.4;">
                                    ${log.note || "<em>No accomplishment notes provided for this log.</em>"}
                                </p>
                                ${log.attachment ? `
                            <button onclick="openAttachmentModal('${log.attachment}')"
                                style="background:#3498db; color:white; border:none; padding:6px 12px; border-radius:5px; cursor:pointer; font-size:0.75rem;">
                                View Attachment
                            </button>
                        ` : ''}
                            </div>

                        <div class="log-actions" style="
                                display:flex;
                                flex-direction:column;
                                gap:8px;
                                flex-shrink:0;
                                width:120px;
                            ">
                            ${!isLocked ? `
                                <button onclick="confirmLogAction('${logId}', 'Approved', '${activeStudentUid}', '${log.displayDate}')"
                                    style="width:100%; box-sizing:border-box; background:#2ecc71; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer; font-weight:bold; font-size: 0.8rem;">
                                    Approve
                                </button>
                                <button onclick="confirmLogAction('${logId}', 'Rejected', '${activeStudentUid}', '${log.displayDate}')" 
                                    style="width:100%; box-sizing:border-box; background:#e74c3c; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer; font-weight:bold; font-size: 0.8rem;">
                                    Reject
                                </button>
                            ` : `
                                <button onclick="revertToPending('${logId}')" 
                                    style="background:transparent; border:1px solid #444; color:#888; padding:5px 10px; border-radius:5px; cursor:pointer; font-size:0.7rem;">
                                    Revert to Pending
                                </button>
                            `}
                        </div>
                    </div>
                </div>
            `;
            logContainer.appendChild(card);
        });

        const approvedHours = (totalApprovedMinutes / 60).toFixed(1);
        updateProgressBar(approvedHours, requiredHours);
        renderCalendar(currentCalMonth);
    });
}

let _currentAttachmentBlobUrl = null;

window.openAttachmentModal = function(fileData) {

    if (!fileData) {
        alert('No attachment available.');
        return;
    }

    // Create modal dynamically
    let modal = document.getElementById('previewModal');

    if (!modal) {

        const HEADER_HEIGHT = 100;

        modal = document.createElement('div');

        modal.id = 'previewModal';

        modal.style.cssText = `
            position:fixed;
            top:${HEADER_HEIGHT}px;
            left:0;
            right:0;
            bottom:0;
            background:rgba(0,0,0,.78);
            display:flex;
            align-items:center;
            justify-content:center;
            z-index:9999;
            padding:20px;
            box-sizing:border-box;
        `;

        modal.innerHTML = `
            <div id="previewBox"
                style="
                    position:relative;
                    width:min(1000px,95vw);
                    height:min(calc(100vh - ${HEADER_HEIGHT + 40}px), 900px);
                    background:#111;
                    border-radius:14px;
                    overflow:hidden;
                    box-shadow:0 12px 40px rgba(0,0,0,.45);
                ">

                <button id="closePreviewBtn"
                    style="
                        position:absolute;
                        top:12px;
                        right:12px;
                        width:42px;
                        height:42px;
                        border:none;
                        border-radius:50%;
                        background:rgba(255,255,255,.18);
                        color:#fff;
                        cursor:pointer;
                        z-index:999999;
                        font-size:1rem;
                        backdrop-filter:blur(4px);
                    ">
                    ✕
                </button>

                <div id="previewContainer"
                    style="
                        width:100%;
                        height:100%;
                        background:#1a1a1a;
                    ">
                </div>

            </div>
        `;

        document.body.appendChild(modal);

        document
            .getElementById('closePreviewBtn')
            .addEventListener('click', closeAttachmentModal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeAttachmentModal();
            }
        });
    }

    modal.style.display = 'flex';

    const container = document.getElementById('previewContainer');

    // Cleanup previous blob
    if (_currentAttachmentBlobUrl) {
        URL.revokeObjectURL(_currentAttachmentBlobUrl);
        _currentAttachmentBlobUrl = null;
    }

    container.innerHTML = '';
    container.style.paddingTop = '0';
    container.style.display = 'block';

    // Detect mime type
    const mimeType = getMimeType(fileData);

    // ─────────────────────────────
    // IMAGE
    // ─────────────────────────────

    if (mimeType.startsWith('image/')) {

        container.style.display = 'flex';
        container.style.alignItems = 'center';
        container.style.justifyContent = 'center';

        const img = document.createElement('img');

        img.src = fileData;

        img.style.maxWidth = '100%';
        img.style.maxHeight = '100%';
        img.style.objectFit = 'contain';

        container.appendChild(img);

        return;
    }

    // ─────────────────────────────
    // PDF
    // ─────────────────────────────

    if (mimeType === 'application/pdf') {

        try {
            _currentAttachmentBlobUrl = dataUriToBlobUrl(fileData);
        } catch (err) {
            console.error(err);
            _currentAttachmentBlobUrl = fileData;
        }

        const isIOS =
            /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' &&
             navigator.maxTouchPoints > 1);

        // iOS fallback
        if (isIOS) {

            container.innerHTML = `
                <div style="
                    display:flex;
                    flex-direction:column;
                    align-items:center;
                    justify-content:center;
                    height:100%;
                    padding:32px;
                    text-align:center;
                    gap:16px;
                    color:white;
                ">

                    <div style="font-size:3rem;">📄</div>

                    <p>
                        PDF preview is not supported
                        on this browser.
                    </p>

                    <a href="${_currentAttachmentBlobUrl}"
                       download="document.pdf"
                       style="
                            display:inline-block;
                            padding:10px 24px;
                            background:#f5c542;
                            color:#000;
                            border-radius:8px;
                            text-decoration:none;
                            font-weight:700;
                       ">
                        ⬇ Download PDF
                    </a>

                </div>
            `;

        } else {

            // Important fix for overlapping browser PDF toolbar
            container.style.paddingTop = '56px';
            container.style.boxSizing = 'border-box';
            container.style.background = '#222';

            const embedWrap = document.createElement('div');

            embedWrap.style.width = '100%';
            embedWrap.style.height = '100%';
            embedWrap.style.overflow = 'hidden';

            const embed = document.createElement('embed');

            embed.src =
                _currentAttachmentBlobUrl +
                '#toolbar=1&navpanes=0&scrollbar=1';

            embed.type = 'application/pdf';

            embed.style.width = '100%';
            embed.style.height = '100%';
            embed.style.border = 'none';
            embed.style.display = 'block';
            embed.style.background = '#fff';

            embedWrap.appendChild(embed);

            container.appendChild(embedWrap);
        }

        return;
    }

    // ─────────────────────────────
    // OTHER FILES
    // ─────────────────────────────

    try {
        _currentAttachmentBlobUrl =
            dataUriToBlobUrl(fileData);

    } catch {
        _currentAttachmentBlobUrl = fileData;
    }

    container.innerHTML = `
        <div style="
            display:flex;
            flex-direction:column;
            align-items:center;
            justify-content:center;
            height:100%;
            padding:32px;
            text-align:center;
            gap:16px;
            color:white;
        ">

            <div style="font-size:3rem;">📄</div>

            <p>
                This file type cannot
                be previewed in the browser.
            </p>

            <a href="${_currentAttachmentBlobUrl}"
               download="document"
               style="
                    padding:10px 24px;
                    background:#f5c542;
                    color:#000;
                    border-radius:8px;
                    text-decoration:none;
                    font-weight:700;
               ">
                ⬇ Download File
            </a>

        </div>
    `;
};

window.closeAttachmentModal = function() {

    const modal = document.getElementById('previewModal');

    if (modal) {
        modal.style.display = 'none';
    }

    const container = document.getElementById('previewContainer');

    if (container) {
        container.innerHTML = '';
    }

    // Cleanup blob
    if (_currentAttachmentBlobUrl) {
        URL.revokeObjectURL(_currentAttachmentBlobUrl);
        _currentAttachmentBlobUrl = null;
    }
};

function getMimeType(dataUri) {

    if (!dataUri ||
        typeof dataUri !== 'string') {
        return '';
    }

    const match =
        dataUri.match(/^data:(.*?);base64,/);

    return match ? match[1] : '';
}

function dataUriToBlobUrl(dataUri) {

    const [meta, base64] =
        dataUri.split(';base64,');

    const mime =
        meta.split(':')[1] ||
        'application/octet-stream';

    const byteChars = atob(base64);

    const byteArray =
        new Uint8Array(byteChars.length);

    for (let i = 0; i < byteChars.length; i++) {
        byteArray[i] =
            byteChars.charCodeAt(i);
    }

    const blob = new Blob([byteArray], {
        type: mime
    });

    return URL.createObjectURL(blob);
}

// Helper to update the Progress UI
function updateProgressBar(approved, required) {
    const totalHoursDisp = document.getElementById('total-hours');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

    if (totalHoursDisp) totalHoursDisp.innerText = `${approved} HRS`;
    
    const percentage = Math.min((approved / required) * 100, 100);
    if (progressBar) progressBar.style.width = `${percentage}%`;
    if (progressText) progressText.innerText = `Verified: ${approved} / ${required} target hours`;
}

// Helper for time calculation
function calculateMinutes(t1, t2) {
    const parse = (s) => {
        try {
            let [time, mod] = s.split(' ');
            let [h, m] = time.split(':').map(Number);
            if (h === 12) h = 0;
            if (mod === 'PM') h += 12;
            return h * 60 + m;
        } catch (e) { return 0; }
    };
    return parse(t2) - parse(t1);
}

// Allow the adviser to fix a mistake
window.revertToPending = async (logId) => {
    if(confirm("Revert this log to pending? This will remove the hours from the approved total.")) {
        await updateDoc(doc(db, "attendance", logId), { status: "Pending" });
    }
};

function renderCalendar(date) {
    const calGrid = document.getElementById('mini-calendar');
    const monthDisplay = document.getElementById('monthDisplay');
    if (!calGrid || !monthDisplay) return;

    calGrid.innerHTML = '';
    const year = date.getFullYear();
    const month = date.getMonth();
    const today = new Date();

    monthDisplay.innerText = date.toLocaleString('default', { month: 'long', year: 'numeric' });

    ['S','M','T','W','T','F','S'].forEach(d => {
        const el = document.createElement('b');
        el.innerText = d;
        calGrid.appendChild(el);
    });

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) calGrid.appendChild(document.createElement('div'));

    for (let i = 1; i <= daysInMonth; i++) {
        const dayEl = document.createElement('div');
        dayEl.innerText = i;
        dayEl.className = "calendar-day"; // Ensure CSS handles padding/cursor

        const currentIterDate = new Date(year, month, i);
        const fullDateStr = currentIterDate.toDateString(); 
        
        const status = loggedDates.get(fullDateStr);
        const isToday = i === today.getDate() && month === today.getMonth() && year === today.getFullYear();

        if (isToday) dayEl.style.border = "2px solid #CC9704";

        if (status === "Approved") {
            dayEl.style.background = "#2ecc71";
            dayEl.style.color = "#fff";
        } else if (status === "Rejected") {
            dayEl.style.background = "#e74c3c";
            dayEl.style.color = "#fff";
        } else if (status === "Pending") {
            dayEl.style.background = "#CC9704";
            dayEl.style.color = "#000";
        }
        calGrid.appendChild(dayEl);
    }
}

window.confirmLogAction = async (logId, status, studentUid, date) => {
    if (confirm(`Are you sure you want to mark this log as ${status}? This action cannot be undone.`)) {
        await updateLogStatus(logId, status, studentUid, date);
    }
};

window.updateLogStatus = async (logId, newStatus, studentUid, date) => {
    try {
        const logRef = doc(db, "attendance", logId);
        const docSnap = await getDoc(logRef);

        if (docSnap.exists() && docSnap.data().status && docSnap.data().status !== "Pending") {
            alert("This log has already been processed and cannot be changed.");
            return;
        }

        await updateDoc(logRef, { 
            status: newStatus,
            reviewedAt: serverTimestamp() 
        });

        const userSnap = await getDoc(doc(db, "users", auth.currentUser.uid));
        const uData = userSnap.data() || {};

        const adviserName =
            uData.name ||
            `${uData.firstName || ''} ${uData.surname || ''}`.trim() ||
            "Adviser";

        await handleLogDecision(studentUid, date, adviserName, newStatus);

    } catch (e) {
        alert("Error updating status: " + e.message);
    }
};

const saveRemarksBtn = document.getElementById('save-remarks-btn');
if (saveRemarksBtn) {
    saveRemarksBtn.onclick = async () => {
        const text = document.getElementById('student-remarks').value;

        if (!activeStudentUid) return alert("No student selected.");
        if (!text.trim()) return alert("Please enter remarks first.");

        try {
            const userRef = doc(db, "users", auth.currentUser.uid);
            const userSnap = await getDoc(userRef);
            const sData = userSnap.data() || {};

            const adviserName =
                sData.name ||
                `${sData.firstName || ''} ${sData.surname || ''}`.trim() ||
                "Adviser";

            await addDoc(collection(db, "students", activeStudentUid, "feedback"), {
                senderName: adviserName,
                senderRole: sData.position || "OJT Adviser",
                message: text,
                subject: "Adviser Evaluation",
                timestamp: serverTimestamp()
            });

            await notifyAdviserFeedback(activeStudentUid, adviserName);

            alert("Feedback sent successfully!");
            document.getElementById('student-remarks').value = "";

        } catch (e) {
            console.error(e);
            alert("Error: " + e.message);
        }
    };
}

async function handleLogDecision(studentUid, date, adviserName, decision, reason = "") {
    try {
        if (decision === "Approved") {
            await notifyLogApproved(studentUid, date, adviserName);
        }

        if (decision === "Rejected") {
            await notifyLogRejected(studentUid, date, adviserName, reason);
        }
    } catch (e) {
        console.error("Notification error:", e);
    }
}

