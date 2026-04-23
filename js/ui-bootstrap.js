import { toggleTheme, getTheme, applyTheme } from './theme.js';
import { auth } from '../firebase-config.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';

// ─── AUTO-WIRE ON DOM READY ──────────────────────────────────
document.addEventListener('DOMContentLoaded', wireAll);

// Also run immediately in case DOMContentLoaded already fired
// (since this is a module, it runs deferred, so DOMContentLoaded
// should still be pending — but the immediate call is a safety net)
if (document.readyState !== 'loading') wireAll();

function wireAll() {
    wireThemeToggles();
    wireLogoutButtons();
    wireProfileDropdown();
    wireNotifDropdown();
    wireGlobalClickDismiss();
}

// ─── THEME TOGGLES ───────────────────────────────────────────
function wireThemeToggles() {
    // Wire every element with these IDs (header + sidebar buttons)
    ['theme-toggle-btn', 'sidebar-theme-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn || btn.dataset.bootstrapped) return;
        btn.dataset.bootstrapped = '1';
        btn.addEventListener('click', () => {
            toggleTheme();
            // Update button emoji/text if it shows current state
            updateThemeButtonLabels();
        });
    });

    // Apply theme from storage on load (safety net)
    const saved = localStorage.getItem('ojtrack-theme') || 'dark';
    applyTheme(saved);
    updateThemeButtonLabels();
}

function updateThemeButtonLabels() {
    const isDark = getTheme() === 'dark';
    // Optionally update any label that says "Dark Mode" / "Light Mode"
    document.querySelectorAll('[data-theme-label]').forEach(el => {
        el.textContent = isDark ? '🌙 Dark Mode' : '☀️ Light Mode';
    });
}

// ─── LOGOUT BUTTONS ──────────────────────────────────────────
function wireLogoutButtons() {
    ['logout-link', 'sidebar-logout-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn || btn.dataset.bootstrapped) return;
        btn.dataset.bootstrapped = '1';
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                await signOut(auth);
            } catch (err) {
                console.error('[Bootstrap] logout error:', err);
            }
            window.location.replace('/index.html');
        });
    });
}

// ─── PROFILE DROPDOWN ────────────────────────────────────────
function wireProfileDropdown() {
    const trigger = document.getElementById('profile-trigger');
    const menu    = document.getElementById('profile-menu');
    if (!trigger || !menu || trigger.dataset.bootstrapped) return;
    trigger.dataset.bootstrapped = '1';

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.toggle('show');
        // Close notif when profile opens
        document.getElementById('notif-modal')?.classList.remove('show');
    });
}

// ─── NOTIFICATION DROPDOWN ────────────────────────────────────
function wireNotifDropdown() {
    const btn   = document.getElementById('notif-btn');
    const modal = document.getElementById('notif-modal');
    if (!btn || !modal || btn.dataset.bootstrapped) return;
    btn.dataset.bootstrapped = '1';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        modal.classList.toggle('show');
        // Close profile when notif opens
        document.getElementById('profile-menu')?.classList.remove('show');
    });
}

// ─── GLOBAL CLICK DISMISS ────────────────────────────────────
function wireGlobalClickDismiss() {
    // Only add one listener (check flag)
    if (window._bootstrapDismissWired) return;
    window._bootstrapDismissWired = true;

    document.addEventListener('click', (e) => {
        const profileMenu = document.getElementById('profile-menu');
        const notifModal  = document.getElementById('notif-modal');
        const profileBtn  = document.getElementById('profile-trigger');
        const notifBtn    = document.getElementById('notif-btn');

        // Dismiss profile menu if click outside
        if (profileMenu && !profileMenu.contains(e.target) && e.target !== profileBtn) {
            profileMenu.classList.remove('show');
        }

        // Dismiss notif dropdown if click outside
        if (notifModal && !notifModal.contains(e.target) && e.target !== notifBtn) {
            notifModal.classList.remove('show');
        }
    });
}

// ─── EXPORT (for explicit use if needed) ─────────────────────
export { wireAll };
