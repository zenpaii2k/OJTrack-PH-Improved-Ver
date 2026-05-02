import { auth, db } from "../firebase-config.js";
import { protectPage } from "../authguard.js";
import {
    doc, setDoc, updateDoc, getDoc, getDocs,
    collection, query, where, onSnapshot, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, formatTimestamp
} from '../js/theme.js';
import { setupNotificationSystem,
  sendNotification,
  markAllRead,
  clearAllNotifications, notifyReportSubmitted} from '../js/notifications.js';

initTheme();

let reportData = {
    personal:  {},
    attendance: [],
    checklist:  [],
    stats: { totalHours: 0, docsApproved: 0 }
};

let currentStatus = "Not Submitted";
let hasBatch = true;

protectPage('student').then((user) => {
    if (!user) return;

    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);
    loadUserProfile(user);

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

    listenForReportStatus(user.uid);
    compileFullData(user.uid);
});

async function loadUserProfile(user) {
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) return;

        const data = snap.data();

        const name = data.name
            || `${data.firstName || ''} ${data.surname || ''}`.trim()
            || 'Student';

        populateHeaderUser(name, user.email);

        const batchId = data?.batchId || data?.batch || null;

        if (!batchId) {
            hasBatch = false;
            showNoBatchNotice();
        }

            if (!batchId) {
        hasBatch = false;
        showNoBatchNotice();

        // Disable buttons visually
        const previewBtn = document.getElementById('btn-preview');
        const submitBtn  = document.getElementById('btn-submit');

        if (previewBtn) {
            previewBtn.disabled = true;
            previewBtn.style.opacity = '0.5';
        }

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.5';
        }
    }

    } catch (e) {
        console.error('[Checklist] loadUserProfile:', e);
    }

}

function showNoBatchNotice() {

    if (document.querySelector('.no-batch-notice')) return;

    const header = document.querySelector('.dashboard-header');

    const notice = document.createElement('div');
    notice.className = 'no-batch-notice';
    notice.innerHTML = `
        <div style="
            background: #fff3cd;
            color: #856404;
            padding: 12px 16px;
            border-bottom: 1px solid #ffeeba;
            text-align: center;
            font-size: 0.9rem;
        ">
            ⚠️ You don’t have an adviser yet. Report preview and submission are disabled.
        </div>
    `;

    if (header && header.parentNode) {
        header.parentNode.insertBefore(notice, header.nextSibling);
    } else {
        document.body.prepend(notice);
    }
}

// ─── REPORT STATUS LISTENER ───────────────────────────────────
function listenForReportStatus(uid) {
    const statusText  = document.getElementById('status-text');
    const resubmitBtn = document.getElementById('resubmit-btn');
    const banner      = document.getElementById('status-banner');
    const bannerTitle = document.getElementById('status-banner-title');
    const bannerSub   = document.getElementById('status-banner-sub');

    const q = query(
        collection(db, "reports"),
        where("studentUid", "==", uid),
        orderBy("submittedAt", "desc")
    );

    onSnapshot(q, (snap) => {
        let latest = null;

        if (snap.empty) {
            currentStatus = "Not Submitted";
        } else {
            latest = snap.docs[0].data();
            currentStatus = latest.status || "Pending";
        }

        const downloadBtn = document.getElementById('btn-download');
        if (downloadBtn) {
            downloadBtn.disabled = currentStatus !== 'Approved';
            downloadBtn.style.opacity = currentStatus === 'Approved' ? '1' : '0.5';
        }

        if (statusText) {
            statusText.textContent = sanitizeText(currentStatus);
            const cls = {
                'Approved': 'badge-success',
                'Rejected': 'badge-danger',
                'Pending':  'badge-warning',
            }[currentStatus] || 'badge-warning';
            statusText.className = `badge ${cls}`;
        }

        // Status banner
        if (banner) {
            banner.style.display = 'flex';
            if (bannerTitle) bannerTitle.textContent = `Report: ${currentStatus}`;

            if (bannerSub) {
                const sub = {
                    'Approved': 'Your OJT report has been approved by your adviser.',
                    'Rejected': 'Your report was rejected. Please review remarks and resubmit.',
                    'Pending':  'Your report is under review. Awaiting adviser feedback.',
                    'Not Submitted': 'You have not submitted your report yet.'
                }[currentStatus] || '';
                bannerSub.textContent = sub;
            }
        }

        if (resubmitBtn) {
            resubmitBtn.style.display = currentStatus === 'Rejected' ? 'inline-flex' : 'none';
            resubmitBtn.onclick = () => submitReport(auth.currentUser?.uid);
        }
    });
}

function showError(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.position = 'fixed';
    el.style.bottom = '20px';
    el.style.right = '20px';
    el.style.background = '#e74c3c';
    el.style.color = '#fff';
    el.style.padding = '10px 15px';
    el.style.borderRadius = '6px';
    el.style.zIndex = '9999';
    document.body.appendChild(el);

    setTimeout(() => el.remove(), 3000);
}

