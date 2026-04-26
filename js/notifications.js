/**
 * OJTrack PH — notifications.js
 * ─────────────────────────────────────────────────────────────
 * Firebase-backed, real-time notification system.
 *
 * Firestore Schema:
 *   notifications/{notificationId} {
 *     recipientUid:   string   – UID of the recipient
 *     title:          string   – Short notification title
 *     body:           string   – Full notification message
 *     type:           string   – 'alert' | 'message' | 'system' | 'approval'
 *     category:       string   – 'attendance' | 'report' | 'batch' | 'general'
 *     isRead:         boolean
 *     createdAt:      Timestamp
 *     senderName:     string   – Display name of sender (optional)
 *     relatedDocId:   string   – Related document ID (optional)
 *     relatedUrl:     string   – Deep link URL (optional)
 *   }
 *
 * Usage:
 *   import { setupNotificationSystem, sendNotification } from '/js/notifications.js';
 *
 *   // In each page's init (after auth resolves):
 *   setupNotificationSystem(userId);
 *
 *   // To send a notification from adviser to student:
 *   await sendNotification({
 *     recipientUid: studentUid,
 *     title: 'Log Approved',
 *     body: 'Your attendance log for May 12 has been approved.',
 *     type: 'approval',
 *     category: 'attendance',
 *     senderName: 'Mr. Santos',
 *   });
 * ─────────────────────────────────────────────────────────────
 */

import { db } from '../firebase-config.js';
import {
    collection,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
    addDoc,
    updateDoc,
    doc,
    writeBatch,
    serverTimestamp,
    getDocs,
    getDoc,
    deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

import { relativeTime, sanitizeText } from './theme.js';

const COLLECTION = 'notifications';
const MAX_DISPLAY = 30;

// Category → emoji map
const TYPE_ICONS = {
    alert:    '🚨',
    message:  '💬',
    system:   '⚙️',
    approval: '✅',
    reminder: '⏰',
    default:  '🔔',
};

let _unsubscribe = null;

// ─── SETUP ──────────────────────────────────────────────────

/**
 * Starts a real-time listener on the notification collection for this user.
 * Renders unread count badge and populates the dropdown.
 *
 * @param {string} userId – Authenticated user's UID
 */
export function setupNotificationSystem(userId) {
    if (!userId) return;

    const q = query(
        collection(db, COLLECTION),
        where('recipientUid', '==', userId),
        orderBy('createdAt', 'desc'),
        limit(MAX_DISPLAY),
    );

    // Detach previous listener if re-called
    if (_unsubscribe) _unsubscribe();

    _unsubscribe = onSnapshot(q, (snapshot) => {
        const notifications = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderNotifications(notifications, userId);
    }, (err) => {
        console.error('[Notifications] Listener error:', err);
    });

    const markAllBtn = document.getElementById('mark-all-read');
    const clearBtn   = document.getElementById('clear-all-notifs');

    if (markAllBtn) {
        markAllBtn.addEventListener('click', () => markAllRead(userId));
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            const ok = confirm("Delete all notifications? This cannot be undone.");
            if (!ok) return;

            await clearAllNotifications(userId);
        });
    } 
}

export async function clearAllNotifications(userId) {
    if (!userId) return;

    try {
        const q = query(
            collection(db, COLLECTION),
            where('recipientUid', '==', userId),
        );

        const snap = await getDocs(q);

        const batch = writeBatch(db);

        snap.docs.forEach(d => {
            batch.delete(d.ref);
        });

        await batch.commit();
    } catch (e) {
        console.error('[Notifications] clearAllNotifications error:', e);
    }
}

/**
 * Stops the active notification listener.
 */
export function teardownNotificationSystem() {
    if (_unsubscribe) {
        _unsubscribe();
        _unsubscribe = null;
    }
}

// ─── RENDER ─────────────────────────────────────────────────

function renderNotifications(notifications, userId) {
    const listEl    = document.getElementById('notif-list');
    const badgeEl   = document.getElementById('notif-badge');
    const oldBadge  = document.getElementById('notif-count'); // legacy selector

    if (!listEl) return;

    const unread = notifications.filter(n => !n.isRead);
    const count  = unread.length;

    // Update badge
    [badgeEl, oldBadge].forEach(el => {
        if (!el) return;
        el.textContent = count > 9 ? '9+' : String(count);
        el.style.display = count > 0 ? 'flex' : 'none';
    });

    // Render list
    if (notifications.length === 0) {
        listEl.innerHTML = '<div class="notif-empty">🔔 No notifications yet.</div>';
        return;
    }

    listEl.innerHTML = notifications.map(n => buildNotifItem(n)).join('');

    // Attach click listeners to mark as read
    listEl.querySelectorAll('.notif-item').forEach(item => {
        item.addEventListener('click', () => {
            const notifId = item.dataset.id;
            const url     = item.dataset.url;
            markOneRead(notifId);
            if (url) window.location.href = url;
        });
    });
}

