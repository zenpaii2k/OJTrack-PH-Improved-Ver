/**
 * OJTrack PH — generatepdf.js
 * ─────────────────────────────────────────────────────────────
 * FIXES:
 *  1. setupThemeToggle for both buttons — WAS MISSING
 *  2. setupProfileDropdown, setupNotifDropdown — WAS MISSING
 *  3. requiredHours ✓ (was correct), hoursCompleted (not completedHours)
 *  4. attendance query: uid not userId, timestamp not createdAt
 *  5. logout wired for sidebar button
 * ─────────────────────────────────────────────────────────────
 */

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
import { setupNotificationSystem } from '../js/notifications.js';

initTheme();

let reportData = {
    personal:  {},
    attendance: [],
    checklist:  [],
    stats: { totalHours: 0, docsApproved: 0 }
};

let currentStatus = "Not Submitted";

protectPage('student').then((user) => {
    if (!user) return;

    // ✅ FIX: Wire ALL theme + UI controls
    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);

    // ✅ FIX: Wire sidebar logout
    ['logout-link', 'sidebar-logout-btn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', () =>
            signOut(auth).then(() => window.location.replace('/index.html'))
        );
    });

    listenForReportStatus(user.uid);
    compileFullData(user.uid);
});

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
        if (snap.empty) {
            currentStatus = "Not Submitted";
            if (statusText) {
                statusText.textContent = 'Not Submitted';
                statusText.className = 'badge badge-warning';
            }
            if (banner) banner.style.display = 'none';
            if (resubmitBtn) resubmitBtn.style.display = 'none';
            return;
        }

        const latest = snap.docs[0].data();
        currentStatus = latest.status || "Pending";

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
                }[currentStatus] || '';
                bannerSub.textContent = sub;
            }
        }

        // Show resubmit button only if rejected
        if (resubmitBtn) {
            resubmitBtn.style.display = currentStatus === 'Rejected' ? 'inline-flex' : 'none';
            resubmitBtn.onclick = () => submitReport(auth.currentUser?.uid);
        }
    });
}

// ─── COMPILE ALL DATA ─────────────────────────────────────────
async function compileFullData(uid) {
    try {
        // 1. User profile
        const userSnap = await getDoc(doc(db, "users", uid));
        const userData = userSnap.exists() ? userSnap.data() : {};

        reportData.personal = {
            name:    userData.name || `${userData.firstName || ''} ${userData.surname || ''}`.trim() || 'Student',
            school:  userData.school || 'N/A',
            // ✅ FIX: schema uses 'fullSection'
            section: userData.fullSection || userData.section || 'N/A',
            company: userData.company || 'Not Assigned',
            course:  userData.course || 'N/A',
            uid:     uid,
        };

        // ✅ FIX: 'requiredHours' ✓ correct; 'hoursCompleted' not 'completedHours'
        const required  = parseFloat(userData.requiredHours)  || 600;
        const completed = parseFloat(userData.hoursCompleted) || 0;

        // 2. Get adviser name from batch
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

        // 3. Populate UI
        setText('pdf-name',       reportData.personal.name);
        setText('pdf-school',     reportData.personal.school);
        setText('pdf-section',    `${reportData.personal.course} — ${reportData.personal.section}`);
        setText('pdf-supervisor', adviserName);
        setText('pdf-company',    reportData.personal.company);
        setText('pdf-hours',      `${completed.toFixed(1)} hrs`);
        setText('pdf-required',   `${required} hrs`);

        // 4. Attendance logs
        // ✅ FIX: where('uid'), orderBy('timestamp')
        const attQ   = query(
            collection(db, "attendance"),
            where("uid", "==", uid),
            orderBy("timestamp", "desc")
        );
        const attSnap = await getDocs(attQ);
        reportData.attendance = attSnap.docs.map(d => d.data());

        // 5. Checklist
        const checkQ   = query(collection(db, "checklist"), where("uid", "==", uid));
        const checkSnap = await getDocs(checkQ);
        reportData.checklist = checkSnap.docs.map(d => d.data());

        const docsApproved = reportData.checklist.filter(d => d.status === 'Approved').length;

        // Recompute total approved hours
        const totalHours = reportData.attendance
            .filter(a => (a.status || '').toLowerCase() === 'approved')
            .reduce((sum, a) => sum + computeHoursDecimal(a.timeIn, a.timeOut), 0);

        reportData.stats = { totalHours: parseFloat(totalHours.toFixed(2)), docsApproved };

        setText('pdf-docs-count', `${docsApproved}/13`);
        setText('pdf-hours',      `${totalHours.toFixed(1)} hrs`);

        // Wire buttons
        document.getElementById('btn-preview')?.addEventListener('click',  previewReport);
        document.getElementById('btn-download')?.addEventListener('click', downloadPDF);
        document.getElementById('btn-submit')?.addEventListener('click',   () => submitReport(uid));

    } catch (e) {
        console.error('[PDF] compileFullData error:', e);
    }
}

