import { protectPage } from "../authguard.js";
import { db, auth } from "../firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection, query, where, getDocs, getDoc, doc, addDoc,
    updateDoc, serverTimestamp, orderBy, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, formatTimestamp
} from '../js/theme.js';
import {  setupNotificationSystem,
  sendNotification,
  markAllRead,
  clearAllNotifications, notifyAdviserFeedback, notifyReportApproved, notifyReportRejected} from '../js/notifications.js';

initTheme();

let selectedStudentId = null;
const nameCache = {};

let currentReportDocId = null;
let currentStudentUid = null;
let currentReportPdf = null;

protectPage('supervisor');

onAuthStateChanged(auth, async (user) => {

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

    await fetchUserProfile(user);

    syncBatchesForThisSupervisor(user.uid);
    });

// ─── USER PROFILE ────────────────────────────────────────────
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

// ─── BATCH & STUDENT LOADING ──────────────────────────────────
async function syncBatchesForThisSupervisor(supervisorUid) {
    const programSelector = document.getElementById('program-selector');
    if (!programSelector) return;

    try {
        const q    = query(collection(db, "batches"), where("supervisorId", "==", supervisorUid));
        const snap = await getDocs(q);

        if (snap.empty) {
            programSelector.innerHTML = '<option value="" disabled selected>No batches found</option>';
            return;
        }

        let html = '<option value="" disabled selected>Select a batch…</option>';
        snap.docs.forEach(d => {
            const data = d.data();
            html += `<option value="${d.id}">${sanitizeText(data.name || d.id)}</option>`;
        });
        programSelector.innerHTML = html;
        programSelector.addEventListener('change', (e) => loadStudentsFromBatch(e.target.value));

    } catch (e) {
        console.error('[Reports] syncBatches:', e);
    }
}

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

async function loadStudentsFromBatch(batchId) {
    const studentList = document.getElementById('student-list');
    if (!studentList) return;

    studentList.innerHTML = '<p class="empty-text">Loading students…</p>';

    try {
        const snap = await getDoc(doc(db, "batches", batchId));
        if (!snap.exists()) return;

        const studentUids = snap.data().studentUids || [];

        document.getElementById('student-count').textContent = studentUids.length;

        if (studentUids.length === 0) {
            studentList.innerHTML = '<p class="empty-text">No students in this batch.</p>';
            return;
        }

        const userPromises = studentUids.map(uid => getDoc(doc(db, "users", uid)));
        const reportPromises = studentUids.map(uid =>
            getDocs(query(
                collection(db, "reports"),
                where("studentUid", "==", uid),
                orderBy("submittedAt", "desc"),
                limit(1)
            ))
        );

        const userSnaps = await Promise.all(userPromises);
        const reportSnaps = await Promise.all(reportPromises);

        studentList.innerHTML = '';

        studentUids.forEach((uid, i) => {
            const uSnap = userSnaps[i];
            const reportSnap = reportSnaps[i];

            if (!uSnap.exists()) return;

            const s = uSnap.data();
            const name = s.name || `${s.firstName || ''} ${s.surname || ''}`.trim() || 'Student';
            const section = s.fullSection || s.section || '—';
            const initial = name.charAt(0).toUpperCase();

            const reportStatus = reportSnap.empty
                ? 'No Report'
                : (reportSnap.docs[0].data().status || 'Pending');

            const item = document.createElement('div');
            item.className = `report-student-item`;

            item.innerHTML = `
                <div class="report-student-avatar">${initial}</div>
                <div class="report-student-info">
                    <div class="report-student-name">${sanitizeText(name)}</div>
                    <div class="report-student-sub">
                        ${sanitizeText(section)} · 
                        <span class="badge ${getStatusClass(reportStatus)}">
                            ${sanitizeText(reportStatus)}
                        </span>
                    </div>
                </div>
            `;

            item.onclick = () => loadStudentReport(uid, name, item);

            studentList.appendChild(item);
        });

    } catch (e) {
        console.error('[Reports] loadStudentsFromBatch:', e);
        studentList.innerHTML = '<p class="empty-text">Could not load students.</p>';
    }
}

function getStatusClass(status) {
    const s = (status || '').toLowerCase();
    if (s === 'Approved')   return 'badge-success';
    if (s === 'Rejected')   return 'badge-danger';
    if (s === 'Pending')    return 'badge-warning';
    return 'badge-info';
}

