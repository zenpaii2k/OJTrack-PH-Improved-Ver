import { protectPage } from "../authguard.js";
import { db, auth } from "../firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    collection, query, where, getDocs, getDoc, doc, addDoc, serverTimestamp, orderBy, limit, onSnapshot, updateDoc 
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

import { setupNotificationSystem } from '../js/notifications.js';


initTheme();

let selectedStudentId = null;
let currentReportPdf = null; 
const nameCache = {}; 
let state = { 
    attendance: [], 
    documents: [], 
    myStudentUids: new Set() 
};

protectPage('supervisor');

onAuthStateChanged(auth, async (user) => {
    if (user) {
        await fetchUserProfile(user);
        setupInteractions(user);
        syncBatchesForThisSupervisor(user.uid);
        initCombinedRealTimeDashboard(user);
        setupNotificationSystem(user.uid);
    } else {
        window.location.replace("/index.html");
    }
});

// --- BATCH & STUDENT LOADING ---

async function syncBatchesForThisSupervisor(supervisorUid) {
    const programSelector = document.getElementById('program-selector');
    if (!programSelector) return;

    try {
        const q = query(collection(db, "batches"), where("supervisorId", "==", supervisorUid));
        const querySnapshot = await getDocs(q);
        
        let optionsHTML = '<option value="" disabled selected>Select Your Assigned Batch</option>';
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            optionsHTML += `<option value="${doc.id}">${data.name || data.batchName}</option>`;
        });
        programSelector.innerHTML = optionsHTML;
        programSelector.onchange = (e) => loadStudentsFromBatch(e.target.value);

    } catch (error) {
        console.error("Error loading specific batches:", error);
    }
}

function initCombinedRealTimeDashboard(user) {

    updateTotalStats(user).then((uids) => {
        state.myStudentUids = uids;
        
        // Listener for Attendance
        const attendanceQ = query(collection(db, "attendance"), orderBy("timestamp", "asc"), limit(50));
        onSnapshot(attendanceQ, (snapshot) => {
            state.attendance = snapshot.docs.map(d => ({ id: d.id, ...d.data(), type: 'attendance' }));
            renderUI(user);
        });

        // Listener for Requirements
        const checklistQ = query(collection(db, "checklist"), orderBy("timestamp", "asc"), limit(50));
        onSnapshot(checklistQ, (snapshot) => {
            state.documents = snapshot.docs.map(d => ({ id: d.id, ...d.data(), type: 'document' }));
            renderUI(user);
        });
    });

}

const renderUI = (user) => {
    updateNotificationUI(user);
};

