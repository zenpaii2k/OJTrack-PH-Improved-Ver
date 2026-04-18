import { auth, db } from "../firebase-config.js";
import { protectPage } from "../authguard.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    collection, query, where, getDocs, limit, orderBy, onSnapshot, doc, getDoc 
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

// --- 1. INITIALIZATION & STATE ---
const nameCache = {}; 
let state = {
    attendance: [],
    documents: [],
    myStudentUids: new Set() 
};

let currentMonth = new Date();

// --- 2. AUTH LISTENER ---
protectPage('supervisor').then((user) => {
    if (user) {
        fetchUserProfile(user);
        renderCalendar(currentMonth);
        initCombinedRealTimeDashboard(user);
        setupInteractions(user);
        setupNotificationSystem(user.uid);
    }
});

// --- 3. UI INTERACTIONS ---
function setupInteractions(user) {
    const profileMenu = document.getElementById('profile-menu');
    const notifModal = document.getElementById('notif-modal');

    document.getElementById('profile-trigger').onclick = (e) => {
        e.stopPropagation();
        profileMenu.classList.toggle('show');
    };

    document.getElementById('notif-btn').onclick = (e) => {
        e.stopPropagation();
        notifModal.classList.toggle('show');
    };

    window.onclick = () => {
        profileMenu.classList.remove('show');
        notifModal.classList.remove('show');
    };

    document.getElementById('prevMonth').onclick = () => {
        currentMonth.setMonth(currentMonth.getMonth() - 1);
        renderCalendar(currentMonth);
    };
    document.getElementById('nextMonth').onclick = () => {
        currentMonth.setMonth(currentMonth.getMonth() + 1);
        renderCalendar(currentMonth);
    };

    document.getElementById('clear-all-notifs').onclick = (e) => {
    e.stopPropagation();
    
    // Get ALL current IDs from state that belong to your students
    const idsToDismiss = [...state.attendance, ...state.documents]
        .filter(item => state.myStudentUids.has(item.uid))
        .map(item => item.id);
    
    // Merge with existing dismissed items in localStorage
    const storageKey = `sup_dismissed_${user.uid}`;
    const dismissed = JSON.parse(localStorage.getItem(storageKey) || "[]");
    
    // Use a Set to ensure we don't have duplicate IDs, then save back to localStorage
    const updatedDismissed = [...new Set([...dismissed, ...idsToDismiss])];
    localStorage.setItem(storageKey, JSON.stringify(updatedDismissed));

};

    document.getElementById('logout-link').onclick = () => signOut(auth).then(() => location.replace("/index.html"));
}

// --- 4. DATA FETCHING & NOTIFICATIONS ---

async function fetchUserProfile(user) {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (userSnap.exists()) {
        const data = userSnap.data();
        document.getElementById('user-display-name').innerText = data.name;
        document.getElementById('user-display-name-pop').innerText = data.name;
        document.getElementById('user-full-email').innerText = user.email;
    }
}

let isAttendanceLoaded = false;
let isDocumentsLoaded = false;

const notifState = {
    active: []
};

function initCombinedRealTimeDashboard(user) {
    updateTotalStats(user).then((uids) => {
        state.myStudentUids = uids;

        const attendanceQ = query(
            collection(db, "attendance"),
            orderBy("timestamp", "desc"),
            limit(50)
        );

        onSnapshot(attendanceQ, (snapshot) => {
            state.attendance = snapshot.docs.map(d => ({
                id: d.id,
                ...d.data(),
                type: "attendance"
            }));

            isAttendanceLoaded = true;
            checkAndRender(user);
        });

        const checklistQ = query(
            collection(db, "checklist"),
            orderBy("timestamp", "desc"),
            limit(50)
        );

        onSnapshot(checklistQ, (snapshot) => {
            state.documents = snapshot.docs.map(d => ({
                id: d.id,
                ...d.data(),
                type: "document"
            }));

            isDocumentsLoaded = true;
            checkAndRender(user);
        });
    });
}

function checkAndRender(user) {
    if (isAttendanceLoaded && isDocumentsLoaded) {
        renderUI(user);
    }
}

const renderUI = (user) => {
    renderRecentSubmissionsTable();
};

window.dismissSingleNotif = (id, userId) => {
    const key = `sup_dismissed_${userId}`;
    const dismissed = JSON.parse(localStorage.getItem(key) || "[]");

    if (!dismissed.includes(id)) {
        dismissed.push(id);
        localStorage.setItem(key, JSON.stringify(dismissed));
    }

    updateNotificationUI({ uid: userId });
};