function buildNotifItem(notif) {
    const icon    = TYPE_ICONS[notif.type] || TYPE_ICONS.default;
    const title   = sanitizeText(notif.title || 'Notification');
    const body    = sanitizeText(notif.body  || '');
    const time    = relativeTime(notif.createdAt);
    const unread  = !notif.isRead ? 'unread' : '';
    const url     = notif.relatedUrl || '';

    return `
      <div class="notif-item ${unread}" data-id="${sanitizeText(notif.id)}" data-url="${sanitizeText(url)}">
        <div class="notif-icon">${icon}</div>
        <div class="notif-content">
          <div class="notif-title">${title}</div>
          <div class="notif-body">${body}</div>
          <div class="notif-time">${time}</div>
        </div>
      </div>
    `;
}

// ─── READ STATE ─────────────────────────────────────────────

/**
 * Marks a single notification as read.
 * @param {string} notifId
 */
export async function markOneRead(notifId) {
    if (!notifId) return;
    try {
        await updateDoc(doc(db, COLLECTION, notifId), { isRead: true });
    } catch (e) {
        console.error('[Notifications] markOneRead error:', e);
    }
}

/**
 * Marks ALL of a user's unread notifications as read.
 * Uses a batched write for efficiency.
 * @param {string} userId
 */
export async function markAllRead(userId) {
    if (!userId) return;
    try {
        const q = query(
            collection(db, COLLECTION),
            where('recipientUid', '==', userId),
            where('isRead', '==', false),
        );
        const snap  = await getDocs(q);
        const batch = writeBatch(db);
        snap.docs.forEach(d => batch.update(d.ref, { isRead: true }));
        await batch.commit();
    } catch (e) {
        console.error('[Notifications] markAllRead error:', e);
    }
}

// ─── SEND ────────────────────────────────────────────────────

/**
 * Creates a new notification document in Firestore.
 *
 * @param {Object} params
 * @param {string} params.recipientUid
 * @param {string} params.title
 * @param {string} params.body
 * @param {'alert'|'message'|'system'|'approval'|'reminder'} [params.type='system']
 * @param {string} [params.category='general']
 * @param {string} [params.senderName='OJTrack PH']
 * @param {string} [params.relatedDocId]
 * @param {string} [params.relatedUrl]
 * @returns {Promise<string>} The new notification document ID
 */

async function isUserValid(recipientUid) {
    try {
        const userRef = doc(db, "users", recipientUid);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) return false;

        const userData = userSnap.data();

        if (userData.role === 'adviser' || userData.role === 'supervisor' || userData.role === 'teacher') {
            return true;
        }

        const batchId = userData?.batchId || userData?.batch || null;
        return !!batchId;

    } catch (err) {
        console.error("[Notifications] validation error:", err);
        return false;
    }
}
export async function sendNotification({
    recipientUid,
    title,
    body,
    type     = 'system',
    category = 'general',
    senderName  = 'OJTrack PH',
    relatedDocId = null,
    relatedUrl   = null,
}) {
    if (!recipientUid || !title) {
        throw new Error('[Notifications] recipientUid and title are required.');
    }

    let shouldValidateStudent = false;

    try {
        const userSnap = await getDoc(doc(db, "users", recipientUid));
        if (userSnap.exists()) {
            const userData = userSnap.data();
            shouldValidateStudent = userData?.role === 'student';
        }
    } catch {}

    if (shouldValidateStudent) {
        const isValid = await isStudentStillValid(recipientUid);

        if (!isValid) {
            console.warn("[Notifications] Skipped (student not in batch):", recipientUid);
            return null;
        }
    }

    const payload = {
        recipientUid,
        title: String(title).slice(0, 120),
        body: String(body || '').slice(0, 500),
        type,
        category,
        senderName: String(senderName).slice(0, 80),
        isRead: false,
        createdAt: serverTimestamp(),
        ...(relatedDocId && { relatedDocId }),
        ...(relatedUrl && { relatedUrl }),
    };

    const ref = await addDoc(collection(db, COLLECTION), payload);
    return ref.id;
}