function setupReviewButtons(reportDocId, studentUid, studentName) {
    const approveBtn = document.getElementById("btn-approve-report");
    const rejectBtn = document.getElementById("btn-reject-report");
    const feedbackBtn = document.getElementById("send-feedback-btn");
    const remarksInput = document.getElementById("review-remarks");

    if (!approveBtn || !rejectBtn || !feedbackBtn) return;

    // Reset UI
    approveBtn.disabled = false;
    rejectBtn.disabled = false;
    feedbackBtn.disabled = false;

    if (!remarksInput?.value.trim()) {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
    }

    // Optional: store current context (safe fallback)
    currentReportDocId = reportDocId;
    currentStudentUid = studentUid;

    // 🔥 Fetch latest status to control buttons
    getDoc(doc(db, "reports", reportDocId)).then(snap => {
        if (!snap.exists()) return;

        const data = snap.data();
        const status = (data.status || "Pending").toLowerCase();

        if (status === "approved") {
            approveBtn.disabled = true;
        }

        if (status === "rejected") {
            rejectBtn.disabled = true;
        }

        // If already finalized, prevent double actions
        if (status === "approved" || status === "rejected") {
            approveBtn.disabled = true;
            rejectBtn.disabled = true;
        }
    });
}

// ─── REPORT DETAIL PANEL ──────────────────────────────────────
let reportListener = null;

let pdfTimeout = null;

async function loadStudentReport(uid, studentName, clickedItem) {

    document.getElementById('adviser-pdf-preview').style.display = 'none';
    document.getElementById('report-empty-state').style.display = 'none';
    document.getElementById('report-history').innerHTML = "";
    selectedStudentId = uid;

    document.querySelectorAll('.report-student-item')
        .forEach(el => el.classList.remove('active'));

    if (clickedItem) clickedItem.classList.add('active');

    document.getElementById('no-selection-msg').style.display = 'none';
    document.getElementById('active-report-view').style.display = 'block';

    document.getElementById('report-history').innerHTML = "";
    document.getElementById('adviser-pdf-preview').src = "";

    if (typeof reportListener === "function") {
        reportListener();
        reportListener = null;
    }

    try {
        const uSnap = await getDoc(doc(db, "users", uid));
        const u = uSnap.exists() ? uSnap.data() : {};

        document.getElementById('view-student-name').innerText = u.name || studentName;
        document.getElementById('view-student-email').innerText = u.email || "N/A";
        document.getElementById('view-student-course').innerText = u.course || "N/A";
        document.getElementById('view-student-section').innerText = u.section || "N/A";
        document.getElementById('view-student-hte').innerText = u.company || "Not Assigned";

        const rq = query(
            collection(db, "reports"),
            where("studentUid", "==", uid),
            orderBy("submittedAt", "desc"),
            limit(1)
        );

        reportListener = onSnapshot(rq, async (snap) => {

            if (uid !== selectedStudentId) return;
            if (snap.empty) {
                document.getElementById('adviser-pdf-preview').style.display = 'none';
                document.getElementById('report-empty-state').style.display = 'flex';
                return;
            } else {
                document.getElementById('adviser-pdf-preview').style.display = 'block';
                document.getElementById('report-empty-state').style.display = 'none';
            }

            const docSnap = snap.docs[0];
            const report = docSnap.data();

            currentReportDocId = docSnap.id;
            currentStudentUid = uid;

            renderHistory(report.history || []);

            if (pdfTimeout) clearTimeout(pdfTimeout);

            pdfTimeout = setTimeout(async () => {
                const compiled = await compileStudentPreviewData(uid, u);

                if (uid !== selectedStudentId) return;

                requestAnimationFrame(() => {
                    currentReportPdf = generateAdviserPreview(compiled);
                });

            }, 300); 
        });

    } catch (e) {
        console.error('[Reports] loadError:', e);
    }
}
async function compileStudentPreviewData(uid, studentBasicInfo) {
    try {
        // Attendance
        const attQ = query(
            collection(db, "attendance"),
            where("uid", "==", uid),
            orderBy("timestamp", "desc")
        );

        const attSnap = await getDocs(attQ);

        let attendance = [];
        let totalHours = 0;

        attSnap.forEach(d => {
            const a = d.data();

            if ((a.status || '').toLowerCase() === 'approved') {
                totalHours += computeHoursDecimal(a.timeIn, a.timeOut);
            }

            attendance.push(a);
        });

        // Checklist
        const checkQ = query(collection(db, "checklist"), where("uid", "==", uid));
        const checkSnap = await getDocs(checkQ);

        let checklist = [];
        let docsApproved = 0;

        checkSnap.forEach(d => {
            const c = d.data();

            if (c.status === "Approved") docsApproved++;
            checklist.push(c);
        });

        return {
            personal: {
                name: studentBasicInfo.name ||
                    `${studentBasicInfo.firstName || ''} ${studentBasicInfo.surname || ''}`.trim(),
                school: studentBasicInfo.school || "N/A",
                section: studentBasicInfo.fullSection || studentBasicInfo.section || "N/A",
                company: studentBasicInfo.company || "Not Assigned",
                supervisor: document.getElementById('user-display-name')?.innerText || "Adviser"
            },
            stats: {
                totalHours: parseFloat(totalHours.toFixed(1)),
                docsApproved
            },
            attendance,
            checklist
        };

    } catch (e) {
        console.error("Preview Compilation Error:", e);
        return null;
    }
}

