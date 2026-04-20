import { protectPage } from "../authguard.js";
import { db, auth } from "../firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    collection, query, where, getDocs, getDoc, doc,
    updateDoc, serverTimestamp, orderBy, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, formatTimestamp
} from '../js/theme.js';
import { setupNotificationSystem } from '../js/notifications.js';

initTheme();

let selectedStudentId = null;
const nameCache = {};

let currentReportDocId = null;
let currentStudentUid = null;
let currentReportPdf = null;

protectPage('supervisor');

onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.replace("/index.html"); return; }

    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);

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

        const countEl = document.getElementById('student-count');
        if (countEl) {
            countEl.textContent = studentUids.length;
        }

        if (studentUids.length === 0) {
            studentList.innerHTML = '<p class="empty-text">No students in this batch.</p>';
            return;
        }

        studentList.innerHTML = '';

        for (const uid of studentUids) {
            const uSnap = await getDoc(doc(db, "users", uid));
            if (!uSnap.exists()) continue;

            const s = uSnap.data();
            const name = s.name || `${s.firstName || ''} ${s.surname || ''}`.trim() || 'Student';
            const section = s.fullSection || s.section || '—';
            const initial = name.charAt(0).toUpperCase();

            const reportQ = query(
                collection(db, "reports"),
                where("studentUid", "==", uid),
                orderBy("submittedAt", "desc"),
                limit(1)
            );

            const reportSnap = await getDocs(reportQ);
            const reportStatus = reportSnap.empty
                ? 'No Report'
                : (reportSnap.docs[0].data().status || 'Pending');

            const item = document.createElement('div');
            item.className = `report-student-item ${selectedStudentId === uid ? 'active' : ''}`;

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

            item.addEventListener('click', () =>
                loadStudentReport(uid, name, item)
            );

            studentList.appendChild(item);
        }

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

// ─── REPORT DETAIL PANEL ──────────────────────────────────────
async function loadStudentReport(uid, studentName, clickedItem) {
    selectedStudentId = uid;

    document.querySelectorAll('.report-student-item').forEach(el => el.classList.remove('active'));
    if (clickedItem) clickedItem.classList.add('active');

    const noMsg = document.getElementById('no-selection-msg');
    const activeView = document.getElementById('active-report-view');
    if (noMsg) noMsg.style.display = 'none';
    if (activeView) activeView.style.display = 'block';

    try {
        const uSnap = await getDoc(doc(db, "users", uid));
        const u = uSnap.exists() ? uSnap.data() : {};

        // Sync Metadata to Header
        document.getElementById('view-student-name').innerText = u.name || studentName;
        document.getElementById('view-student-email').innerText = u.email || "N/A";
        document.getElementById('view-student-course').innerText = u.course || "N/A";
        document.getElementById('view-student-section').innerText = u.section || "N/A";
        document.getElementById('view-student-hte').innerText = u.company || "Not Assigned";

        const reportData = await compileStudentPreviewData(uid, u);
        
        requestAnimationFrame(() => {
            generateAdviserPreview(reportData);
        });

        const rq = query(collection(db, "reports"), where("uid", "==", uid), limit(1));
        const rSnap = await getDocs(rq);

        if (!rSnap.empty) {
            setupReviewButtons(rSnap.docs[0].id, uid, studentName);
        }

    } catch (e) {
        console.error('[Reports] loadError:', e);
    }
}

