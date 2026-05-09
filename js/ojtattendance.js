import { protectPage } from '../authguard.js';
import { auth, db } from '../firebase-config.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, addDoc, query, where, onSnapshot,
    serverTimestamp, orderBy, doc, getDoc, limit
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, formatTimestamp
} from '../js/theme.js';
import { setupNotificationSystem,
  sendNotification,
  markAllRead,
  clearAllNotifications, notifyLogSubmittedToAdviser} from '../js/notifications.js';

// ─── INIT ────────────────────────────────────────────────────
initTheme();

let currentCalMonth = new Date();
let userData = null;
let loggedDateMap = new Map(); // key → status
let attendanceUnsub = null;
let isOjtComplete = false;

// ─── AUTH ────────────────────────────────────────────────────
protectPage('student').then(async (user) => {

    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);
    setupLogout();

    const isValid = await loadUserProfile(user);

    if (!isValid) return;

    listenToAttendanceLogs(user.uid);
    renderCalendar(currentCalMonth);
    setupCalendarNav();
    setupForm(user);
    setupNowButtons();
    setupHoursPreview();
    setupFileLabel();

    const dateEl = document.getElementById('current-date-display');
    if (dateEl) {
        dateEl.textContent = `📅 ${new Date().toLocaleDateString('en-PH', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        })}`;
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

// ─── USER PROFILE ────────────────────────────────────────────
async function loadUserProfile(user) {
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) return;

        userData = snap.data();

        const batchId = userData?.batchId || userData?.batch || null;

        if (!batchId) {
            showNoBatchState(user, userData);
            return false;
        }

        const name = userData.name
            || `${userData.firstName || ''} ${userData.surname || ''}`.trim()
            || 'Student';

        populateHeaderUser(name, user.email);

        updateSummary(
            parseFloat(userData.hoursCompleted) || 0,
            parseFloat(userData.requiredHours) || 600
        );

        const required = parseFloat(userData.requiredHours) || 600;
        updateSummary(0, required);

        return true; 

    } catch (e) {
        console.error('[Attendance] loadUserProfile:', e);
        return false;
    }
}

// ─── NOW BUTTONS ─────────────────────────────────────────────
function setupNowButtons() {
    document.getElementById('btn-in-now')?.addEventListener('click',  () => setTimeToNow('in'));
    document.getElementById('btn-out-now')?.addEventListener('click', () => setTimeToNow('out'));
}

window.setTimeToNow = function(prefix) {
    const now  = new Date();
    let h      = now.getHours();
    const m    = now.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;

    setVal(`${prefix}-hour`,   h);
    setVal(`${prefix}-minute`, String(m).padStart(2, '0'));
    const ampmEl = document.getElementById(`${prefix}-ampm`);
    if (ampmEl) ampmEl.value = ampm;
    updateHoursPreview();
};

// ─── HOURS PREVIEW ───────────────────────────────────────────
function setupHoursPreview() {
    ['in-hour','in-minute','in-ampm','out-hour','out-minute','out-ampm'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', updateHoursPreview);
        document.getElementById(id)?.addEventListener('input',  updateHoursPreview);
    });
}

function updateHoursPreview() {
    const tIn  = getTimeString('in');
    const tOut = getTimeString('out');
    if (!tIn || !tOut) return;

    const hours = computeHoursDecimal(tIn, tOut);
    const wrap  = document.getElementById('hours-preview');
    const text  = document.getElementById('hours-preview-text');

    if (wrap && text) {
        if (hours > 0) {
            text.textContent     = `${hours.toFixed(2)} hours computed`;
            wrap.style.display   = 'flex';
        } else {
            wrap.style.display   = 'none';
        }
    }
}

function getTimeString(prefix) {
    const h    = document.getElementById(`${prefix}-hour`)?.value;
    const m    = document.getElementById(`${prefix}-minute`)?.value;
    const ampm = document.getElementById(`${prefix}-ampm`)?.value;
    if (!h || m === undefined || m === '') return null;
    return `${h}:${String(m).padStart(2,'0')} ${ampm}`;
}

// ─── FILE LABEL ───────────────────────────────────────────────
function setupFileLabel() {
    const fileInput = document.getElementById('attendance-file');
    const fileText  = document.getElementById('file-name-text');
    fileInput?.addEventListener('change', () => {
        if (fileInput.files[0]) {
            const name = fileInput.files[0].name;
            if (fileText) fileText.textContent = name.length > 36 ? name.slice(0,33)+'…' : name;
        }
    });
}