// ─── PDF GENERATION ───────────────────────────────────────────
function buildPDFDoc() {
    if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
        alert('PDF library not loaded. Please refresh and try again.');
        return null;
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');

    const p = reportData.personal;
    const s = reportData.stats;
    const title = document.getElementById('docTitle')?.value
        || 'Comprehensive OJT Progress Report';

    // ── Cover ─────────────────────────────────────────────────
    pdf.setFillColor(26, 26, 26);
    pdf.rect(0, 0, 210, 297, 'F');
    pdf.setTextColor(255, 212, 0);
    pdf.setFontSize(20);
    pdf.setFont('helvetica', 'bold');
    pdf.text('OJTrack PH', 105, 40, { align: 'center' });

    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(14);
    pdf.text(title, 105, 55, { align: 'center' });

    pdf.setDrawColor(255, 212, 0);
    pdf.line(20, 63, 190, 63);

    pdf.setFontSize(10);
    pdf.setTextColor(200, 200, 200);
    const infoRows = [
        ['Student Name', p.name],
        ['School',       p.school],
        ['Course / Section', p.section],
        ['Host Company', p.company],
        ['OJT Adviser',  document.getElementById('pdf-supervisor')?.textContent || 'N/A'],
        ['Hours Completed', `${s.totalHours} hrs`],
        ['Documents Approved', `${s.docsApproved} / 13`],
        ['Generated On', new Date().toLocaleDateString('en-PH', {
            year: 'numeric', month: 'long', day: 'numeric'
        })],
    ];

    let y = 80;
    infoRows.forEach(([label, val]) => {
        pdf.setTextColor(150, 150, 150);
        pdf.text(`${label}:`, 20, y);
        pdf.setTextColor(255, 255, 255);
        pdf.text(String(val), 90, y);
        y += 10;
    });

    // ── Attendance Table ───────────────────────────────────────
    if (reportData.attendance.length > 0) {
        pdf.addPage();
        pdf.setFillColor(26, 26, 26);
        pdf.rect(0, 0, 210, 297, 'F');

        pdf.setTextColor(255, 212, 0);
        pdf.setFontSize(12);
        pdf.text('Attendance Log', 20, 20);

        if (typeof pdf.autoTable === 'function') {
            pdf.autoTable({
                startY: 28,
                head:   [['Date', 'Time In', 'Time Out', 'Hours', 'Status']],
                body:   reportData.attendance.map(a => [
                    a.displayDate || formatTimestamp(a.timestamp),
                    a.timeIn  || '—',
                    a.timeOut || '—',
                    computeHoursDisplay(a.timeIn, a.timeOut),
                    a.status  || 'Pending',
                ]),
                theme:      'grid',
                styles:     { textColor: [255,255,255], fillColor: [30,30,30], fontSize: 8 },
                headStyles: { fillColor: [255,212,0], textColor: [0,0,0], fontStyle: 'bold' },
            });
        }
    }

    return pdf;
}

function previewReport() {
    const pdf = buildPDFDoc();
    if (!pdf) return;

    const iframe = document.getElementById('pdf-preview-iframe');
    const modal  = document.getElementById('previewModal');

    if (iframe && modal) {
        iframe.src = pdf.output('datauristring');
        modal.style.display = 'flex';
        modal.classList.add('show');
    }
}

window.closePreview = function() {
    const modal = document.getElementById('previewModal');
    if (modal) { modal.style.display = 'none'; modal.classList.remove('show'); }
};

function downloadPDF() {
    const pdf = buildPDFDoc();
    if (!pdf) return;
    const name = `${reportData.personal.name.replace(/\s+/g,'_')}_OJT_Report.pdf`;
    pdf.save(name);
}

async function submitReport(uid) {
    if (!uid) return;

    const btn = document.getElementById('btn-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

    try {
        const pdf       = buildPDFDoc();
        const pdfBase64 = pdf ? pdf.output('datauristring') : null;

        // ✅ Write correct 'reports' schema fields
        await setDoc(doc(db, "reports", uid), {
            studentUid:   uid,
            studentName:  reportData.personal.name,
            section:      reportData.personal.section,
            hte:          reportData.personal.company,
            totalHours:   reportData.stats.totalHours,
            docsApproved: reportData.stats.docsApproved,
            status:       'Pending',
            submittedAt:  serverTimestamp(),
            history:      [],
            pdfBase64:    pdfBase64,
        });

        alert('Report submitted! Your adviser will review it shortly.');

    } catch (e) {
        console.error('[PDF] submitReport error:', e);
        alert('Submission failed: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📤 Submit for Review'; }
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
