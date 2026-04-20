/**
 * OJTrack PH — feedback.js
 * ─────────────────────────────────────────────────────────────
 * FIXES:
 *  1. orderBy('timestamp') — matches what checkstudentdatabase.js WRITES
 *     (adviser writes { timestamp: serverTimestamp() }, not createdAt)
 *  2. fb.senderName (not fb.adviserName) — matches the write field
 *  3. Theme toggle wired for both buttons
 *  4. relativeTime(fb.timestamp) not fb.createdAt
 * ─────────────────────────────────────────────────────────────
 */

import { auth, db } from '../firebase-config.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, query, orderBy, onSnapshot, doc, getDoc
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { protectPage } from '../authguard.js';
import {
    initTheme, setupThemeToggle, setupProfileDropdown,
    setupNotifDropdown, populateHeaderUser, sanitizeText, relativeTime, formatTimestamp
} from '../js/theme.js';
import { setupNotificationSystem } from '../js/notifications.js';

initTheme();

let allFeedback  = [];
let activeFilter = 'all';

protectPage('student').then((user) => {
    // ✅ Wire both theme toggle buttons
    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);
    setupLogout();

    loadUserProfile(user);
    listenToFeedback(user.uid);
    setupFilterButtons();
});

function setupLogout() {
    ['logout-link', 'sidebar-logout-btn'].forEach(id => {
        document.getElementById(id)?.addEventListener('click', () =>
            signOut(auth).then(() => window.location.replace('/index.html'))
        );
    });
}

async function loadUserProfile(user) {
    try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        if (!snap.exists()) return;
        const data = snap.data();
        const name = data.name
            || `${data.firstName || ''} ${data.surname || ''}`.trim()
            || 'Student';
        populateHeaderUser(name, user.email);

        const adviserEl = document.getElementById('fb-adviser-name');
        if (adviserEl) adviserEl.textContent = data.adviserName || 'Not assigned';
    } catch (e) {
        console.error('[Feedback] loadUserProfile:', e);
    }
}

// ─── REALTIME LISTENER ───────────────────────────────────────
function listenToFeedback(uid) {
    // ✅ FIX: orderBy 'timestamp' — this is what checkstudentdatabase.js writes
    const q = query(
        collection(db, 'students', uid, 'feedback'),
        orderBy('timestamp', 'desc')
    );

    onSnapshot(q, (snap) => {
        allFeedback = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        updateSummary();
        renderFeedback();
    }, (err) => {
        console.error('[Feedback] listener error:', err);
        // Show empty state on error too
        const listEl = document.getElementById('feedback-list');
        if (listEl) listEl.innerHTML = buildEmptyState('Could not load feedback. Check your connection.');
    });
}

function updateSummary() {
    const total  = allFeedback.length;
    const unread = allFeedback.filter(f => !f.isRead).length;
    setText('fb-total-count',  String(total));
    setText('fb-unread-count', String(unread));
}

function renderFeedback() {
    const listEl = document.getElementById('feedback-list');
    if (!listEl) return;

    const toShow = activeFilter === 'unread'
        ? allFeedback.filter(f => !f.isRead)
        : allFeedback;

    if (toShow.length === 0) {
        listEl.innerHTML = buildEmptyState();
        return;
    }

    listEl.innerHTML = toShow.map(buildFeedbackCard).join('');
}

function buildFeedbackCard(fb) {
    // ✅ FIX: adviser writes 'senderName' not 'adviserName'
    const author   = sanitizeText(fb.senderName || fb.adviserName || 'Adviser');
    const message  = sanitizeText(fb.message || '');
    // ✅ FIX: use 'timestamp' not 'createdAt'
    const time     = relativeTime(fb.timestamp) || formatTimestamp(fb.timestamp);
    const initial  = author.charAt(0).toUpperCase();
    const unread   = !fb.isRead ? 'unread' : '';
    const subject  = sanitizeText(fb.subject || '');

    // Star rating
    let stars = '';
    if (fb.rating && typeof fb.rating === 'number') {
        for (let i = 1; i <= 5; i++) {
            stars += `<span class="fb-star${i > fb.rating ? ' empty' : ''}">★</span>`;
        }
        stars = `<div class="fb-rating">${stars}</div>`;
    }

    const categoryBadge = subject
        ? `<span class="fb-category">${subject}</span>`
        : '';

    return `
      <div class="fb-card ${unread}">
        <div class="fb-avatar">${initial}</div>
        <div class="fb-body">
          <div class="fb-meta">
            <span class="fb-author">${author}</span>
            <span class="fb-time">${time}</span>
          </div>
          <p class="fb-message">${message}</p>
          ${stars}
          ${categoryBadge}
        </div>
      </div>`;
}

function buildEmptyState(msg) {
    const text = msg || (activeFilter === 'unread'
        ? 'All caught up! No unread messages.'
        : 'No feedback from your adviser yet.');

    return `
      <div class="fb-empty-state">
        <span class="fb-empty-emoji">💬</span>
        <p class="fb-empty-title">${text}</p>
        <p class="fb-empty-sub">Feedback will appear here when your adviser sends a message.</p>
      </div>`;
}

function setupFilterButtons() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.filter;
            renderFeedback();
        });
    });
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}