// ─── CONVENIENCE SENDERS ─────────────────────────────────────

/**
 * Sends a log approval notification to a student.
 */
export function notifyLogApproved(studentUid, date, adviserName) {
    return sendNotification({
        recipientUid: studentUid,
        title: 'Attendance Log Approved ✅',
        body:  `Your log for ${date} was approved by ${adviserName}.`,
        type:  'approval',
        category: 'attendance',
        senderName: adviserName,
        relatedUrl: '/student/ojtattendance.html',
    });
}

/**
 * Sends a log rejection notification to a student.
 */
export function notifyLogRejected(studentUid, date, adviserName, reason = '') {
    return sendNotification({
        recipientUid: studentUid,
        title: 'Attendance Log Needs Review ⚠️',
        body:  `Your log for ${date} requires attention.${reason ? ' Reason: ' + reason : ''}`,
        type:  'alert',
        category: 'attendance',
        senderName: adviserName,
        relatedUrl: '/student/ojtattendance.html',
    });
}

/**
 * Sends an adviser feedback notification to a student.
 */
export function notifyAdviserFeedback(studentUid, adviserName) {
    return sendNotification({
        recipientUid: studentUid,
        title: 'New Feedback from Adviser 💬',
        body:  `${adviserName} left new feedback on your profile.`,
        type:  'message',
        category: 'general',
        senderName: adviserName,
        relatedUrl: '/student/feedback.html',
    });
}

/**
 * Sends a system-wide broadcast to a user.
 */
export function notifySystem(recipientUid, title, body) {
    return sendNotification({
        recipientUid,
        title,
        body,
        type: 'system',
        category: 'general',
    });
}

/**
 * Student submitted attendance log → notify adviser
 */
export function notifyLogSubmittedToAdviser(adviserUid, studentName, date, batchId) {
    return sendNotification({
        recipientUid: adviserUid,
        title: 'New Attendance Log Submitted 📄',
        body: `${studentName} submitted a log for ${date}.`,
        type: 'system',
        category: 'attendance',
        senderName: studentName,
        relatedUrl: '/supervisor/checkstudentdatabase.html',
        relatedDocId: batchId || null 
    });
}

/**
 * Student submitted document → notify adviser
 */
export function notifyDocumentSubmittedToAdviser(adviserUid, studentName, docName) {
    return sendNotification({
        recipientUid: adviserUid,
        title: 'New Document Submitted 📎',
        body: `${studentName} submitted "${docName}".`,
        type: 'message',
        category: 'documents',
        senderName: studentName,
        relatedUrl: '/supervisor/checkstudentreq.html',
    });
}

/**
 * Student submitted full report → notify adviser
 */
export function notifyReportSubmitted(adviserUid, studentName) {
    return sendNotification({
        recipientUid: adviserUid,
        title: 'OJT Report Submitted 📘',
        body: `${studentName} submitted their OJT report for review.`,
        type: 'alert',
        category: 'reports',
        senderName: studentName,
        relatedUrl: '/supervisor/checkstudentreports.html',
    });
}

export function notifyReportApproved(studentUid, adviserName) {
    return sendNotification({
        recipientUid: studentUid,
        title: 'OJT Report Approved 🎉',
        body: `${adviserName} approved your OJT report.`,
        type: 'approval',
        category: 'reports',
        senderName: adviserName,
        relatedUrl: '/student/generatepdf.html',
    });
}

export function notifyReportRejected(studentUid, adviserName, reason = '') {
    return sendNotification({
        recipientUid: studentUid,
        title: 'OJT Report Rejected ❌',
        body: `Your report needs revision.${reason ? ' Reason: ' + reason : ''}`,
        type: 'alert',
        category: 'reports',
        senderName: adviserName,
        relatedUrl: '/student/generatepdf.html',
    });
}

export function notifyDocumentApproved(studentUid, docName, adviserName) {
    return sendNotification({
        recipientUid: studentUid,
        title: 'Document Approved ✅',
        body: `${docName} was approved by ${adviserName}.`,
        type: 'approval',
        category: 'documents',
        senderName: adviserName,
        relatedUrl: '/student/checklist.html',
    });
}

export function notifyDocumentRejected(studentUid, docName, adviserName, reason = '') {
    return sendNotification({
        recipientUid: studentUid,
        title: 'Document Rejected ⚠️',
        body: `${docName} needs revision.${reason ? ' Reason: ' + reason : ''}`,
        type: 'alert',
        category: 'documents',
        senderName: adviserName,
        relatedUrl: '/student/checklist.html',
    });
}
