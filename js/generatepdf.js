import { auth, db } from "../firebase-config.js";
import { protectPage } from "../authguard.js";
import { doc, setDoc, updateDoc, getDoc, getDocs, collection, query, where, onSnapshot, limit, orderBy, serverTimestamp} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
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
    listenForReportStatus(user.uid);
    compileFullData(user.uid);

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

let reportData = {
    personal: {},
    attendance: [],
    checklist: [],
    stats: { totalHours: 0, docsApproved: 0 }
};

let isDataLoaded = false;
let currentStatus = "Not Submitted";

function listenForReportStatus(uid) {
    const statusText = document.getElementById('status-text');
    const downloadBtn = document.getElementById('btn-download');
    const resubmitBtn = document.getElementById('resubmit-btn');

    onSnapshot(doc(db, "reports", uid), (snap) => {
        let status = "Not Submitted";

        if (snap.exists()) {
            const data = snap.data();
            status = data.status || "Pending";
        }

        currentStatus = status;

        // --- STATUS TEXT ---
        if (statusText) {
            statusText.innerText = status.toUpperCase();

            // Reset classes
            statusText.className = "status-badge";

            if (status === "Pending") {
                statusText.classList.add("status-pending");
            } 
            else if (status === "Approved") {
                statusText.classList.add("status-approved");
            } 
            else if (status === "Rejected") {
                statusText.classList.add("status-rejected");
            }
        }

        // --- DOWNLOAD BUTTON ---
        if (downloadBtn) {
            const isApproved = status === "Approved";
            downloadBtn.disabled = !isApproved;
            downloadBtn.style.opacity = isApproved ? "1" : "0.5";
            downloadBtn.style.cursor = isApproved ? "pointer" : "not-allowed";
        }

        // --- RESUBMIT BUTTON ---
        if (resubmitBtn) {
            resubmitBtn.style.display = status === "Rejected" ? "inline-block" : "none";
        }
    });
}

async function compileFullData(uid) {
    try {
        const userSnap = await getDoc(doc(db, "users", uid));
        const userData = userSnap.data() || {};
        
        reportData.personal = {
            name: userData.name || "Student",
            school: userData.school || "N/A",
            section: userData.fullSection || "N/A",
            company: userData.company || "Not Assigned",
            uid: uid
        };

        // SYNC: Finding the Adviser ID linked to this student's batch
        const batchQuery = query(collection(db, "batches"), where("studentUids", "array-contains", uid));
        const batchSnap = await getDocs(batchQuery);
        
        if (!batchSnap.empty) {
            const batchData = batchSnap.docs[0].data();
            reportData.personal.adviserId = batchData.supervisorId; // Link to Adviser
            
            const supSnap = await getDoc(doc(db, "users", batchData.supervisorId));
            reportData.personal.supervisor = supSnap.exists() ? supSnap.data().name : "Adviser Not Found";
        }

        // Attendance & Checklist Processing
        const [attSnap, checkSnap] = await Promise.all([
            getDocs(query(collection(db, "attendance"), where("uid", "==", uid))),
            getDocs(query(collection(db, "checklist"), where("uid", "==", uid)))
        ]);

        let mins = 0;
        attSnap.forEach(d => {
            const data = d.data();
            if (data.status === "Approved") mins += calculateDuration(data.timeIn, data.timeOut);
            reportData.attendance.push([data.displayDate, data.timeIn, data.timeOut, data.note || "---", data.status]);
        });

        checkSnap.forEach(d => {
            const data = d.data();
            if (data.status === "Approved") reportData.stats.docsApproved++;
            reportData.checklist.push([
                data.formKey?.replace(/-/g, ' ').toUpperCase(), 
                data.dateSubmitted || 'N/A', 
                data.status || 'Pending'
            ]);
        });

        reportData.stats.totalHours = (mins / 60).toFixed(1);
        isDataLoaded = true;
        updateUI();
        
        // Update simple UI elements if they exist
        if(document.getElementById('pdf-hours')) document.getElementById('pdf-hours').innerText = `${reportData.stats.totalHours} hrs`;
    } catch (err) {
        console.error("Critical Data Load Error:", err);
    }
}