function downloadPDF() {
    if (currentStatus !== 'Approved') {
        showError("You can only download PDF if your document is approved.");
        return;
    }

    const pdf = generateAdviserPreview(reportData);
    if (!pdf) return;

    const name = `${reportData.personal.name.replace(/\s+/g,'_')}_OJT_Report.pdf`;
    pdf.save(name);
}

// ─── COMPILE ALL DATA ─────────────────────────────────────────
async function compileFullData(uid) {
    try {
        // User profile
        const userSnap = await getDoc(doc(db, "users", uid));
        const userData = userSnap.exists() ? userSnap.data() : {};

        reportData.personal = {
            name:    userData.name || `${userData.firstName || ''} ${userData.surname || ''}`.trim() || 'Student',
            school:  userData.school || 'N/A',
            section: userData.fullSection || userData.section || 'N/A',
            company: userData.company || 'Not Assigned',
            course:  userData.course || 'N/A',
            uid:     uid,
        };

        const required  = parseFloat(userData.requiredHours)  || 600;
        const completed = parseFloat(userData.hoursCompleted) || 0;

        // Get adviser name from batch
        const batchQ   = query(collection(db, "batches"), where("studentUids", "array-contains", uid));
        const batchSnap = await getDocs(batchQ);
        let adviserName = 'Not Assigned';

        if (!batchSnap.empty) {
            const batchData = batchSnap.docs[0].data();
            if (batchData.supervisorId) {
                const advSnap = await getDoc(doc(db, "users", batchData.supervisorId));
                if (advSnap.exists()) {
                    const ad = advSnap.data();
                    adviserName = ad.name || `${ad.firstName || ''} ${ad.surname || ''}`.trim() || 'Adviser';
                }
            }
        }

        reportData.personal.supervisor = adviserName;

        // Populate UI
        setText('pdf-name',       reportData.personal.name);
        setText('pdf-school',     reportData.personal.school);
        setText('pdf-section',    `${reportData.personal.course} — ${reportData.personal.section}`);
        setText('pdf-supervisor', adviserName);
        setText('pdf-company',    reportData.personal.company);
        setText('pdf-hours',      `${completed.toFixed(1)} hrs`);
        setText('pdf-required',   `${required} hrs`);

        // Attendance logs
        const attQ   = query(
            collection(db, "attendance"),
            where("uid", "==", uid),
            orderBy("timestamp", "desc")
        );
        const attSnap = await getDocs(attQ);
        reportData.attendance = attSnap.docs.map(d => d.data());

        // Checklist
        const checkQ   = query(collection(db, "checklist"), where("uid", "==", uid));
        const checkSnap = await getDocs(checkQ);
        reportData.checklist = checkSnap.docs.map(d => d.data());

        const docsApproved = reportData.checklist.filter(d => d.status === 'Approved').length;

        // Recompute total approved hours
        const totalHours = reportData.attendance
            .filter(a => (a.status || '').toLowerCase() === 'approved')
            .reduce((sum, a) => sum + computeHoursDecimal(a.timeIn, a.timeOut), 0);

        reportData.stats = { totalHours: parseFloat(totalHours.toFixed(2)), docsApproved };

        if (reportData.stats.totalHours <= 0) {
            alert("You must complete attendance hours before submitting.");
            return;
        }

        setText('pdf-docs-count', `${docsApproved}/13`);
        setText('pdf-hours',      `${totalHours.toFixed(1)} hrs`);

        const previewBtn = document.getElementById('btn-preview');
            if (previewBtn) {
                previewBtn.onclick = previewReport;
            }

        document.getElementById('btn-download')?.addEventListener('click', downloadPDF);
        document.getElementById('btn-submit')?.addEventListener('click',   () => submitReport(uid));

    } catch (e) {
        console.error('[PDF] compileFullData error:', e);
    }
}

