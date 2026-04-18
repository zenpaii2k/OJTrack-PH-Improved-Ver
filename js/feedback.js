import { auth, db } from "../firebase-config.js";
import { protectPage } from "../authguard.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { 
    collection, query, orderBy, onSnapshot, doc, deleteDoc, getDoc, where, limit 
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

// --- AUTH & INITIALIZATION ---
protectPage('student').then((user) => {
    if (!user) return;

    // Initialize UI Components
    setupHeaderUI(user);
    listenForFeedback(user.uid);
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

// --- 4. FEEDBACK CORE LOGIC ---

function listenForFeedback(uid) {
    const container = document.querySelector('.feedback-container');
    const q = query(collection(db, "students", uid, "feedback"), orderBy("timestamp", "desc"));
    
    onSnapshot(q, (snapshot) => {
        container.innerHTML = `<button class="btn-read-all">📩 Inbox</button>`;
        
        if (snapshot.empty) {
            container.innerHTML += `<p style="padding:20px; color:gray; text-align:center;">No feedback from your adviser yet.</p>`;
            return;
        }

        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            const docId = docSnap.id;
            const date = data.timestamp ? data.timestamp.toDate().toLocaleDateString() : "Recent";
            
            const card = document.createElement('div');
            card.className = "feedback-card unread";
            card.innerHTML = `
                <div class="card-header">
                    <div class="sender-info">
                        <span class="status-dot"></span>
                        <div class="sender-meta">
                            <strong>${data.senderName || "Name"}</strong>
                            <span class="sender-role">${data.senderRole || "OJT Adviser"}</span>
                        </div>
                        <span class="date">${date}</span>
                    </div>
                    <div class="card-actions">
                        <button class="btn-view" id="view-${docId}">View</button>
                        <button class="btn-delete" id="del-${docId}">🗑️</button>
                    </div>
                </div>
                <div class="card-body">
                    <h3>${data.subject || "General Remarks"}</h3>
                    <p>${(data.message || "").substring(0, 80)}...</p>
                </div>`;
            container.appendChild(card);

            document.getElementById(`view-${docId}`).onclick = () => 
                openDetailView(data.senderName, data.senderRole, date, data.subject, data.message);
            
            document.getElementById(`del-${docId}`).onclick = async (e) => {
                e.stopPropagation();
                if(confirm("Delete this feedback?")) await deleteDoc(doc(db, "students", uid, "feedback", docId));
            };
        });
    });
}

function openDetailView(sender, role, date, subject, message) {
    const layout = document.querySelector('.feedback-layout');
    layout.innerHTML = `
        <div class="feedback-badge">View Feedback</div>
        <section class="feedback-container detail-view">
            <div class="view-btns">
                <button class="btn-back" onclick="location.reload()">← Back to Inbox</button>
            </div>
            <div class="message-display-card">
                <div class="card-header">
                    <div>
                        <strong>${sender}</strong>
                        <div class="sender-role">${role}</div>
                    </div>
                    <span class="date">${date}</span>
                </div>
                <div class="card-body">
                    <h2 class="formal-subject">${subject}</h2>
                    <div class="message-text" style="white-space: pre-wrap;">${message}</div>
                </div>
            </div>
        </section>`;
}