async function renderRecentSubmissionsTable() {
    const tbody = document.getElementById('recent-submissions-body');
    if (!tbody) return;

    // Table shows everything for the supervisor's students, regardless of dismissal status
    let tableItems = [...state.attendance, ...state.documents]
        .filter(item => state.myStudentUids.has(item.uid))
        .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

    const displayItems = tableItems.slice(0, 7);
    if (displayItems.length === 0) {
        tbody.innerHTML = "<tr><td colspan='3'>No recent activity.</td></tr>";
        return;
    }

    const rowPromises = displayItems.map(async (activity) => {
        const studentName = await getStudentName(activity.uid);
        const isLog = activity.type === 'attendance';
        let statusHTML = isLog 
            ? `<span class="status-badge" style="background:#2ecc71; color:white; padding:3px 8px; border-radius:4px;">Logged ${activity.timeIn || 'Time'}</span>`
            : `<span class="status-badge" style="background:#3498db; color:white; padding:3px 8px; border-radius:4px;">Uploaded ${(activity.formKey || "Doc").toUpperCase()}</span>`;

        let link = isLog ? "checkstudentdatabase.html" : "checkstudentreq.html";
        let linkText = isLog ? "Review Logs" : "Review Reqs";

        return `<tr>
            <td>${studentName}</td>
            <td>${statusHTML}</td>
            <td><a href="${link}" style="color:#ffd400; text-decoration:none; font-weight:bold;">${linkText}</a></td>
        </tr>`;
    });

    const allRows = await Promise.all(rowPromises);
    tbody.innerHTML = allRows.join("");
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

async function updateTotalStats(user) {
    try {
        // 1. Fetch Batches to identify which students belong to this supervisor
        const batchQuery = query(collection(db, "batches"), where("supervisorId", "==", user.uid));
        const batchSnap = await getDocs(batchQuery);
        
        const uniqueStudents = new Set();
        batchSnap.forEach(doc => {
            const data = doc.data();
            if (data.studentUids && Array.isArray(data.studentUids)) {
                data.studentUids.forEach(uid => uniqueStudents.add(uid));
            }
        });

        let pendingReportsCount = 0;
        let pendingLogsCount = 0;

        if (uniqueStudents.size > 0) {
            // 2. Fetch Pending Requirements
            const reportsSnap = await getDocs(collection(db, "checklist"));
            reportsSnap.forEach(doc => {
                const data = doc.data();
                if (uniqueStudents.has(data.uid) && (data.status === "Pending" || data.status === "Pending Approval")) {
                    pendingReportsCount++;
                }
            });

            // 3. Fetch Pending Attendance Logs
            const logsSnap = await getDocs(collection(db, "attendance"));
            logsSnap.forEach(doc => {
                const data = doc.data();
                // Check if student belongs to supervisor AND status is Pending
                if (uniqueStudents.has(data.uid) && (data.status === "Pending" || !data.status)) {
                    pendingLogsCount++;
                }
            });
        }

        // Update UI
        const studentEl = document.getElementById('stat-total-students');
        const batchEl = document.getElementById('stat-total-batches');
        const reportsEl = document.getElementById('stat-pending-reports');
        const logsEl = document.getElementById('stat-pending-logs');

        if (studentEl) studentEl.innerText = uniqueStudents.size;
        if (batchEl) batchEl.innerText = batchSnap.size;
        if (reportsEl) reportsEl.innerText = pendingReportsCount;
        if (logsEl)  logsEl.innerText = pendingLogsCount;
        
        return uniqueStudents;
    } catch (error) {
        console.error("Error fetching stats:", error);
        return new Set();
    }
}

function renderCalendar(date) {
    const calGrid = document.getElementById('mini-calendar');
    const monthDisplay = document.getElementById('monthDisplay');
    if(!calGrid) return;
    calGrid.innerHTML = '';
    const year = date.getFullYear();
    const month = date.getMonth();
    monthDisplay.innerText = date.toLocaleString('default', { month: 'long', year: 'numeric' });
    ['S','M','T','W','T','F','S'].forEach(d => { const el = document.createElement('b'); el.innerText = d; calGrid.appendChild(el); });
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    for (let i = 0; i < firstDay; i++) calGrid.appendChild(document.createElement('div'));
    for (let i = 1; i <= daysInMonth; i++) {
        const dayEl = document.createElement('div');
        dayEl.innerText = i;
        if (i === today.getDate() && month === today.getMonth() && year === today.getFullYear()) {
            dayEl.style.background = "#007bff"; dayEl.style.color = "white"; dayEl.style.borderRadius = "50%";
        }
        calGrid.appendChild(dayEl);
    }
}