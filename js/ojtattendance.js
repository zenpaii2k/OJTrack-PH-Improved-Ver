import { protectPage } from "../authguard.js";
import { auth, db } from "../firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {  collection, addDoc, query, where, onSnapshot, serverTimestamp,  orderBy, doc, getDoc, deleteDoc, getDocs, limit
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

let loggedDates = new Map();
let currentCalMonth = new Date();

// --- AUTH & INITIALIZATION ---
protectPage('student').then((user) => {
    if (!user) return;

    setupHeaderUI(user);
    setupNotificationSystem(user.uid);
    listenToAttendanceLogs(user.uid);
    renderCalendar(currentCalMonth);
    
    document.getElementById('current-date-display').innerHTML = `<span class="icon">📅</span> ${new Date().toDateString()}`;
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

    const prevBtn = document.getElementById('prevMonth');
    const nextBtn = document.getElementById('nextMonth');

    if (prevBtn) {
        prevBtn.onclick = () => {
            currentCalMonth = new Date(currentCalMonth.getFullYear(), currentCalMonth.getMonth() - 1, 1);
            renderCalendar(currentCalMonth);
        };
    }

    if (nextBtn) {
        nextBtn.onclick = () => {
            currentCalMonth = new Date(currentCalMonth.getFullYear(), currentCalMonth.getMonth() + 1, 1);
            renderCalendar(currentCalMonth);
        };
    }
}

function calculateHours(timeInStr, timeOutStr) {
    const parseTime = (timeStr) => {
        const [time, modifier] = timeStr.split(' ');
        let [hours, minutes] = time.split(':').map(Number);
        
        if (modifier === 'PM' && hours < 12) hours += 12;
        if (modifier === 'AM' && hours === 12) hours = 0;
        
        const d = new Date();
        d.setHours(hours, minutes, 0, 0);
        return d;
    };

    const start = parseTime(timeInStr);
    const end = parseTime(timeOutStr);
    
    let diff = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    
    // If the difference is negative, assume it crossed midnight (e.g., 10PM to 2AM)
    if (diff < 0) diff += 24; 
    
    return diff;
}

function setTimeToNow(type) {
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;

    const hourEl = document.getElementById(`${type}-hour`);
    const minEl = document.getElementById(`${type}-minute`);
    const ampmEl = document.getElementById(`${type}-ampm`);

    if (hourEl) hourEl.value = String(hours);
    if (minEl) minEl.value = String(minutes).padStart(2, '0');
    if (ampmEl) ampmEl.value = ampm;
}

async function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

function openBase64File(base64Data) {
    const win = window.open();
    if (!win) return alert("Please allow popups.");
    win.document.write(`<html><body style="margin:0;"><iframe src="${base64Data}" frameborder="0" style="border:0; width:100%; height:100%;"></iframe></body></html>`);
}

document.getElementById('attendance-file').addEventListener('change', function(e) {
    const fileName = e.target.files[0] ? e.target.files[0].name : "Choose File";
    const fileNameText = document.getElementById('file-name-text');
    if (fileNameText) fileNameText.innerText = fileName;
});

async function deleteLog(logId) {
    if (confirm("Are you sure you want to delete this log? This action cannot be undone.")) {
        try {
            await deleteDoc(doc(db, "attendance", logId));
            alert("Log deleted successfully.");
        } catch (err) {
            alert("Error deleting log: " + err.message);
        }
    }
}

// --- 2. UI & DATA RENDER ---

function renderCalendar(date) {
    const calGrid = document.getElementById('mini-calendar');
    const monthDisplay = document.getElementById('monthDisplay');
    if (!calGrid || !monthDisplay) return;

    calGrid.innerHTML = '';
    const year = date.getFullYear();
    const month = date.getMonth();
    const today = new Date();

    monthDisplay.innerText = date.toLocaleString('default', { month: 'long', year: 'numeric' });

    ['S','M','T','W','T','F','S'].forEach(d => {
        const el = document.createElement('b');
        el.innerText = d;
        calGrid.appendChild(el);
    });

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) calGrid.appendChild(document.createElement('div'));

    for (let i = 1; i <= daysInMonth; i++) {
        const dayEl = document.createElement('div');
        dayEl.innerText = i;
        dayEl.className = "calendar-day"; // Ensure CSS handles padding/cursor

        const currentIterDate = new Date(year, month, i);
        const fullDateStr = currentIterDate.toDateString(); 
        
        const status = loggedDates.get(fullDateStr);
        const isToday = i === today.getDate() && month === today.getMonth() && year === today.getFullYear();

        if (isToday) dayEl.style.border = "2px solid #ffd400";

        if (status === "Approved") {
            dayEl.style.background = "#2ecc71";
            dayEl.style.color = "#fff";
        } else if (status === "Rejected") {
            dayEl.style.background = "#e74c3c";
            dayEl.style.color = "#fff";
        } else if (status === "Pending") {
            dayEl.style.background = "#f1c40f";
            dayEl.style.color = "#000";
        }
        calGrid.appendChild(dayEl);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const nowInBtn = document.getElementById("now-in-btn");
    const nowOutBtn = document.getElementById("now-out-btn");
    if (nowInBtn) nowInBtn.addEventListener("click", () => setTimeToNow("in"));
    if (nowOutBtn) nowOutBtn.addEventListener("click", () => setTimeToNow("out"));
});