// ─── FORM SUBMISSION ──────────────────────────────────────────
function setupForm(user) {
    const form = document.getElementById('attendance-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');

    if (isOjtComplete) {
        showError('Submission blocked. You have completed your required OJT hours.');
        return;
    }

        const tIn  = getTimeString('in');
        const tOut = getTimeString('out');
        if (!tIn || !tOut) {
            showError('Please enter both Time In and Time Out.');
            return;
        }

        const hours = computeHoursDecimal(tIn, tOut);
        if (hours <= 0 || hours > 24) {
            showError('Invalid time range. Time Out must be after Time In.');
            return;
        }

        const note  = sanitizeStr(document.getElementById('attendance-note')?.value || '');
        const today = new Date();
        const displayDate = new Date().toDateString();

        const btn = document.getElementById('submit-log-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

       try {
            const userSnap = await getDoc(doc(db, "users", user.uid));
            if (!userSnap.exists()) {
                throw new Error("User data not found.");
            }

            userData = userSnap.data();
            console.log("USER DATA:", userData);

            const batchId = userData?.batchId || userData?.batch || null;

            const completedHours = parseFloat(userData?.hoursCompleted) || 0;
            const requiredHours  = parseFloat(userData?.requiredHours) || 600;

            if (completedHours >= requiredHours) {
                lockCompletedState(requiredHours, completedHours);
                return;
            }

            const batchRef = doc(db, "batches", batchId);

            if (!batchId) {
                showError("No adviser batch assigned.");
                
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '🕒 Submit Attendance Log';
                }

                return;
            }

            const batchSnap = await getDoc(batchRef);

            if (!batchSnap.exists()) {
                throw new Error("Batch document not found.");
            }

            const batchData = batchSnap.data();
            console.log("BATCH DATA:", batchData);

            const adviserUid =
                batchData?.supervisorId ||
                batchData?.adviserId ||
                batchData?.teacherId ||
                null;

            console.log("ADVISER UID FINAL:", adviserUid);

            const studentName =
                userData?.name ||
                `${userData?.firstName || ''} ${userData?.surname || ''}`.trim() ||
                "Student";

            let attachment = null;
            const fileInput = document.getElementById('attendance-file');

            if (fileInput?.files[0]) {
                const file = fileInput.files[0];

                const MAX_SIZE = 5 * 1024 * 1024; // 5MB safe limit (Firestore-friendly)

                if (file.size > MAX_SIZE) {
                    alert("File too large. Maximum allowed size is 5MB.");

                    if (btn) {
                        btn.disabled = true;
                        btn.textContent = '🕒 Submit Attendance Log';
                    }

                    return;
                }

                attachment = await fileToBase64(file);
            }

            await addDoc(collection(db, 'attendance'), {
                uid: user.uid,
                displayDate,
                timeIn: tIn,
                timeOut: tOut,
                note,
                attachment,
                status: 'Pending',
                timestamp: serverTimestamp(),
                dismissedBy: [],
            });

            if (adviserUid) {
                await notifyLogSubmittedToAdviser(
                    adviserUid,
                    studentName,
                    displayDate, 
                    batchId
                );
            }

            alert("Attendance logged successfully.");

            form.reset();

            document.getElementById('file-name-text') &&
                (document.getElementById('file-name-text').textContent =
                    'Click to choose file — JPG, PNG, PDF, DOCX');

            document.getElementById('hours-preview') &&
                (document.getElementById('hours-preview').style.display = 'none');

                    } catch (err) {
                console.error('[Attendance] submit error:', err);

                if (err.message && err.message.includes('Request payload size exceeds')) {
                    alert("Upload failed: File is too large. Please upload a file under 5MB.");
                } else {
                    showError('Failed to submit. Please try again.');
                }
            }  

            finally {
                try {
                    const freshUserSnap = await getDoc(doc(db, "users", user.uid));
                    if (freshUserSnap.exists()) {
                        userData = freshUserSnap.data(); // update local cache with latest data
                    }
                } catch (e) {
                    console.error("Failed to fetch fresh user data:", e);
                }

                const latestCompleted = parseFloat(userData?.hoursCompleted) || 0;
                const latestRequired  = parseFloat(userData?.requiredHours) || 600;

                if (latestCompleted >= latestRequired) {
                    lockCompletedState(latestRequired, latestCompleted);
                } else if (btn && !window._isOjtLocked) {
                    btn.disabled = false;
                    btn.textContent = '🕒 Submit Attendance Log';
                }
            }
    });
}

