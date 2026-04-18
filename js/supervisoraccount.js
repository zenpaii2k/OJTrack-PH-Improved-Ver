import { db, auth } from "../firebase-config.js";
import { protectPage } from "../authguard.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc, collection, query, where, getDocs, orderBy, limit, onSnapshot, updateDoc, arrayUnion} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
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

const nameCache = {}; 
let state = {
    attendance: [],
    documents: [],
    myStudentUids: new Set(),
};

let currentSupervisorUid = null;

protectPage('supervisor').then((user) => {
    currentSupervisorUid = user.uid;

    loadSupervisorData(user);
    setupInteractions(user);
    setupNotificationSystem(user.uid);

    updateTotalStats(user).then((uids) => {
        state.myStudentUids = uids;
        initCombinedRealTimeDashboard(user);
    });
});

function setupInteractions(user) {

    const profileMenu = document.getElementById('profile-menu');
    const notifBtn = document.getElementById('notif-btn');
    const notifModal = document.getElementById('notif-modal');
    if (notifBtn) {
        notifBtn.onclick = (e) => {
            e.stopPropagation();
            notifModal.classList.toggle('show');
        };
    }

    const clearBtn = document.getElementById('clear-all-notifs');

if (clearBtn) {
    clearBtn.onclick = async (e) => {
        e.stopPropagation();

        const updates = [];

        [...state.attendance, ...state.documents].forEach(item => {
            const collectionName = item.type === 'attendance' ? 'attendance' : 'checklist';
            const docRef = doc(db, collectionName, item.id);

            updates.push(updateDoc(docRef, {
                dismissedBy: arrayUnion(user.uid)
            }));
        });

        await Promise.all(updates);

        const key = `sup_dismissed_${user.uid}`;

        const allIds = [
            ...state.attendance.map(i => i.id),
            ...state.documents.map(i => i.id)
        ];

        const existing = JSON.parse(localStorage.getItem(key) || "[]");

        localStorage.setItem(
            key,
            JSON.stringify([...new Set([...existing, ...allIds])])
        );

    };
}

    const navItems = document.querySelectorAll('.settings-list .nav-item');
    const sections = document.querySelectorAll('.content-section');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetSectionId = item.getAttribute('data-section');

            // 1. Update Active Sidebar Class
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            // 2. Hide ALL sections and show the target one
            sections.forEach(section => {
                section.style.display = 'none';
                if (section.id === targetSectionId) {
                    section.style.display = 'block';
                }
            });

            // 3. Trigger Load specifically for batch
            if (targetSectionId === 'batch-content') {
                loadBatchList();
            }
        });
    });

    // Dropdowns
    document.getElementById('profile-trigger').onclick = (e) => {
        e.stopPropagation();
        profileMenu.classList.toggle('show');
    };

    document.getElementById('logout-link').onclick = () => signOut(auth).then(() => location.replace("/index.html"));
}

function initCombinedRealTimeDashboard(user) {

    updateTotalStats(user).then((uids) => {
        state.myStudentUids = uids;
        
        // Listener for Attendance
        const attendanceQ = query(collection(db, "attendance"), orderBy("timestamp", "asc"), limit(50));
        onSnapshot(attendanceQ, (snapshot) => {
            state.attendance = snapshot.docs.map(d => ({ id: d.id, ...d.data(), type: 'attendance' }));
        });

        // Listener for Requirements
        const checklistQ = query(collection(db, "checklist"), orderBy("timestamp", "asc"), limit(50));
        onSnapshot(checklistQ, (snapshot) => {
            state.documents = snapshot.docs.map(d => ({ id: d.id, ...d.data(), type: 'document' }));
        });
    });
}


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

// Necessary for resolving names in notifications
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
};

async function loadSupervisorData(user) {
    try {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        if (!userDoc.exists()) return;

        const data = userDoc.data();
        const fullName = data.name || `${data.firstName || ''} ${data.surname || ''}`.trim() || "OJT Adviser";

        // Update UI
        document.getElementById('user-display-name').innerText = fullName;
        document.getElementById('user-display-name-pop').innerText = fullName;
        document.getElementById('user-full-email').innerText = user.email;
        document.getElementById('display-name').innerText = fullName;
        document.getElementById('display-staff-id').innerText = data.staffId || "NOT SET";
        document.getElementById('display-dept').innerText = data.organization || "No Department";

        const courses = data.assignedCourses || data.assignedClass || [];
        
        const formattedCourses = Array.isArray(courses) ? courses.join(', ') : courses;
        
        const courseElement = document.getElementById('display-assigned-courses') || document.getElementById('display-courses');
        if (courseElement) {
            courseElement.innerText = formattedCourses || "None Assigned";
        }

        // Store as array globally for other functions (like stats)
        window.supervisorCourses = Array.isArray(courses) ? courses : [courses];

        // Prefills
        document.getElementById('profile-fullname').value = fullName;
        document.getElementById('profile-email').value = user.email;
        document.getElementById('profile-designation').value = "Adviser";
        document.getElementById('profile-number').value = data.number;

        fetchRealStats(window.supervisorCourses);
        
    } catch (error) {
        console.error("Error loading profile:", error);
    }
}