async function listenToAttendanceLogs(uid) {
    const logListContainer = document.getElementById('log-list');
    const summaryContainer = document.querySelector('.summary-card');

    const studentDoc = await getDoc(doc(db, "users", uid)); // Note: Fixed collection name to "users" as per your summary
    const requiredHours = studentDoc.exists() ? (studentDoc.data().requiredHours || 600) : 600;

    const q = query(
        collection(db, "attendance"), 
        where("uid", "==", uid), 
        orderBy("timestamp", "asc") 
    );

    onSnapshot(q, (snapshot) => {
        loggedDates.clear(); 
        let totalApprovedHours = 0;
        
        let tableRows = `
        <table style="width:100%; border-collapse:collapse; margin-top:10px; font-size:0.9rem;">
            <thead>
                <tr style="text-align:left; border-bottom: 2px solid #444; color:#ffd400;">
                    <th style="padding:10px;">Date</th>
                    <th style="padding:10px;">In/Out</th>
                    <th style="padding:10px;">Status</th>
                    <th style="padding:10px;">Note</th>
                    <th style="padding:10px;">File</th>
                    <th style="padding:10px;">Action</th>
                </tr>
            </thead>
            <tbody>`;

        snapshot.forEach((doc) => {
            const data = doc.data();
            const id = doc.id;
            const status = data.status || "Pending";
            const hours = calculateHours(data.timeIn, data.timeOut);

            // CRITICAL: Only add to total if status is exactly "Approved"
            if (status === "Approved") {
                totalApprovedHours += hours;
            }

            if (data.displayDate) {
                const normalizedDate = new Date(data.displayDate).toDateString();
                // Map the date to its current status
                loggedDates.set(normalizedDate, status);
            }

            const statusColor = status === "Approved" ? "#2ecc71" : status === "Rejected" ? "#e74c3c" : "#f1c40f";

            tableRows += `
            <tr style="border-bottom: 1px solid #333;">
                <td style="padding:10px;">${data.displayDate}</td>
                <td style="padding:10px;">${data.timeIn} - ${data.timeOut}</td>
                <td style="padding:10px; color:${statusColor}; font-weight:bold;">${status}</td>
                <td style="padding:10px; color:#bbb;">${data.note || "-"}</td>
                <td style="padding:10px;">${data.attachment ? `<button onclick="openBase64File('${data.attachment}')" style="color:#ffd400; background:none; border:none; cursor:pointer;">View</button>` : "None"}</td>
                <td style="padding:10px;">
                    ${status === "Pending" ? `<button onclick="deleteLog('${id}')" style="color:#ff4d4d; background:none; border:none; cursor:pointer;">Delete</button>` : `<span style="color:#555;">Locked</span>`}
                </td>
            </tr>`;
        });

        tableRows += `</tbody></table>`;

        // Update Progress Bar (Approved Only)
        const percentage = Math.min((totalApprovedHours / requiredHours) * 100, 100).toFixed(1);
        if (summaryContainer) {
            summaryContainer.innerHTML = `
            <div style="text-align:center; padding:10px;">
                <h3 style="margin:0; font-size:0.9rem;">Approved Progress</h3>
                <div style="font-size:2rem; font-weight:bold; color:#ffd400; margin:10px 0;">
                    ${totalApprovedHours.toFixed(1)} / ${requiredHours} hrs
                </div>
                <div style="width:100%; background:#222; height:12px; border-radius:10px; overflow:hidden; border:1px solid #444;">
                    <div style="width:${percentage}%; background:#2ecc71; height:100%;"></div>
                </div>
                <p style="margin-top:5px; font-size:0.75rem;">${percentage}% (Verified Hours)</p>
            </div>`;
        }

        logListContainer.innerHTML = snapshot.empty ? "<p style='color:gray; padding:20px;'>No logs found.</p>" : tableRows;
        renderCalendar(currentCalMonth);
    });
}

