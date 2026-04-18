import { auth, db } from "../firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc, updateDoc, collection, query, where, onSnapshot, getDocs, limit, arrayUnion} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { protectPage } from "../authguard.js";
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

    initializeApp(user);
    setupInteractions();
    setupNavigation();
    setupHeaderUI(user);
    setupNotificationSystem(user.uid);
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

// --- 2. DATA CALCULATIONS ---

 function calculateDecimalHours(timeIn, timeOut) {
    if (!timeIn || !timeOut) return 0;

    const parseTime = (timeStr) => {
        const [time, modifier] = timeStr.split(' ');
        let [hours, minutes] = time.split(':').map(Number);

        if (modifier === 'PM' && hours < 12) hours += 12;
        if (modifier === 'AM' && hours === 12) hours = 0;

        return hours + (minutes / 60);
    };

    const start = parseTime(timeIn);
    const end = parseTime(timeOut);

    let diff = end - start;

    // Handle overnight shifts
    if (diff < 0) diff += 24;

    return diff;
    }


async function initializeApp(user) {
    const userRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userRef);

    if (userSnap.exists()) {
        const data = userSnap.data();
        const userName = data.name || "Student User";
        
        // Update Header and Pop-up Modal
        document.getElementById('user-display-name').innerText = userName;
        document.getElementById('user-display-name-pop').innerText = userName;
        document.getElementById('user-full-email').innerText = user.email;

        // Update Profile Card
        document.getElementById('student-name').innerText = userName;
        document.getElementById('display-school').innerText = data.school || "---";
        // Fixed: checking if course and section exist to prevent "undefined-undefined"
        const sectionDisplay = (data.course && data.section) ? `${data.course}-${data.section}` : (data.fullSection || "---");
        document.getElementById('display-section').innerText = sectionDisplay;
        document.getElementById('display-company').innerText = data.company || "---";

        //Full Profile
        document.getElementById('edit-full-name').value = data.name || "";
        document.getElementById('edit-designation').value = data.designation || "Student";
        document.getElementById('edit-email').value = user.email;
        document.getElementById('edit-hours').value = `${data.timeStart} - ${data.timeEnd}` || "";
        
        const reqHrs = parseFloat(data.requiredHours) || 450; 
        document.getElementById('display-req-hours').innerText = `${reqHrs} hrs`;

        // Real-time Progress Listener
        const qLogs = query(
    collection(db, "attendance"), 
    where("uid", "==", user.uid),
    where("status", "==", "Approved") // CRITICAL: Only fetch approved logs
);

onSnapshot(qLogs, (snapshot) => {
    let totalApprovedHrs = 0;
    
    snapshot.forEach((logDoc) => {
        const log = logDoc.data();
        // Calculate only if the status is approved (double-check logic)
        totalApprovedHrs += calculateDecimalHours(log.timeIn, log.timeOut);
    });

    const percent = reqHrs > 0 ? Math.min((totalApprovedHrs / reqHrs) * 100, 100) : 0;
    
    // Update UI elements
    const progressFill = document.getElementById('profile-progress-fill');
    if (progressFill) progressFill.style.width = `${percent}%`;
    
    const progressText = document.getElementById('profile-progress-text');
    if (progressText) progressText.innerText = `${Math.round(percent)}%`;
    
    const compHoursDisp = document.getElementById('display-comp-hours');
    if (compHoursDisp) compHoursDisp.innerText = `${totalApprovedHrs.toFixed(1)} hrs`;
    
});

const qDocs = query(collection(db, "checklist"), where("uid", "==", user.uid), where("status", "==", "Approved"));

onSnapshot(qDocs, (snapshot) => {
    const totalRequired = 13; // Set your total document count here
    const approvedDocs = snapshot.size;
    const docPercent = Math.min((approvedDocs / totalRequired) * 100, 100);
    
    const docFill = document.getElementById('doc-progress-fill');
    const docText = document.getElementById('doc-progress-text');
    
    if (docFill) docFill.style.width = `${docPercent}%`;
    if (docText) docText.innerText = `${approvedDocs}/${totalRequired} Approved`;
});

        if (data.batch) syncBatchData(data.batch, user.uid);
    }

        const clockInToggle = document.getElementById('notif-clockin');
        const feedbackToggle = document.getElementById('notif-feedback');

        if (clockInToggle && feedbackToggle) {
            clockInToggle.checked = data.notifications?.dailyReminder ?? true;
            feedbackToggle.checked = data.notifications?.emailFeedback ?? false;

            // Save toggle changes to Firebase immediately
            const saveToggles = async () => {
                await updateDoc(userRef, {
                    "notifications.dailyReminder": clockInToggle.checked,
                    "notifications.emailFeedback": feedbackToggle.checked
                });
            };

            clockInToggle.onchange = saveToggles;
            feedbackToggle.onchange = saveToggles;
}

}