async function fetchRealStats(coursesArray) {
    try {
        // 1. Get all batches assigned to THIS supervisor
        const qBatches = query(
            collection(db, "batches"), 
            where("supervisorId", "==", currentSupervisorUid)
        );
        const batchSnap = await getDocs(qBatches);
        
        // 2. Count total students across all batches
        let totalStudents = 0;
        const studentUids = new Set(); // Using a Set prevents double-counting if a student is in two batches

        batchSnap.forEach(doc => {
            const data = doc.data();
            if (data.studentUids && Array.isArray(data.studentUids)) {
                data.studentUids.forEach(uid => studentUids.add(uid));
            }
        });
        
        totalStudents = studentUids.size;

        const studentCountEl = document.getElementById('display-student-count');
        if (studentCountEl) studentCountEl.innerText = totalStudents;
    
    } catch (e) {
        console.error("Stats Error:", e);
    }
}

async function loadBatchList() {
    const container = document.getElementById('batch-groups-wrapper');
    if (!container) return;
    
    const uidToUse = currentSupervisorUid || auth.currentUser?.uid;

    if (!uidToUse) {
        container.innerHTML = "<p style='text-align:center; color:#888;'>Authenticating...</p>";
        return;
    }

    try {
        container.innerHTML = "<p style='text-align:center; color:#888;'>Loading your batches...</p>";

        // 1. Fetch the BATCHES created by this supervisor
        const qBatches = query(
            collection(db, "batches"), 
            where("supervisorId", "==", uidToUse)
        );
        
        const batchSnapshot = await getDocs(qBatches);
        
        if (batchSnapshot.empty) {
            container.innerHTML = `
                <div style="text-align:center; padding: 40px; border: 2px dashed #333; border-radius: 10px;">
                    <p style="font-size: 1.1rem; color: #888; margin: 0;">No batches found.</p>
                    <p style="font-size: 0.8rem; color: #555;">Create a batch in the Batch Management section to see them here.</p>
                </div>`;
            return;
        }

        container.innerHTML = ""; // Clear loader

        // 2. Iterate through each Batch
        for (const batchDoc of batchSnapshot.docs) {
            const batchData = batchDoc.data();
            const studentUids = batchData.studentUids || [];

            const batchSection = document.createElement('div');
            batchSection.className = 'batch-group-section';
            batchSection.style.marginBottom = "30px";
            
            const gridId = `grid-${batchDoc.id}`;

            batchSection.innerHTML = `
                <div class="batch-group-header" style="display:flex; justify-content:space-between; align-items:center; padding: 8px 0; border-bottom: 1px solid #444; margin-bottom:15px;">
                    <span style="font-weight:bold; color:#ffd400; font-size:1rem;">📂 ${batchData.name} (${batchData.year})</span>
                    <span style="background:#333; color:#aaa; padding:2px 10px; border-radius:12px; font-size:0.75rem;">${studentUids.length} Students</span>
                </div>
                <div id="${gridId}" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:12px;">
                    ${studentUids.length === 0 ? '<p style="color:#555; font-size:0.8rem; grid-column: 1/-1;">No students assigned to this batch yet.</p>' : ''}
                </div>
            `;
            container.appendChild(batchSection);

            const grid = document.getElementById(gridId);

            // 3. Fetch each student's details for this batch
            for (const studentUid of studentUids) {
                const studentSnap = await getDoc(doc(db, "users", studentUid));
                if (studentSnap.exists()) {
                    const student = studentSnap.data();
                    const fullName = student.name || `${student.firstName || ''} ${student.surname || ''}`.trim() || "Anonymous";
                    const initials = fullName.charAt(0).toUpperCase();

                    const card = document.createElement('div');
                    card.innerHTML = `
                        <div class="student-mini-card" style="display:flex; align-items:center; gap:12px; background:#1a1a1a; padding:12px; border-radius:8px; border:1px solid #333; transition: 0.3s;">
                            <div style="width:35px; height:35px; background:#ffd400; color:#000; display:flex; align-items:center; justify-content:center; border-radius:50%; font-weight:bold; font-size:0.9rem;">
                                ${initials}
                            </div>
                            <div style="overflow: hidden;">
                                <h4 title="${fullName}" style="margin:0; font-size:0.85rem; color:#fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                    ${fullName}
                                </h4>
                                <p style="margin:0; font-size:0.7rem; color:#666;">${student.company || 'No ID'}</p>
                            </div>
                        </div>
                    `;
                    grid.appendChild(card);
                }
            }
        }
    } catch (err) {
        console.error("Batch Loading Error:", err);
        container.innerHTML = "<p style='color:#ff4d4d; text-align:center;'>Failed to load records.</p>";
    }
}