// --- 3. FORM SUBMISSION ---
document.getElementById('attendance-form').onsubmit = async (e) => {
    e.preventDefault();
    const user = auth.currentUser;
    const btn = document.getElementById('submit-log-btn');

    // Get time values
    const inH = document.getElementById('in-hour').value;
    const inM = document.getElementById('in-minute').value;
    const inA = document.getElementById('in-ampm').value;
    const outH = document.getElementById('out-hour').value;
    const outM = document.getElementById('out-minute').value;
    const outA = document.getElementById('out-ampm').value;

    if (!inH || !outH) return alert("Please set both Time In and Time Out.");

    const timeIn = `${inH}:${inM} ${inA}`;
    const timeOut = `${outH}:${outM} ${outA}`;
    
    // Calculate hours for THIS specific log
    const newLogHours = calculateHours(timeIn, timeOut);

    // 1. HARD CAP: A single log cannot exceed 24 hours (System Protection)
    if (newLogHours <= 0 || newLogHours > 24) {
        return alert("Invalid duration. A single log cannot exceed 24 hours.");
    }

    // Check existing logs for today to calculate total daily hours
    const todayStr = new Date().toDateString();
    const qToday = query(collection(db, "attendance"), where("uid", "==", user.uid), where("displayDate", "==", todayStr));
    const todaySnapshot = await getDocs(qToday);
    
    let totalHoursToday = 0;
    todaySnapshot.forEach(doc => {
        totalHoursToday += calculateHours(doc.data().timeIn, doc.data().timeOut);
    });

    const projectedTotal = totalHoursToday + newLogHours;

    // 2. HARD BLOCK: Daily total cannot exceed 24 hours
    if (projectedTotal > 24) {
        return alert(`System Block: You have already logged ${totalHoursToday.toFixed(1)} hours today. Adding this log would exceed the 24-hour daily limit.`);
    }

    // 3. PROFESSIONAL WARNING: Exceeding 12 hours (Recommended Limit)
    if (projectedTotal > 12) {
        const proceed = confirm(`Notice: You are about to log ${projectedTotal.toFixed(1)} hours for today. Most internships recommend a maximum of 12 hours. Do you want to proceed?`);
        if (!proceed) return;
    }

    // --- Proceed with submission ---
    btn.disabled = true;
    btn.innerText = "Processing...";

    let fileBase64 = null;
    const fileInput = document.getElementById('attendance-file');
    if (fileInput.files.length > 0) fileBase64 = await fileToBase64(fileInput.files[0]);

   try {
        await addDoc(collection(db, "attendance"), {
            uid: user.uid,
            displayDate: todayStr,
            timeIn: timeIn,
            timeOut: timeOut,
            note: document.getElementById('attendance-note').value.trim(),
            attachment: fileBase64,
            status: "Pending",
            timestamp: serverTimestamp()
        });
        
        alert("Attendance log submitted successfully!");
        document.getElementById('attendance-form').reset();
        document.getElementById('file-name-text').innerText = "Choose File";
    } catch (err) {
        alert("Submission Error: " + err.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "Submit Log";
    }
};

window.openBase64File = openBase64File;
window.deleteLog = deleteLog;
window.setTimeToNow = setTimeToNow;