// --- 4. BATCH & SUPERVISOR LOGIC ---

async function syncBatchData(batchId, myUid) {
    const batchSnap = await getDoc(doc(db, "batches", batchId));
    if (!batchSnap.exists()) return;

    const bData = batchSnap.data();
    if (bData.supervisorId) {
        const supSnap = await getDoc(doc(db, "users", bData.supervisorId));
        if (supSnap.exists()) {
            const s = supSnap.data();

            // Update Supervisor UI
            document.getElementById('sup-name').innerText = s.name || "---";
            document.getElementById('sup-org').innerText = s.organization || "---";
            document.getElementById('sup-id').innerText = s.staffId || "---";
            document.getElementById('sup-class').innerText = s.assignedCourses?.join(', ') || "---";

            // Update Batch Tab Header
            document.getElementById('batch-sup-name').innerText = s.name || "---";
            document.getElementById('batch-sup-courses').innerText = s.assignedCourses?.[0] || "---";

            // Fetch Classmates
            const qMates = query(collection(db, "users"), where("batch", "==", batchId));
            const matesSnap = await getDocs(qMates);
            
            let gridHTML = "";
            matesSnap.forEach(docSnap => {
                const m = docSnap.data();
                if (m.role === 'student') {
                    const isMe = docSnap.id === myUid;
                    const initial = (m.name || 'S').charAt(0).toUpperCase();
                    const mSection = (m.course && m.section) ? `${m.course}-${m.section}` : "Student";
                    
                    gridHTML += `
                        <div class="member-card ${isMe ? 'is-me' : ''}">
                            <div class="member-avatar">${initial}</div>
                            <div class="member-details">
                                <p class="m-name">${m.name} ${isMe ? '(You)' : ''}</p>
                                <p class="m-dept">${mSection}</p>
                            </div>
                        </div>`;
                }
            });
            
            const gridContainer = document.getElementById('classmates-grid');
            if (gridContainer) gridContainer.innerHTML = gridHTML || "<p>No classmates found.</p>";
        }
    }
}

// --- 5. UI INTERACTION HELPERS ---

function setupNavigation() {
    document.querySelectorAll('.settings-list .nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.settings-list .nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            const targetId = item.getAttribute('data-section');
            document.querySelectorAll('.content-section').forEach(sec => {
                sec.style.display = (sec.id === targetId) ? 'block' : 'none';
            });
        });
    });
}

function setupInteractions() {
    const profileTrigger = document.getElementById('profile-trigger');
    const profileMenu = document.getElementById('profile-menu');
    const notifBtn = document.getElementById('notif-btn');
    const notifModal = document.getElementById('notif-modal');

    if (profileTrigger) {
        profileTrigger.onclick = (e) => {
            e.stopPropagation();
            profileMenu.classList.toggle('show');
        };
    }
    
    if (notifBtn) {
        notifBtn.onclick = (e) => {
            e.stopPropagation();
            notifModal.classList.toggle('show');
        };
    }

    window.onclick = () => {
        if (profileMenu) profileMenu.classList.remove('show');
        if (notifModal) notifModal.classList.remove('show');
    };

    const logoutBtn = document.getElementById('logout-link');
    if (logoutBtn) {
        logoutBtn.onclick = () => signOut(auth).then(() => location.replace("/index.html"));
    }
}