function showNoBatchState(user, data) {
    const name =
        data?.name ||
        `${data?.firstName || ''} ${data?.surname || ''}`.trim() ||
        'Student';

    populateHeaderUser(name, user.email);

    // Show a friendly inline notice instead of wiping UI
    const form = document.getElementById('attendance-form');
    const submitBtn = document.getElementById('submit-log-btn');

    if (form) {
        const notice = document.createElement('div');
        notice.className = 'no-batch-notice';
        notice.innerHTML = `
            <div style="
                background: rgba(255, 193, 7, 0.08);
                border: 1px solid rgba(255, 193, 7, 0.25);
                color: var(--text-primary);
                padding: 16px;
                border-radius: 10px;
                margin-bottom: 16px;
                text-align: center;
            ">
                <h3 style="margin-bottom:6px;">No Adviser Assigned Yet</h3>
                <p style="font-size:0.9rem; color:var(--text-muted);">
                    You can view this page, but you cannot submit attendance logs yet.
                    Please wait until your adviser assigns you to a batch.
                </p>
            </div>
        `;

        form.prepend(notice);
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '🚫 Cannot submit (No adviser yet)';
    }

    return false;
}

function lockCompletedState(requiredHours, completedHours) {
    const btn = document.getElementById('submit-log-btn');

    if (btn) {
        btn.disabled = true;
        btn.textContent = '✅ OJT Hours Completed';
    }

    showError(
        `You already completed your required OJT hours.`
    );

    window._isOjtLocked = true;
}