async function updateNotificationUI(user) {
    if (!user || !user.uid) return;

    const notifList = document.getElementById('notif-list');
    const notifCount = document.getElementById('notif-count');
    const clearBtn = document.getElementById('clear-all-notifs'); 
    
    // Fetch the most up-to-date dismissed list from storage
    const storageKey = `sup_dismissed_${user.uid}`;
    const dismissedIds = JSON.parse(localStorage.getItem(storageKey) || "[]");

    // Filter: 1. Must be your student, 2. Must NOT be in the dismissed list
    let notificationItems = [...state.attendance, ...state.documents]
        .filter(item => {
            const isMyStudent = state.myStudentUids.has(item.uid);
            const isNotDismissed = !dismissedIds.includes(item.id);
            return isMyStudent && isNotDismissed;
        })
        .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

    // Update the Badge Count
    if (notifCount) {
        const count = notificationItems.length;
        notifCount.innerText = count;
        // Ensure it's hidden if count is 0 to stop "flashing" icons
        notifCount.style.display = count > 0 ? 'flex' : 'none';
    }

    if (clearBtn) {
        clearBtn.style.display = notificationItems.length > 0 ? 'block' : 'none';
    }

    if (notificationItems.length === 0) {
        notifList.innerHTML = '<div class="notif-empty" style="padding:20px; text-align:center; color:#888;">No new alerts.</div>';
        return;
    }

    const notifHTML = await Promise.all(notificationItems.map(async (item) => {
        const studentName = await getStudentName(item.uid);
        const timeAgo = item.timestamp ? new Date(item.timestamp.seconds * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "Just now";
        const isLog = item.type === 'attendance';
        
        return `
            <div class="notif-item" style="padding: 12px; border-bottom: 1px solid #333; position: relative; background: #1e1e1e; margin-bottom: 5px; border-radius: 4px;">
                <div style="font-weight: bold; color: #ffd400; font-size: 0.8rem; margin-bottom: 4px;">
                    ${isLog ? '🕒 Attendance Log' : '📄 Requirement Upload'}
                </div>
                <div style="font-size: 0.85rem; color: #fff; padding-right: 20px;">
                    <strong>${studentName}</strong> ${isLog ? `logged ${item.timeIn} - ${item.timeOut}` : `uploaded ${(item.formKey || 'file').replace(/-/g, ' ')}`}
                </div>
                <div style="font-size: 0.7rem; color: #888; margin-top: 5px;">${timeAgo}</div>
                <button onclick="dismissSingleNotif('${item.id}', '${user.uid}')" 
                        style="position: absolute; top: 8px; right: 8px; background: none; border: none; color: #ff4d4d; cursor: pointer; font-size: 1.2rem;">
                    &times;
                </button>
            </div>
        `;
    }));
    notifList.innerHTML = notifHTML.join("");
}

async function updateTotalStats(user) {
    const batchQuery = query(collection(db, "batches"), where("supervisorId", "==", user.uid));
    const batchSnap = await getDocs(batchQuery);

    const uniqueStudents = new Set();

    batchSnap.forEach(docSnap => {
        const data = docSnap.data();
        if (data.studentUids) {
            data.studentUids.forEach(uid => uniqueStudents.add(uid));
        }
    });

    state.myStudentUids = uniqueStudents;
    return uniqueStudents;
}

async function getStudentName(uid) {
    if (nameCache[uid]) return nameCache[uid];
    const userDoc = await getDoc(doc(db, "users", uid));
    let name = "Unknown Student";
    if (userDoc.exists()) {
        const d = userDoc.data();
        name = d.name || `${d.firstName || ''} ${d.surname || ''}`.trim() || "Anonymous";
    }
    nameCache[uid] = name;
    return name;
}

window.dismissSingleNotif = (id, userId) => {
    const dismissed = JSON.parse(localStorage.getItem(`sup_dismissed_${userId}`) || "[]");
    dismissed.push(id);
    localStorage.setItem(`sup_dismissed_${userId}`, JSON.stringify(dismissed));
    updateNotificationUI({ uid: userId }); 
};

function setupInteractions(user) {
    const profileMenu = document.getElementById('profile-menu');
    const notifModal = document.getElementById('notif-modal');
    const notifBtn = document.getElementById('notif-btn');
    const clearAllBtn = document.getElementById('clear-all-notifs');
    const themeBtn = document.getElementById('theme-toggle-btn');
    const logoutBtn = document.getElementById('logout-link');

    if (document.getElementById('profile-trigger')) {
        document.getElementById('profile-trigger').onclick = (e) => {
            e.stopPropagation();
            profileMenu?.classList.toggle('show');
            notifModal?.classList.remove('show');
        };
    }
    
    if (notifBtn) {
        notifBtn.onclick = (e) => {
            e.stopPropagation();
            notifModal.classList.toggle('show');
        };
    }

    if (clearAllBtn) {
        clearAllBtn.onclick = (e) => {
            e.stopPropagation();
            const currentIds = [...state.attendance, ...state.documents].map(item => item.id);
            const dismissed = JSON.parse(localStorage.getItem(`sup_dismissed_${user.uid}`) || "[]");
            localStorage.setItem(`sup_dismissed_${user.uid}`, JSON.stringify([...new Set([...dismissed, ...currentIds])]));
            updateNotificationUI(user);
        };
    }

    if (logoutBtn) {
        logoutBtn.onclick = () => signOut(auth).then(() => location.replace("/index.html"));
    }

    window.onclick = () => {
        profileMenu?.classList.remove('show');
        notifModal?.classList.remove('show');
    };
}

async function fetchUserProfile(user) {
    try {
        const userSnap = await getDoc(doc(db, "users", user.uid)); 
        if (userSnap.exists()) {
            const userData = userSnap.data();
            const name = userData.name || "User";
            if (document.getElementById('user-display-name')) document.getElementById('user-display-name').innerText = name;
            if (document.getElementById('user-display-name-pop')) document.getElementById('user-display-name-pop').innerText = name;
            if (document.getElementById('user-full-email')) document.getElementById('user-full-email').innerText = user.email;
        } 
    } catch (e) { console.error("Profile Error:", e); }
}

function setupNotificationSystem(user) {
    let activeNotifications = [];

    const updateNotifUI = () => {
        const notifCount = document.getElementById('notif-count');
        const notifList = document.getElementById('notif-list');

        const dismissed = JSON.parse(
            localStorage.getItem(`sup_dismissed_${user.uid}`) || "[]"
        );

        const visible = activeNotifications.filter(n => !dismissed.includes(n.id));

        if (notifCount) {
            notifCount.innerText = visible.length;
            notifCount.style.display = visible.length ? "flex" : "none";
        }

        if (notifList) {
            if (visible.length === 0) {
                notifList.innerHTML = `<div class="notif-empty">No new alerts.</div>`;
                return;
            }

            notifList.innerHTML = visible
                .sort((a, b) => b.createdAt - a.createdAt)
                .map(n => `
                    <div class="notif-item">
                        <div style="font-weight:bold;">
                            ${n.title}
                        </div>
                        <div style="font-size:0.85rem;">
                            ${n.message}
                        </div>
                        <button onclick="dismissNotif('${n.id}')">×</button>
                    </div>
                `).join("");
        }
    };

    window.dismissNotif = (id) => {
        const key = `sup_dismissed_${user.uid}`;
        const dismissed = JSON.parse(localStorage.getItem(key) || "[]");
        if (!dismissed.includes(id)) {
            dismissed.push(id);
            localStorage.setItem(key, JSON.stringify(dismissed));
        }

        activeNotifications = activeNotifications.filter(n => n.id !== id);
        updateNotifUI();
    };

    // checklist

    onSnapshot(collection(db, "checklist"), (snap) => {
        snap.docChanges().forEach(change => {
            const d = change.doc.data();
            const id = `chk_${change.doc.id}`;

            if (!state.myStudentUids.has(d.uid)) return;

            if ((d.status === "Approved" || d.status === "Rejected")) {
                if (!activeNotifications.find(n => n.id === id)) {
                    activeNotifications.push({
                        id,
                        createdAt: Date.now(),
                        title: "📄 Document Update",
                        message: `${d.formKey} was ${d.status}`
                    });
                }
            }
        });

        updateNotifUI();
    });

    // feedback
    onSnapshot(
        query(collection(db, "students", user.uid, "feedback"), orderBy("timestamp", "desc"), limit(10)),
        (snap) => {
            snap.docChanges().forEach(change => {
                const id = `fb_${change.doc.id}`;

                if (change.type === "added") {
                    if (!activeNotifications.find(n => n.id === id)) {
                        activeNotifications.push({
                            id,
                            createdAt: Date.now(),
                            title: "💬 New Feedback",
                            message: "You received new adviser feedback"
                        });
                    }
                }
            });

            updateNotifUI();
        }
    );
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('program-selector').addEventListener('change', (e) => {
        loadStudentsFromBatch(e.target.value);
    });

    if (document.getElementById('send-feedback-btn')) {
        document.getElementById('send-feedback-btn').onclick = sendFeedback;
    }
});