async function compileStudentPreviewData(uid, studentBasicInfo) {
    try {
        const attQuery = query(collection(db, "attendance"), where("uid", "==", uid), orderBy("timestamp", "desc"));
        const attSnap = await getDocs(attQuery);
        let minutes = 0;
        let attendanceRows = [];
        
        attSnap.forEach(d => {
            const data = d.data();
            const status = data.status || "Pending";
            if (data.timeIn && data.timeOut) {
                if (status === "Approved") minutes += calculateMinutes(data.timeIn, data.timeOut);
                attendanceRows.push([data.displayDate, data.timeIn, data.timeOut, data.note || "", status]);
            }
        });

        const checkQuery = query(collection(db, "checklist"), where("uid", "==", uid));
        const checkSnap = await getDocs(checkQuery);
        let checklistRows = [];
        let ApprovedCount = 0;
        
        checkSnap.forEach(d => {
            const data = d.data();
            if (data.status === "Approved") ApprovedCount++;
            checklistRows.push([
                data.formKey ? data.formKey.replace(/-/g, ' ').toUpperCase() : 'UNKNOWN',
                data.dateSubmitted || 'N/A',
                data.status || 'Pending',
                data.remarks || "No remarks"
            ]);
        });

        return {
            personal: {
                name: studentBasicInfo.name || `${studentBasicInfo.firstName || ''} ${studentBasicInfo.surname || ''}`.trim(),
                company: studentBasicInfo.company || "N/A",
                school: studentBasicInfo.school || "N/A",
                section: `${studentBasicInfo.course || 'IT'}-${studentBasicInfo.section || 'N/A'}`,
                supervisor: document.getElementById('user-display-name')?.innerText || "Adviser"
            },
            stats: {
                totalHours: (minutes / 60).toFixed(1),
                docsApproved: ApprovedCount
            },
            attendance: attendanceRows,
            checklist: checklistRows
        };
    } catch (e) {
        console.error("Preview Compilation Error:", e);
        return null;
    }
}

function generateAdviserPreview(reportData) {
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
        body: reportData.attendance.length > 0 ? reportData.attendance : [['-', '-', '-', 'No logs found', '-']],
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
        body: reportData.checklist,
        headStyles: { fillColor: [230, 126, 34] },
        styles: { fontSize: 9 },
        didParseCell: function(data) {
            if (data.section === 'body' && data.column.index === 2) {
                const status = data.cell.raw;
                if (status === 'Approved') data.cell.styles.textColor = [46, 204, 113];
                if (status === 'Rejected') data.cell.styles.textColor = [231, 76, 60];
                if (status === 'Pending') data.cell.styles.textColor = [230, 126, 34];
            }
        }
    });

    // 6. SIGNATURE SECTION (Professional look)
    const signY = pdfdoc.lastAutoTable.finalY + 40; 
    pdfdoc.setTextColor(0, 0, 0);
    pdfdoc.line(14, signY, 80, signY); 
    pdfdoc.line(130, signY, 196, signY); 
    pdfdoc.setFont("helvetica", "bold");
    pdfdoc.text("Student Signature", 47, signY + 5, { align: "center" });
    pdfdoc.text("Adviser Signature", 163, signY + 5, { align: "center" });

    window._latestPdf = pdfdoc;

    // safer mobile detection
    const isMobile =
        window.matchMedia("(max-width: 768px)").matches ||
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    // ALWAYS render iframe first (desktop + mobile)
    const iframe = document.getElementById('adviser-pdf-preview');

    const blob = pdfdoc.output('blob');
    const blobURL = URL.createObjectURL(blob);

    if (iframe) {
        iframe.src = blobURL;
    }

    // ONLY mobile opens new tab (optional fallback view)
    if (isMobile) {
        const pdfDataUrl = pdfdoc.output('dataurlstring');

        const newTab = window.open("", "_blank");
        if (newTab) {
            newTab.document.write(`
                <html>
                    <head><title>OJT Report</title></head>
                    <body style="margin:0">
                        <iframe style="border:none;width:100%;height:100vh"
                            src="${pdfDataUrl}">
                        </iframe>
                    </body>
                </html>
            `);
            newTab.document.close();
        }
    }

    return pdfdoc;
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
    currentReportPdf = generateAdviserPreview(reportData);

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

    if (!msg) return alert("Feedback required.");

    const reportRef = doc(db, "reports", reportDocId);
    const snap = await getDoc(reportRef);

    if (!snap.exists()) return alert("Report not found");

    const data = snap.data();

    const entry = {
        action: decision,
        by: "Adviser",
        message: msg,
        timestamp: serverTimestamp()
    };

    await updateDoc(reportRef, {
        status: decision,
        lastAction: decision,
        reviewedBy: auth.currentUser.uid,
        reviewedAt: serverTimestamp(),
        history: [...(data.history || []), entry]
    });

    renderHistory([...data.history, entry]);

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
        timestamp: serverTimestamp()
    };

    await updateDoc(reportRef, {
        history: [...(data.history || []), entry],
        lastAction: "Feedback"
    });

    await addDoc(collection(db, "students", studentUid, "feedback"), {
        senderName: "Adviser",
        senderRole: "OJT Adviser",
        message: msg,
        timestamp: serverTimestamp(),
        type: "feedback"
    });

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