function calculateDuration(t1, t2) {
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

function updateUI(user) {
    document.getElementById('pdf-name').innerText = reportData.personal.name;
    document.getElementById('pdf-supervisor').innerText = reportData.personal.supervisor || "Pending";
    document.getElementById('pdf-school').innerText = reportData.personal.school;
    document.getElementById('pdf-section').innerText = reportData.personal.section;
    document.getElementById('pdf-company').innerText = reportData.personal.company;
    document.getElementById('pdf-hours').innerText = `${reportData.stats.totalHours} hrs`;
    document.getElementById('pdf-docs-count').innerText = `${reportData.stats.docsApproved}/13`;
}

window.generatePDF = async function (isPreview = false) {
    if (!isDataLoaded) return alert("Loading data...");

    const { jsPDF } = window.jspdf;
    const docpdf = new jsPDF();

    buildPDF(docpdf);

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (isPreview) {
        if (isMobile) {
            // Open in new tab (BEST for mobile)
            const pdfDataUrl = docpdf.output('dataurlstring');
            const newTab = window.open();
            newTab.document.write(`<iframe width="100%" height="100%" src="${pdfDataUrl}"></iframe>`);
        } else {
            // Desktop iframe
            const pdfOutput = docpdf.output('bloburl');
            document.getElementById('pdf-preview-iframe').src = pdfOutput;
            document.getElementById('previewModal').style.display = 'flex';
        }
        return;
    }

    docpdf.save(`OJT_Report_${reportData.personal.name}.pdf`);
};

function buildPDF(docpdf) {
    const user = auth.currentUser;
    const title = document.getElementById('docTitle').value || "OJT Comprehensive Report";
    const timestamp = new Date().toLocaleString();  

    // 1. PROFESSIONAL HEADER
    docpdf.setFillColor(44, 62, 80); // Dark Navy
    docpdf.rect(0, 0, 210, 45, 'F');
    
    docpdf.setTextColor(255, 212, 0); // Gold
    docpdf.setFont("helvetica", "bold");
    docpdf.setFontSize(26);
    docpdf.text("OJTrack PH", 105, 20, { align: "center" });
    
    docpdf.setTextColor(255, 255, 255);
    docpdf.setFontSize(14);
    docpdf.setFont("helvetica", "normal");
    docpdf.text(title, 105, 30, { align: "center" });
    docpdf.setFontSize(10);
    docpdf.text(`Generated on: ${timestamp}`, 105, 38, { align: "center" });

    // 2. SUMMARY BOX (Executive Summary)
    docpdf.autoTable({
        startY: 50,
        head: [['OJT STATISTICS SUMMARY', '']],
        body: [
            ['Total Hours Rendered:', `${reportData.stats.totalHours} Hours`],
            ['Requirements Completed:', `${reportData.stats.docsApproved} of 13 Items`]
        ],
        theme: 'plain',
        styles: { fontSize: 10, cellPadding: 2, fontStyle: 'bold' },
        columnStyles: { 0: { cellWidth: 60 } }
    });

    docpdf.autoTable({
        startY: docpdf.lastAutoTable.finalY + 6,
        head: [['STUDENT PROFILE', 'INSTITUTION & SUPERVISION']],
        body: [[
            `NAME: ${reportData.personal.name}\nCOMPANY: ${reportData.personal.company}\nSECTION: ${reportData.personal.section}`,
            `SCHOOL: ${reportData.personal.school}\nADVISER: ${reportData.personal.supervisor}`
        ]],
        theme: 'grid',
        headStyles: { fillColor: [52, 73, 94] },
        styles: { cellPadding: 5, fontSize: 10 }
    });

    // 4. ATTENDANCE SUMMARY (Updated Title to reflect All Logs)
    docpdf.setTextColor(44, 62, 80);
    docpdf.setFontSize(12);
    docpdf.text("I. ATTENDANCE LOG PROGRESSION", 14, docpdf.lastAutoTable.finalY + 12);

    docpdf.autoTable({
        startY: docpdf.lastAutoTable.finalY + 15,
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
            // Updated Color Logic for Attendance Status
            if (data.section === 'body' && data.column.index === 4) {
                const status = data.cell.raw;
                if (status === 'Approved') data.cell.styles.textColor = [46, 204, 113]; // Green
                if (status === 'Rejected') data.cell.styles.textColor = [231, 76, 60];  // Red
                if (status === 'Pending') data.cell.styles.textColor = [241, 196, 15];  // Yellow/Gold
            }
        }
    });

    // 5. CHECKLIST
    docpdf.addPage();
    docpdf.setFontSize(12);
    docpdf.text("II. REQUIREMENT VERIFICATION", 14, 20);
    
    docpdf.autoTable({
        startY: 25,
        head: [['Requirement Item', 'Submission Date', 'Status']],
        body: reportData.checklist,
        headStyles: { fillColor: [230, 126, 34] },
        styles: { fontSize: 9 },
        didParseCell: function(data) {
            // Updated Color Logic for Checklist Status
            if (data.section === 'body' && data.column.index === 2) {
                const status = data.cell.raw;
                if (status === 'Approved') data.cell.styles.textColor = [46, 204, 113]; // Green
                if (status === 'Rejected') data.cell.styles.textColor = [231, 76, 60];  // Red
                if (status === 'Pending') data.cell.styles.textColor = [230, 126, 34];  // Orange
                if (status?.includes('Waiting')) data.cell.styles.textColor = [149, 165, 166]; // Grey
            }
        }
    });

    // 6. CERTIFICATION STATEMENT
    const certY = docpdf.lastAutoTable.finalY + 20;
    docpdf.setFontSize(10);
    docpdf.setFont("helvetica", "italic");
    docpdf.setTextColor(100, 100, 100); 

    const certMessage = "I hereby certify that the information provided in this report is true and accurate to the best of my knowledge, representing the actual hours rendered and requirements submitted for the OJT/practicum program.";

    const splitMessage = docpdf.splitTextToSize(certMessage, 180);
    docpdf.text(splitMessage, 20, certY);

    // 7. SIGNATURE SECTION
    const signY = certY + 20; 
    docpdf.setTextColor(0, 0, 0);
    docpdf.line(14, signY, 80, signY); 
    docpdf.line(130, signY, 196, signY); 

    docpdf.setFont("helvetica", "bold");
    docpdf.text("Student Signature", 47, signY + 5, { align: "center" });
    docpdf.text("Adviser Signature", 163, signY + 5, { align: "center" });
};

