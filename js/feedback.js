import { auth, db } from '../firebase-config.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    collection, query, orderBy, onSnapshot, doc, getDoc, updateDoc, deleteDoc
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
    setupThemeToggle('theme-toggle-btn');
    setupThemeToggle('sidebar-theme-btn');
    setupProfileDropdown();
    setupNotifDropdown();
    setupNotificationSystem(user.uid);
    setupLogout();

    loadUserProfile(user);
    listenToFeedback(user.uid);
    setupFeedbackClick(user.uid);
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
    const author  = sanitizeText(fb.senderName || fb.adviserName || 'Adviser');
    const message = sanitizeText(fb.message || '');
    const time    = relativeTime(fb.timestamp) || formatTimestamp(fb.timestamp);
    const initial = author.charAt(0).toUpperCase();
    const unread  = !fb.isRead ? 'unread' : '';
    const subject = sanitizeText(fb.subject || '');

    return `
      <div class="fb-card ${unread}" data-id="${fb.id}">
        <div class="fb-avatar">${initial}</div>
        <div class="fb-body">
          <div class="fb-meta">
            <span class="fb-author">${author}</span>
            <span class="fb-time">${time}</span>
          </div>
          <p class="fb-message">${message.slice(0, 80)}...</p>
          ${subject ? `<span class="fb-category">${subject}</span>` : ''}
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

function openFeedbackModal(fb) {
    document.getElementById('fb-modal-author').textContent =
        fb.senderName || 'Adviser';

    document.getElementById('fb-modal-subject').textContent =
        fb.subject || '';

    document.getElementById('fb-modal-message').textContent =
        fb.message || '';

    document.getElementById('fb-modal-time').textContent =
        relativeTime(fb.timestamp);

    const modal = document.getElementById('fb-modal');
    modal.classList.add('show');

    document.getElementById('fb-close').onclick = closeFeedbackModal;

    modal.onclick = (e) => {
        if (e.target.id === 'fb-modal') closeFeedbackModal();
    };

    const deleteBtn = document.getElementById('fb-delete');

    deleteBtn.onclick = async () => {
        const confirmDelete = confirm("Delete this feedback permanently?");
        if (!confirmDelete) return;

        try {
            await deleteDoc(doc(db, 'students', auth.currentUser.uid, 'feedback', fb.id));

            closeFeedbackModal();
        } catch (err) {
            console.error('[Feedback] delete error:', err);
            alert('Failed to delete feedback.');
        }
    };
}

function closeFeedbackModal() {
    const modal = document.getElementById('fb-modal');
    modal.classList.remove('show');
}

function setupFeedbackClick(uid) {
    const listEl = document.getElementById('feedback-list');

    listEl.addEventListener('click', async (e) => {
    const card = e.target.closest('.fb-card');
    if (!card) return;

    const id = card.dataset.id;
    const fb = allFeedback.find(f => f.id === id);
    if (!fb) return;

    openFeedbackModal(fb);

    if (!fb.isRead) {
        await updateDoc(doc(db, 'students', uid, 'feedback', id), {
            isRead: true
        });

        fb.isRead = true;
        updateSummary();
        renderFeedback();
    }
});
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
