/**
 * OJTrack PH — theme.js
 * ─────────────────────────────────────────────────────────────
 * Centralized theme management. Import this in every page JS.
 * 
 * Usage:
 *   import { initTheme, setupThemeToggle } from '/js/theme.js';
 *   initTheme();
 *   setupThemeToggle('theme-toggle-btn');  // pass your button ID
 * ─────────────────────────────────────────────────────────────
 */

const THEME_KEY = 'ojtrack-theme';

/**
 * Applies the given theme to the document.
 * @param {'dark'|'light'} theme
 */
export function applyTheme(theme) {
    const isDark = theme === 'dark';

    // Apply to both <html> and <body> for maximum compatibility
    document.documentElement.classList.toggle('dark-theme', isDark);
    document.documentElement.classList.toggle('light-theme', !isDark);
    document.body.classList.toggle('dark-theme', isDark);
    document.body.classList.toggle('light-theme', !isDark);

    localStorage.setItem(THEME_KEY, theme);
}

/**
 * Reads stored theme preference and applies it.
 * Call this as the very first thing on page load.
 */
export function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'dark';
    applyTheme(saved);
}

/**
 * Returns the current active theme string.
 * @returns {'dark'|'light'}
 */
export function getTheme() {
    return localStorage.getItem(THEME_KEY) || 'dark';
}

/**
 * Toggles between dark and light theme.
 */
export function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
}

/**
 * Attaches a click listener to the theme toggle button.
 * @param {string} buttonId - The ID of the toggle button element
 */
export function setupThemeToggle(buttonId = 'theme-toggle-btn') {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    btn.addEventListener('click', toggleTheme);
}

// ─── TOAST NOTIFICATION SYSTEM ──────────────────────────────
let toastContainer = null;

function getToastContainer() {
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }
    return toastContainer;
}

/**
 * Shows a temporary toast message.
 * @param {string} message
 * @param {'success'|'error'|'info'|'default'} type
 * @param {number} duration - ms before auto-dismiss (default 3500)
 */
export function showToast(message, type = 'default', duration = 3500) {
    const container = getToastContainer();

    const icons = {
        success: '✅',
        error:   '❌',
        info:    'ℹ️',
        default: '🔔',
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || icons.default}</span><span>${sanitizeText(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        toast.style.transition = '0.3s ease';
        setTimeout(() => toast.remove(), 310);
    }, duration);
}

// ─── SHARED HEADER UI ────────────────────────────────────────

/**
 * Sets up the profile dropdown toggle.
 */
export function setupProfileDropdown() {
    const trigger = document.getElementById('profile-trigger');
    const menu    = document.getElementById('profile-menu');
    if (!trigger || !menu) return;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('show');
        closeNotifDropdown(); // close notif when profile opens
    });

    document.addEventListener('click', () => {
        menu.classList.remove('show');
    });
}

/**
 * Sets up the notification bell dropdown.
 */
export function setupNotifDropdown() {
    const btn   = document.getElementById('notif-btn');
    const modal = document.getElementById('notif-modal');
    if (!btn || !modal) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        modal.classList.toggle('show');
        closeProfileDropdown();
    });

    document.addEventListener('click', (e) => {
        if (!modal.contains(e.target) && e.target !== btn) {
            modal.classList.remove('show');
        }
    });
}

function closeNotifDropdown() {
    document.getElementById('notif-modal')?.classList.remove('show');
}

function closeProfileDropdown() {
    document.getElementById('profile-menu')?.classList.remove('show');
}

/**
 * Populates the header with the user's display name.
 * @param {string} name - User's full name
 * @param {string} email - User's email
 */
export function populateHeaderUser(name, email) {
    const safeName = sanitizeText(name || 'User');
    const safeEmail = sanitizeText(email || '');

    const nameEls = ['user-display-name', 'user-display-name-pop'];
    nameEls.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = safeName;
    });

    const avatarEl = document.querySelector('.avatar-circle');
    if (avatarEl) {
        avatarEl.textContent = safeName.charAt(0).toUpperCase();
    }

    const emailEl = document.getElementById('user-full-email');
    if (emailEl) emailEl.textContent = safeEmail;
}

// ─── SECURITY HELPERS ────────────────────────────────────────

/**
 * Sanitizes text to prevent XSS when inserting into the DOM via textContent.
 * Use this before setting innerHTML for untrusted data.
 * @param {string} str
 * @returns {string}
 */
export function sanitizeText(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Parses a Firestore Timestamp or Date into a readable string.
 * @param {object|Date|null} ts
 * @returns {string}
 */
export function formatTimestamp(ts) {
    if (!ts) return 'N/A';
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleDateString('en-PH', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
}

/**
 * Parses a Firestore Timestamp or Date into a relative time string.
 * @param {object|Date|null} ts
 * @returns {string}
 */
export function relativeTime(ts) {
    if (!ts) return '';
    const date   = ts.toDate ? ts.toDate() : new Date(ts);
    const diff   = Date.now() - date.getTime();
    const mins   = Math.floor(diff / 60000);
    const hours  = Math.floor(diff / 3600000);
    const days   = Math.floor(diff / 86400000);

    if (mins  < 1)  return 'just now';
    if (mins  < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days  < 7)  return `${days}d ago`;
    return formatTimestamp(ts);
}