window.closePreview = () => {
    document.getElementById('previewModal').style.display = 'none';
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-preview').onclick = () => window.generatePDF(true);
    document.getElementById('btn-download').onclick = () => window.generatePDF(false);

    const submitBtn = document.getElementById('btn-submit');
    if (submitBtn) submitBtn.onclick = window.submitReport;
});

function updateUIOverview() {
    document.getElementById('pdf-hours').innerText = `${reportData.stats.totalHours} hrs`;
    document.getElementById('pdf-docs-count').innerText = `${reportData.stats.docsApproved}/13`;
}

window.submitReport = async function () {
    const user = auth.currentUser;

    try {
        await setDoc(doc(db, "reports", user.uid), {
            studentUid: user.uid,
            studentName: reportData.personal.name,
            section: reportData.personal.section,
            hte: reportData.personal.company,
            totalHours: reportData.stats.totalHours,
            docsApproved: reportData.stats.docsApproved,
            status: "Pending",
            submittedAt: serverTimestamp(),
            adviserId: reportData.personal.adviserId || ""
        }, { merge: true });

        alert("Report submitted for review!");
    } catch (e) {
        console.error(e);
        alert("Submission failed.");
    }
};

document.getElementById('resubmit-btn').onclick = async () => {
    if (!confirm("Resubmit your report?")) return;

    try {
        const ref = doc(db, "reports", auth.currentUser.uid);
        const snap = await getDoc(ref);

        if (!snap.exists()) return alert("No report found.");

        const data = snap.data();

        await updateDoc(ref, {
            status: "Pending",
            resubmittedAt: serverTimestamp(),
            history: [
                ...(data.history || []),
                {
                    action: "Resubmitted",
                    by: "student",
                    message: "Student resubmitted the report",
                    timestamp: new Date()
                }
            ]
        });

        alert("Report resubmitted successfully!");

    } catch (e) {
        console.error(e);
        alert("Resubmit failed.");
    }
};