function generateAdviserPreview(reportData, generatedAt) {
    const { jsPDF } = window.jspdf;
    const pdfdoc = new jsPDF();
    const timestamp = new Date().toLocaleString();

    // 1. PROFESSIONAL HEADER (Aligned Colors)
    pdfdoc.setFillColor(44, 62, 80); // Dark Navy
    pdfdoc.rect(0, 0, 210, 45, 'F');
    
    pdfdoc.setTextColor(255, 212, 0); // Gold
    pdfdoc.setFont("helvetica", "bold");
    pdfdoc.setFontSize(26);
    pdfdoc.text("OJTrack PH", 105, 20, { align: "center" });
    
    pdfdoc.setTextColor(255, 255, 255);
    pdfdoc.setFontSize(14);
    pdfdoc.setFont("helvetica", "normal");
    pdfdoc.text("OJT Comprehensive Report", 105, 30, { align: "center" });
    pdfdoc.setFontSize(10);
    pdfdoc.text(`Generated on: ${timestamp}`, 105, 38, { align: "center" });

    // 2. SUMMARY BOX
    pdfdoc.autoTable({
        startY: 50,
        head: [['OJT STATISTICS SUMMARY', '']],
        body: [
            ['Total Hours Rendered:', `${reportData.stats.totalHours} Hours`],
            ['Requirements Completed:', `${reportData.stats.docsApproved} Items`]
        ],
        theme: 'plain',
        styles: { fontSize: 10, cellPadding: 2, fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 60 } }
    });

    // 3. PROFILE DATA
    pdfdoc.autoTable({
        startY: pdfdoc.lastAutoTable.finalY + 6,
        head: [['STUDENT PROFILE', 'INSTITUTION & SUPERVISION']],
        body: [[
            `NAME: ${reportData.personal.name}\nCOMPANY: ${reportData.personal.company}\nSECTION: ${reportData.personal.section}`,
            `SCHOOL: ${reportData.personal.school}\nADVISER: ${reportData.personal.supervisor}`
        ]],
        theme: 'grid',
        headStyles: { fillColor: [52, 73, 94] },
        styles: { cellPadding: 5, fontSize: 10 }
    });

    // 4. ATTENDANCE LOGS
    pdfdoc.setTextColor(44, 62, 80);
    pdfdoc.setFontSize(12);
    pdfdoc.text("I. ATTENDANCE LOG PROGRESSION", 14, pdfdoc.lastAutoTable.finalY + 12);

    pdfdoc.autoTable({
        startY: pdfdoc.lastAutoTable.finalY + 15,
        head: [['Date', 'Time In', 'Time Out', 'Accomplishment', 'Status']], 
        body: reportData.attendance.length > 0
            ? reportData.attendance.map(a => [
            a.displayDate || formatTimestamp(a.timestamp),
            a.timeIn || '—',
            a.timeOut || '—',
            a.note || '—',
            a.status || 'Pending'
        ])
        : [['-', '-', '-', 'No logs found', '-']],
        headStyles: { fillColor: [44, 62, 80] },
        styles: { fontSize: 8 },
        columnStyles: { 
            3: { cellWidth: 70 }, 
            4: { cellWidth: 25, fontStyle: 'bold' } 
        },
        theme: 'striped',
        didParseCell: function(data) {
            if (data.section === 'body' && data.column.index === 4) {
                const status = data.cell.raw;
                if (status === 'Approved') data.cell.styles.textColor = [46, 204, 113];
                if (status === 'Rejected') data.cell.styles.textColor = [231, 76, 60];
                if (status === 'Pending') data.cell.styles.textColor = [241, 196, 15];
            }
        }
    });

    // 5. CHECKLIST (New Page)
    pdfdoc.addPage();
    pdfdoc.setFontSize(12);
    pdfdoc.text("II. REQUIREMENT VERIFICATION", 14, 20);
    
    pdfdoc.autoTable({
        startY: 25,
        head: [['Requirement Item', 'Submission Date', 'Status']],
        body: reportData.checklist.map(c => [
            c.formKey || '—',
            c.dateSubmitted || '—',
            c.status || 'Pending'
        ]),
        headStyles: { fillColor: [230, 126, 34] },
        styles: { fontSize: 9 },
        didParseCell: function(data) {
            if (data.section === 'body' && data.column.index === 2) {
                const status = data.cell.raw;
                if (status === 'Approved') data.cell.styles.textColor = [46, 204, 113];
                if (status === 'Rejected') data.cell.styles.textColor = [231, 76, 60];
                if (status === 'Pending') data.cell.styles.textColor = [230, 126, 34];
                if (status === 'Pending Approval') data.cell.styles.textColor = [241, 196, 15];
            }
        }
    });

    // 6. SIGNATURE SECTION (Professional look)
     const signY = pdfdoc.lastAutoTable.finalY + 20;

    // ─── CERTIFICATION MESSAGE (FIXED POSITION) ───
    const certMessage =
        "I hereby certify that the information provided in this report is true and accurate to the best of my knowledge, representing the actual hours rendered and requirements submitted for the OJT/practicum program.";

    const splitMessage = pdfdoc.splitTextToSize(certMessage, 180);

    // place message BEFORE signatures
    pdfdoc.setFont("helvetica", "bolditalic");
    pdfdoc.setFontSize(10);

    pdfdoc.text(splitMessage, 14, signY);

    // adjust signature position BELOW message
    const signatureY = signY + (splitMessage.length * 5) + 10;

    // ─── SIGNATURE LINES ───
    pdfdoc.setDrawColor(0);
    pdfdoc.line(14, signatureY, 80, signatureY);
    pdfdoc.line(130, signatureY, 196, signatureY);

    pdfdoc.setFont("helvetica", "bold");
    pdfdoc.text("Student Signature", 47, signatureY + 5, { align: "center" });
    pdfdoc.text("Adviser Signature", 163, signatureY + 5, { align: "center" });

    window._latestPdf = pdfdoc;

    const blob = pdfdoc.output('blob');
    const blobUrl = URL.createObjectURL(blob);

    // Desktop ONLY: show modal preview
    const isMobile =
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    if (!isMobile) {
        const iframe = document.getElementById('adviser-pdf-preview');

        if (iframe) {
            if (iframe.dataset.blobUrl) {
                URL.revokeObjectURL(iframe.dataset.blobUrl);
            }

            iframe.src = blobUrl;
            iframe.dataset.blobUrl = blobUrl;
        }

        return pdfdoc;
    }