// Ensure month and day are correctly padded for comparison
function makeDateKey(date) {
    const y = date.getFullYear();
    // Use 1-based month for the key to avoid confusion with index 0
    const m = String(date.getMonth() + 1).padStart(2, '0'); 
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ─── REALTIME LOG LISTENER ────────────────────────────────────
// ─── REALTIME LOG LISTENER ────────────────────────────────────
function listenToAttendanceLogs(uid) {
    if (attendanceUnsub) attendanceUnsub();

    const q = query(
        collection(db, 'attendance'),
        where('uid', '==', uid),
        orderBy('timestamp', 'desc'),
        limit(100) // Increase slightly to ensure we capture all logs for calculation
    );

    attendanceUnsub = onSnapshot(q, (snap) => {
        const listEl = document.getElementById('log-list');
        loggedDateMap.clear();

        if (!listEl) return;

        let totalApprovedHours = 0;

        // Process logs and calculate approved hours
        snap.docs.forEach(d => {
            const log = d.data();
            
            // Calculate total approved hours dynamically from the 'attendance' collection
            if (log.status === 'Approved') {
                const hrs = computeHoursDecimal(log.timeIn, log.timeOut);
                totalApprovedHours += hrs;
            }

            // Map calendar dates...
            let dateObj = log.timestamp ? log.timestamp.toDate() : (log.displayDate ? new Date(log.displayDate) : null);
            if (dateObj) {
                const key = dateObj.toDateString();
                const status = (log.status || 'Pending').trim();
                if (loggedDateMap.get(key) !== 'Approved') {
                    loggedDateMap.set(key, status);
                }
            }
        });

        // Get the required hours limit
        const requiredHours = parseFloat(userData?.requiredHours) || 600;

        // Force UI Lock if dynamic hours exceed or equal required hours
        if (totalApprovedHours >= requiredHours) {
            isOjtComplete = true;
            lockCompletedState(requiredHours, totalApprovedHours);
        } else {
            isOjtComplete = false;
            const btn = document.getElementById('submit-log-btn');
            if (btn && userData?.batchId) {
                btn.disabled = false;
                btn.textContent = '🕒 Submit Attendance Log';
                showError(''); 
            }
        }

        listEl.innerHTML = snap.docs.map(d => {
            const log  = d.data();
            const date = sanitizeText(log.displayDate || formatTimestamp(log.timestamp));
            const tIn  = sanitizeText(log.timeIn  || '—');
            const tOut = sanitizeText(log.timeOut || '—');
            const hrs  = computeHoursDecimal(log.timeIn, log.timeOut);
            const hrsStr = hrs > 0 ? `${hrs.toFixed(2)}h` : '—';
            const note = log.note ? sanitizeText(log.note) : '';

            const statusMap = {
                Approved: '<span class="badge badge-success">✅ Approved</span>',
                Rejected: '<span class="badge badge-danger">❌ Rejected</span>',
                Pending:  '<span class="badge badge-warning">⏳ Pending</span>',
            };

            const badge = statusMap[log.status] || statusMap.Pending;
            const hasFile = log.attachment;

            return `
            <div class="log-entry">
                <div class="col-date">${date}</div>
                <div class="col-in">${tIn}</div>
                <div class="col-out">${tOut}</div>
                <div class="col-hours">${hrsStr}</div>
                <div class="col-status">${badge}</div>
                <div class="col-file">
                    ${hasFile
                        ? `<button 
                                class="view-btn"
                                onclick="previewAttendanceAttachment('${sanitizeText(d.id)}')">
                                View
                        </button>`
                        : '<span class="no-file">—</span>'
                    }
                </div>
            </div>
            ${note ? `<div class="log-note">📝 ${note}</div>` : ''}
        `;
        }).join('');

        // Cache logs locally for viewing attachments
        window._attendanceLogs = new Map();
        snap.docs.forEach(d => {
            window._attendanceLogs.set(d.id, d.data());
        });

        updateSummary(totalApprovedHours, requiredHours);
        renderCalendar(currentCalMonth);
    });
}

window.openAttachmentById = function(id) {
    const log = window._attendanceLogs?.get(id);
    if (!log?.attachment) return;
    openFileData(log.attachment);
}

    // ─────────────────────────────────────────────────────────────
// SAFARI / IOS SAFE DOCUMENT PREVIEW
// ─────────────────────────────────────────────────────────────

let _currentBlobUrl = null;

window.previewAttendanceAttachment = function(id) {

    const log = window._attendanceLogs?.get(id);

    if (!log?.attachment) {
        alert('No attachment available.');
        return;
    }

    // Create modal dynamically if it doesn't exist
    let modal = document.getElementById('previewModal');

    if (!modal) {

        modal = document.createElement('div');

        modal.id = 'previewModal';

        const HEADER_HEIGHT = 100; 

        modal.style.cssText = `
        position:fixed;
            top:${HEADER_HEIGHT}px;
            left:0;
            right:0;
            bottom:0;

            background:rgba(0,0,0,.75);

            display:flex;
            align-items:center;
            justify-content:center;

            z-index:9990;

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
                ">

                <button id="closePreviewBtn"
                    style="
                        position:absolute;
                        top:12px;
                        right:12px;
                        width:40px;
                        height:40px;
                        border:none;
                        border-radius:50%;
                        background:rgba(255,255,255,.15);
                        color:#fff;
                        cursor:pointer;
                        z-index:99999;
                        font-size:1rem;
                        box-shadow:0 2px 12px rgba(0,0,0,.35);
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
            .addEventListener('click', closePreviewModal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closePreviewModal();
            }
        });

    } else {
        modal.style.display = 'flex';
    }

    const container =
        document.getElementById('previewContainer');

    // Cleanup old blob
    if (_currentBlobUrl) {
        URL.revokeObjectURL(_currentBlobUrl);
        _currentBlobUrl = null;
    }

    container.innerHTML = '';

    const fileData = log.attachment;

    const mimeType = getMimeType(fileData);

    // ─────────────────────────────────────────
    // IMAGE PREVIEW
    // ─────────────────────────────────────────

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

    // ─────────────────────────────────────────
    // PDF PREVIEW
    // ─────────────────────────────────────────

    if (mimeType === 'application/pdf') {

        try {
            _currentBlobUrl = dataUriToBlobUrl(fileData);
        } catch (err) {
            console.error(err);
            _currentBlobUrl = fileData;
        }

        const isIOS =
            /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' &&
             navigator.maxTouchPoints > 1);

        // iOS Safari fallback
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

                    <a href="${_currentBlobUrl}"
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

            container.style.paddingTop = '56px';
            container.style.boxSizing = 'border-box';
            container.style.background = '#222';

            const embedWrap = document.createElement('div');

            embedWrap.style.width = '100%';
            embedWrap.style.height = '100%';
            embedWrap.style.borderRadius = '0';
            embedWrap.style.overflow = 'hidden';

            const embed = document.createElement('embed');

            embed.src = _currentBlobUrl + '#toolbar=1&navpanes=0&scrollbar=1';
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

    // ─────────────────────────────────────────
    // DOCX / XLSX / OTHER FILES
    // ─────────────────────────────────────────

    try {
        _currentBlobUrl = dataUriToBlobUrl(fileData);
    } catch {
        _currentBlobUrl = fileData;
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

            <a href="${_currentBlobUrl}"
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

// ─────────────────────────────────────────
// CLOSE PREVIEW
// ─────────────────────────────────────────

function closePreviewModal() {

    const modal =
        document.getElementById('previewModal');

    if (modal) {
        modal.style.display = 'none';
    }

    const container =
        document.getElementById('previewContainer');

    if (container) {
        container.innerHTML = '';
    }

    if (_currentBlobUrl) {
        URL.revokeObjectURL(_currentBlobUrl);
        _currentBlobUrl = null;
    }
}

// ─────────────────────────────────────────
// MIME TYPE DETECTOR
// ─────────────────────────────────────────

function getMimeType(dataUri) {

    if (!dataUri ||
        typeof dataUri !== 'string') {
        return '';
    }

    const match =
        dataUri.match(/^data:(.*?);base64,/);

    return match ? match[1] : '';
}

// ─────────────────────────────────────────
// DATA URI → BLOB URL
// ─────────────────────────────────────────

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

function openFileData(src) {
    if (!src) return;

    // URL file
    if (src.startsWith('http')) {
        window.open(src, '_blank', 'noopener,noreferrer');
        return;
    }

    // Base64 file
    if (src.startsWith('data:')) {
        try {
            const [meta, base64] = src.split(';base64,');
            const mime = meta.split(':')[1] || 'application/octet-stream';

            const byteChars = atob(base64);
            const byteArray = new Uint8Array(byteChars.length);

            for (let i = 0; i < byteChars.length; i++) {
                byteArray[i] = byteChars.charCodeAt(i);
            }

            const blob = new Blob([byteArray], { type: mime });
            const url = URL.createObjectURL(blob);

            window.open(url, '_blank', 'noopener,noreferrer');

        } catch (err) {
            console.error('Open file error:', err);
            alert('Unable to open file.');
        }
    }
}

function updateSummary(completed, required) {
    const pct = required > 0 ? Math.min(100, (completed / required) * 100) : 0;
    const totalEl = document.getElementById('total-hours');
    if (totalEl) totalEl.innerHTML = `${completed.toFixed(1)}<span style="font-size:1.2rem">h</span>`;
    const barEl = document.getElementById('progress-bar');
    if (barEl) barEl.style.width = `${pct}%`;
    const textEl = document.getElementById('progress-text');
    if (textEl) textEl.textContent = `of ${required}h required (${Math.round(pct)}%)`;
}

// ─── CALENDAR ────────────────────────────────────────────────
function setupCalendarNav() {
    document.getElementById('prevMonth')?.addEventListener('click', () => {
        currentCalMonth.setMonth(currentCalMonth.getMonth() - 1);
        renderCalendar(currentCalMonth);
    });
    document.getElementById('nextMonth')?.addEventListener('click', () => {
        currentCalMonth.setMonth(currentCalMonth.getMonth() + 1);
        renderCalendar(currentCalMonth);
    });
}

function renderCalendar(date) {
    const grid = document.getElementById('mini-calendar');
    const display = document.getElementById('monthDisplay');
    if (!grid || !display) return;

    grid.innerHTML = '';
    const year = date.getFullYear();
    const month = date.getMonth();
    display.textContent = date.toLocaleString('default', { month: 'long', year: 'numeric' });

    ['S','M','T','W','T','F','S'].forEach(d => {
        const b = document.createElement('b');
        b.textContent = d;
        grid.appendChild(b);
    });

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();

    for (let i = 0; i < firstDay; i++) grid.appendChild(document.createElement('div'));

    for (let i = 1; i <= daysInMonth; i++) {
    const el = document.createElement('div');
    el.textContent = i;
    
    const key = new Date(year, month, i).toDateString();
    const status = loggedDateMap.get(key);


        if (i === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
            el.classList.add('today-circle');
        }

        if (!status) {
            el.classList.add('cal-empty');
        } else if (status === 'Approved') {
            el.classList.add('cal-approved');
        } else if (status === 'Rejected') {
            el.classList.add('cal-rejected');
        } else {
            el.classList.add('cal-pending');
        }

        grid.appendChild(el);
    }
}

// ─── UTILITIES ───────────────────────────────────────────────
function computeHoursDecimal(timeIn, timeOut) {
    if (!timeIn || !timeOut) return 0;
    const parse = (t) => {
        const [part, mod] = String(t).split(' ');
        let [h, m] = part.split(':').map(Number);
        if (mod === 'PM' && h < 12) h += 12;
        if (mod === 'AM' && h === 12) h = 0;
        return h + m / 60;
    };
    const diff = parse(timeOut) - parse(timeIn);
    return diff < 0 ? diff + 24 : diff;
}

function showError(msg) {
    const el = document.getElementById('error-message');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

function sanitizeStr(str, max = 500) {
    return String(str).trim().slice(0, max);
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

function fileToBase64(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res(r.result);
        r.onerror = () => rej(new Error('File read failed'));
        r.readAsDataURL(file);
    });
}