async function loadStudentsFromBatch(batchId) {
    if (!batchId) return;
    const listContainer = document.getElementById('student-list');
    const studentCountDisp = document.getElementById('student-count');

    // FIX 1: Clear container immediately to prevent duplicates
    listContainer.innerHTML = '<div class="loading-spinner" style="color:#aaa; padding:20px;">Loading...</div>';

    // We query students where their 'batch' field matches the selected Batch ID
    const q = query(collection(db, "users"), where("batch", "==", batchId), where("role", "==", "student"));

    try {
        const snapshot = await getDocs(q);
        listContainer.innerHTML = ""; // Clear spinner
        studentCountDisp.innerText = snapshot.size;
        
        if (snapshot.empty) {
            listContainer.innerHTML = '<p style="padding:20px; color:#666;">No students in this batch.</p>';
            return;
        }

        snapshot.forEach(async (studentDoc) => {
            const student = studentDoc.data();
            const uid = studentDoc.id;
            const fullName = student.name || `${student.firstName} ${student.surname}`;

            const card = document.createElement('div');
            card.className = "student-card";
            card.innerHTML = `
                <div class="card-avatar">👤</div>
                <div class="card-info">
                    <strong>${fullName}</strong>
                    <small style="display:block; color:#888;">${student.course || 'N/A'}</small>
                </div>
            `;
            card.onclick = () => displayFullReport(uid, student);
            listContainer.appendChild(card);
        });
    } catch (e) {
        console.error("Load Students Error:", e);
    }
}