const newTab = window.open(blobUrl, "_blank");

if (!newTab) {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.target = "_blank";
    a.click();
}
}

// --- CORE ACTIONS ---

async function displayFullReport(uid, data) {
    currentStudentUid = uid;

    document.getElementById('no-selection-msg').style.display = 'none';
    document.getElementById('active-report-view').style.display = 'block';

    const fullName = data.name || `${data.firstName} ${data.surname}`;

    document.getElementById('view-student-name').innerText = fullName;
    document.getElementById('view-student-email').innerText = data.email || "N/A";
    document.getElementById('view-student-course').innerText = data.course || "N/A";
    document.getElementById('view-student-section').innerText = data.section || "N/A";
    document.getElementById('view-student-hte').innerText = data.company || data.hte || "Not Assigned";

    const rq = query(
        collection(db, "reports"),
        where("studentUid", "==", uid),
        orderBy("submittedAt", "desc"),
        limit(1)
    );

    const snap = await getDocs(rq);

    if (snap.empty) {
        alert("No report found");
        return;
    }

    const reportDoc = snap.docs[0];
    currentReportDocId = reportDoc.id;

    const reportData = await compileStudentPreviewData(uid, data);
    currentReportPdf = generateAdviserPreview(compiled, new Date());

    renderHistory(reportDoc.data().history || []);

    // IMPORTANT: wait for DOM stability
    requestAnimationFrame(() => {
        setupReviewButtons(reportDoc.id, uid, fullName);
    });

}