// ─── PDF GENERATION ───────────────────────────────────────────
function generateAdviserPreview(data) {
    if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
        alert('PDF library not loaded. Please refresh and try again.');
        return null;
    }

     const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();
    const timestamp = new Date().toLocaleString();  

    // 1. PROFESSIONAL HEADER (Aligned Colors)
    pdf.setFillColor(44, 62, 80); // Dark Navy
    pdf.rect(0, 0, 210, 45, 'F');
    
    pdf.setTextColor(255, 212, 0); // Gold
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(26);
    pdf.text("OJTrack PH", 105, 20, { align: "center" });
    
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(14);
    pdf.setFont("helvetica", "normal");
    pdf.text("OJT Comprehensive Report", 105, 30, { align: "center" });
    pdf.setFontSize(10);
    pdf.text(`Generated on: ${timestamp}`, 105, 38, { align: "center" });

    // 2. SUMMARY BOX
    pdf.autoTable({
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
    pdf.autoTable({
        startY: pdf.lastAutoTable.finalY + 6,
        head: [['STUDENT PROFILE', 'INSTITUTION & SUPERVISION']],
        body: [[
            `NAME: ${reportData.personal.name}\nCOMPANY: ${reportData.personal.company}\nSECTION: ${reportData.personal.section}`,
            `SCHOOL: ${reportData.personal.school}\nADVISER: ${reportData.personal.supervisor || 'Not Assigned'}`
        ]],
        theme: 'grid',
        headStyles: { fillColor: [52, 73, 94] },
        styles: { cellPadding: 5, fontSize: 10 }
    });

    // 4. ATTENDANCE LOGS
    pdf.setTextColor(44, 62, 80);
    pdf.setFontSize(12);
    pdf.text("I. ATTENDANCE LOG PROGRESSION", 14, pdf.lastAutoTable.finalY + 12);

    pdf.autoTable({
        startY: pdf.lastAutoTable.finalY + 15,
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
    pdf.addPage();
    pdf.setFontSize(12);
    pdf.text("II. REQUIREMENT VERIFICATION", 14, 20);
    
    pdf.autoTable({
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
                if (status === 'Pending Approval') data.cell.styles.textColor = [230, 126, 34];
            }
        }
    });

   // 6. SIGNATURE SECTION (move down properly)
    const signY = pdf.lastAutoTable.finalY + 20;

    // ─── CERTIFICATION MESSAGE (FIXED POSITION) ───
    const certMessage =
        "I hereby certify that the information provided in this report is true and accurate to the best of my knowledge, representing the actual hours rendered and requirements submitted for the OJT/practicum program.";

    const splitMessage = pdf.splitTextToSize(certMessage, 180);

    // place message BEFORE signatures
    pdf.setFont("helvetica", "bolditalic");
    pdf.setFontSize(10);

    pdf.text(splitMessage, 14, signY);

    // adjust signature position BELOW message
    const signatureY = signY + (splitMessage.length * 5) + 10;

    // ─── SIGNATURE LINES ───
    pdf.setDrawColor(0);
    pdf.line(14, signatureY, 80, signatureY);
    pdf.line(130, signatureY, 196, signatureY);

    pdf.setFont("helvetica", "bold");
    pdf.text("Student Signature", 47, signatureY + 5, { align: "center" });
    pdf.text("Adviser Signature", 163, signatureY + 5, { align: "center" });

    window._latestPdf = pdf;

    // safer mobile detection
    const blob = pdf.output('blob');
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

        return pdf;
}

// Mobile ONLY: open new tab
const newTab = window.open(blobUrl, "_blank");

if (!newTab) {
    const a = document.createElement("a");
    a.href = blobUrl;
    a.target = "_blank";
    a.click();
}
}

function previewReport() {
    if (!hasBatch) {
        alert("You need an adviser before previewing your OJT report.");
        return;
    }

    const pdf = generateAdviserPreview(reportData);
    if (!pdf) return;

    const modal  = document.getElementById('previewModal');
    const iframe = document.getElementById('pdf-preview-iframe');

    if (modal && iframe) {
        const blob = pdf.output('blob');

        const oldSrc = iframe.src;
        if (oldSrc) URL.revokeObjectURL(oldSrc);

        iframe.src = URL.createObjectURL(blob);
        modal.style.display = 'flex';
    }
}

window.closePreview = function() {
    const modal = document.getElementById('previewModal');
    if (modal) { modal.style.display = 'none'; modal.classList.remove('show'); }
};

async function submitReport(uid) {
    if (!uid) return;

    if (!hasBatch) {
        alert("You cannot submit your report without an assigned adviser.");
        return;
    }

    const btn = document.getElementById('btn-submit');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Submitting…';
    }

    try {
        const userSnap = await getDoc(doc(db, "users", uid));
        const userData = userSnap.data();

        const adviserUid = userData?.supervisorId;
        const studentName =
            userData?.name ||
            `${userData?.firstName || ''} ${userData?.surname || ''}`.trim() ||
            "Student";

        const pdf       = generateAdviserPreview(reportData);
        const pdfBase64 = pdf ? pdf.output('datauristring') : null;


        await setDoc(doc(db, "reports", uid), {
            studentUid:   uid,
            studentName:  studentName,
            section:      reportData.personal.section,
            hte:          reportData.personal.company,
            totalHours:   reportData.stats.totalHours,
            docsApproved: reportData.stats.docsApproved,
            status:       'Pending',
            submittedAt:  serverTimestamp(),
            history:      [],
            pdfBase64:    pdfBase64,
        });

        if (adviserUid) {
            await notifyReportSubmitted(adviserUid, studentName);
        }

        alert('Report submitted! Your adviser will review it shortly.');

    } catch (e) {
        console.error('[PDF] submitReport error:', e);
        alert('Submission failed: ' + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📤 Submit for Review';
        }
    }
}

// ─── HELPERS ─────────────────────────────────────────────────
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
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