async function getStudentStats(uid) {
    const attQ = query(collection(db, "attendance"), where("uid", "==", uid));
    const attSnap = await getDocs(attQ);
    let totalMins = 0;

    attSnap.forEach(d => {
        const data = d.data();
        if (data.timeIn && data.timeOut) {
            totalMins += calculateMinutes(data.timeIn, data.timeOut);
        }
    });

    const docQ = query(collection(db, "checklist"), where("uid", "==", uid), where("status", "==", "Approved"));
    const docSnap = await getDocs(docQ);

    return { 
        hours: Math.floor(totalMins / 60), 
        docs: docSnap.size
    };
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
        let approvedCount = 0;
        
        checkSnap.forEach(d => {
            const data = d.data();
            if (data.status === "Approved") approvedCount++;
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
                docsApproved: approvedCount
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
    const doc = new jsPDF();
    const timestamp = new Date().toLocaleString();  

    // 1. PROFESSIONAL HEADER (Aligned Colors)
    doc.setFillColor(44, 62, 80); // Dark Navy
    doc.rect(0, 0, 210, 45, 'F');
    
    doc.setTextColor(255, 212, 0); // Gold
    doc.setFont("helvetica", "bold");
    doc.setFontSize(26);
    doc.text("OJTrack PH", 105, 20, { align: "center" });
    
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(14);
    doc.setFont("helvetica", "normal");
    doc.text("OJT Comprehensive Report", 105, 30, { align: "center" });
    doc.setFontSize(10);
    doc.text(`Generated on: ${timestamp}`, 105, 38, { align: "center" });

    // 2. SUMMARY BOX
    doc.autoTable({
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
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 6,
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
    doc.setTextColor(44, 62, 80);
    doc.setFontSize(12);
    doc.text("I. ATTENDANCE LOG PROGRESSION", 14, doc.lastAutoTable.finalY + 12);

    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 15,
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
    doc.addPage();
    doc.setFontSize(12);
    doc.text("II. REQUIREMENT VERIFICATION", 14, 20);
    
    doc.autoTable({
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
    const signY = doc.lastAutoTable.finalY + 40; 
    doc.setTextColor(0, 0, 0);
    doc.line(14, signY, 80, signY); 
    doc.line(130, signY, 196, signY); 
    doc.setFont("helvetica", "bold");
    doc.text("Student Signature", 47, signY + 5, { align: "center" });
    doc.text("Adviser Signature", 163, signY + 5, { align: "center" });

    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (isMobile) {
        const pdfDataUrl = doc.output('dataurlstring');
        const newTab = window.open();
        newTab.document.write(`<iframe width="100%" height="100%" src="${pdfDataUrl}"></iframe>`);
    } else {
        const pdfOutput = doc.output('bloburl');
        const iframe = document.getElementById('adviser-pdf-preview');
        if (iframe) iframe.src = pdfOutput;
    }
}

// --- CORE ACTIONS ---

async function displayFullReport(uid, data) {
    selectedStudentId = uid;
    
    // UI Visibility
    document.getElementById('no-selection-msg').style.display = 'none';
    document.getElementById('active-report-view').style.display = 'block';
    
    // Populate Header (HTE, Section, etc.)
    const fullName = data.name || `${data.firstName} ${data.surname}`;
    document.getElementById('view-student-name').innerText = fullName;
    document.getElementById('view-student-email').innerText = data.email || "N/A";
    document.getElementById('view-student-course').innerText = data.course || "N/A";
    document.getElementById('view-student-section').innerText = data.section || "N/A";
    document.getElementById('view-student-hte').innerText = data.company || data.hte || "Not Assigned";

    // Setup Decision Buttons with Validation
    document.getElementById('approve-report-btn').onclick = () => processReportDecision('Approved');
    document.getElementById('reject-report-btn').onclick = () => processReportDecision('Rejected');
    
    // Generate Preview
    const reportData = await compileStudentPreviewData(uid, data);
    if (reportData) {
        currentReportPdf = generateAdviserPreview(reportData);
    }

    const reportSnap = await getDoc(doc(db, "reports", uid));
    if (reportSnap.exists()) {
    renderHistory(reportSnap.data().history);
}
}

async function processReportDecision(status) {
    const feedbackBody = document.getElementById('feedback-body').value.trim();

    if (!feedbackBody) {
        alert("Action Required: You must provide feedback.");
        document.getElementById('feedback-body').focus();
        return;
    }

    if (!confirm(`Are you sure you want to mark this report as ${status}?`)) return;

    try {
        const adviserName = document.getElementById('user-display-name').innerText;

        const reportRef = doc(db, "reports", selectedStudentId);

        const snap = await getDoc(reportRef);
        if (!snap.exists()) {
            alert("Error: Report not found. Student has not submitted yet.");
            return;
        }

        const data = snap.data();

        await updateDoc(reportRef, {
            status: status,
            reviewedBy: adviserName,
            reviewedAt: serverTimestamp(),
            lastAction: status,
            history: [
                ...(data.history || []),
                {
                    action: status,
                    by: "Adviser",
                    message: feedbackBody,
                    timestamp: new Date()
                }
            ]
        });

        // Send feedback
        await addDoc(collection(db, "students", selectedStudentId, "feedback"), {
            senderName: adviserName,
            senderRole: "OJT Adviser",
            subject: "OJT Report Evaluation",
            message: feedbackBody,
            type: status.toLowerCase(),
            timestamp: serverTimestamp()
        });

        alert(`Report ${status} successfully.`);
        document.getElementById('feedback-body').value = "";

    } catch (e) {
        console.error("Decision Error:", e);
        alert("Failed to update report status.");
    }
}

document.getElementById('download-report-btn').onclick = () => {
    if (currentReportPdf) {
        const studentName = document.getElementById('view-student-name').innerText;
        currentReportPdf.save(`OJT_Report_${studentName.replace(/\s+/g, '_')}.pdf`);
    } else {
        alert("No report generated to download.");
    }
};

window.sendFeedback = async () => {
    const messageInput = document.getElementById('feedback-body');
    
    if (!selectedStudentId || !messageInput.value.trim()) {
        alert("Select a student and enter a message.");
        return;
    }

    try {
        const name = document.getElementById('user-display-name')?.innerText || "Adviser";
        await addDoc(collection(db, "students", selectedStudentId, "feedback"), {
            senderName: name,
            senderRole: "OJT Adviser",
            subject: "OJT Report Evaluation",
            message: messageInput.value,
            timestamp: serverTimestamp()
        });

        alert("Feedback sent!");
        messageInput.value = "";
    } catch (e) { alert("Error: " + e.message); }
};

function renderHistory(history = []) {
    const container = document.getElementById("report-history");

    if (!container) return;

    container.innerHTML = history.map(h => `
        <div style="padding:8px; border-bottom:1px solid #333;">
            <strong>${h.action}</strong> by ${h.by}
            <br>
            <small>${new Date(h.timestamp).toLocaleString()}</small>
            ${h.message ? `<p>${h.message}</p>` : ""}
        </div>
    `).join("");
}