document.addEventListener("click", async (e) => {

    if (e.target.id === "btn-approve-report") {
        submitDecision(currentReportDocId, "Approved", currentStudentUid);
    }

    if (e.target.id === "btn-reject-report") {
        submitDecision(currentReportDocId, "Rejected", currentStudentUid);
    }

    if (e.target.id === "send-feedback-btn") {
        sendFeedback(currentReportDocId, currentStudentUid);
    }
});

document.getElementById('download-report-btn').onclick = () => {
    if (currentReportPdf) {
        const studentName = document.getElementById('view-student-name').innerText;
        currentReportPdf.save(`OJT_Report_${studentName.replace(/\s+/g, '_')}.pdf`);
    } else {
        alert("No PDF generated.");
    }
};

async function submitDecision(reportDocId, decision, studentUid) {
    const msg = document.getElementById('review-remarks')?.value.trim();

    if (!msg) {
        return alert("Please enter feedback before approving or rejecting the report.");
    }

    if (decision !== "Approved" && decision !== "Rejected") {
        return alert("Invalid decision.");
    }

    const confirmAction = confirm(`Are you sure you want to ${decision} this report?`);
    if (!confirmAction) return;

    const reportRef = doc(db, "reports", reportDocId);
    const snap = await getDoc(reportRef);

    if (!snap.exists()) return alert("Report not found");

    const data = snap.data();

    const entry = {
        action: decision,
        by: "Adviser",
        message: msg,
        timestamp: Date.now()
    };

    await updateDoc(reportRef, {
    status: decision,
    lastAction: decision,
    reviewedBy: auth.currentUser.uid,
    reviewedAt: serverTimestamp(),
    history: [...(data.history || []), entry]
        });

        // 🔥 ADD THIS
        if (decision === "Approved") {
            await notifyReportApproved(studentUid, "Adviser");
        }

        if (decision === "Rejected") {
            await notifyReportRejected(studentUid, "Adviser", msg);
        }

    renderHistory([...data.history, entry]);

    document.getElementById('review-remarks').value = "";

    alert(`Report ${decision}`);
}

async function sendFeedback(reportDocId, studentUid) {
    const msg = document.getElementById('review-remarks')?.value.trim();

    if (!msg) return alert("Write feedback first.");

    const reportRef = doc(db, "reports", reportDocId);
    const snap = await getDoc(reportRef);

    if (!snap.exists()) return;

    const data = snap.data();

    const entry = {
        action: "Feedback",
        by: "Adviser",
        message: msg,
        timestamp: Date.now()
    };

    await updateDoc(reportRef, {
        history: [...(data.history || []), entry],
        lastAction: "Feedback"
    });

    await addDoc(collection(db, "students", studentUid, "feedback"), {
        senderName: "Adviser",
        senderRole: "OJT Adviser",
        message: msg,
        timestamp: Date.now(),
        type: "feedback"
    });

    await notifyAdviserFeedback(studentUid, "Adviser");

    renderHistory([...data.history, entry]);

    alert("Feedback sent!");
}

function renderHistory(history = []) {
    const container = document.getElementById("report-history");
    if (!container) return;

    container.innerHTML = history
        .sort((a, b) => {
            const ta = a.timestamp?.seconds || 0;
            const tb = b.timestamp?.seconds || 0;
            return tb - ta;
        })
        .map(h => `
            <div style="padding:8px;border-bottom:1px solid #333">
                <strong>${h.action}</strong> by ${h.by}
                <br>
                <small>${h.timestamp?.toDate ? h.timestamp.toDate().toLocaleString() : ""}</small>
                ${h.message ? `<p>${h.message}</p>` : ""}
            </div>
        `).join("");
}

function computeHoursDecimal(tIn, tOut) {
    if (!tIn || !tOut) return 0;
    const parse = (t) => {
        const [part, mod] = String(t).split(' ');
        let [h, m] = part.split(':').map(Number);
        if (mod === 'PM' && h < 12) h += 12;
        if (mod === 'AM' && h === 12) h = 0;
        return h + m / 60;
    };
    const diff = parse(tOut) - parse(tIn);
    return diff < 0 ? diff + 24 : diff;
}

function computeHoursDisplay(tIn, tOut) {
    const h = computeHoursDecimal(tIn, tOut);
    return h > 0 ? `${h.toFixed(1)}h` : '—';
}