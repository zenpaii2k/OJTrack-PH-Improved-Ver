/**
 * OJTrack PH — register.js  (Fixed)
 * ═══════════════════════════════════════════════════════════════
 *
 * ROOT CAUSE ANALYSIS
 * ═══════════════════════════════════════════════════════════════
 *
 * WHY THE RE-REGISTER MODAL NEVER APPEARS
 * ────────────────────────────────────────
 *
 * The bug is in DOMContentLoaded → checkExistingUser(email).
 *
 *   async function checkExistingUser(email) {
 *       const q = query(
 *           collection(db, 'users'),
 *           where('email', '==', email.toLowerCase())   ← LIST query
 *       );
 *       const snap = await getDocs(q);   ← throws PERMISSION_DENIED
 *       ...
 *   }
 *
 * This is a Firestore COLLECTION LIST query (getDocs + where()).
 * The Firestore rule for /users is:
 *
 *   match /users/{userId} {
 *     allow read: if isAuth();   ← covers both get AND list
 *   }
 *
 * At the moment this runs, the student is UNAUTHENTICATED — they
 * have not signed in or created an account. isAuth() = false.
 * Firestore throws PERMISSION_DENIED.
 *
 * The exception propagates out of checkExistingUser() and is caught
 * by the SAME try/catch that wraps validateInvite():
 *
 *   try {
 *     const result = await validateInvite(inviteId);   ← succeeds
 *     inviteData   = result.invite;
 *     ...
 *     const existingSnap = await checkExistingUser(...); ← throws
 *
 *     if (existingSnap) {
 *       await handleReturningStudent(existingSnap);     ← NEVER reached
 *     }
 *   } catch (err) {
 *     showBannerError('Invalid or expired invite link.'); ← wrong message
 *     form.inputs.forEach(el => el.disabled = true);     ← form disabled
 *     return;                                            ← exits setup
 *   }
 *
 * Consequences of this single error:
 *   1. handleReturningStudent() is never called
 *   2. showReRegModal() is never called
 *   3. The modal never appears
 *   4. Form inputs are disabled with a misleading error message
 *   5. setupLegalHandlers / setupPasswordStrength / etc. never run
 *      (the return exits before them — even new students can't register)
 *
 * SECONDARY CSS ISSUE (would have mattered if modal code ran)
 * ────────────────────────────────────────────────────────────
 *
 * The modal CSS uses:
 *   .modal        { opacity: 0; pointer-events: none; display: flex; }
 *   .hidden       { display: none !important; }
 *   .modal:not(.hidden) { opacity: 1; pointer-events: auto; }
 *
 * showReRegModal() does:
 *   modal.classList.remove('hidden');   ← triggers opacity transition ✓
 *   modal.style.display = 'flex';      ← redundant but harmless
 *
 * The modal visibility relies on the CSS :not(.hidden) selector.
 * The inline display:flex is a no-op since the class already sets it.
 * This is fine, but the original showReRegModal also has this guard:
 *
 *   if (!modal) { return Promise.reject(new Error('Modal missing')); }
 *
 * The modal IS present in the HTML. So if the JS code had reached
 * showReRegModal(), it would have displayed correctly via the CSS
 * opacity transition. The CSS is not the primary failure.
 *
 * THE FIX
 * ────────
 * Replace the unauthenticated Firestore list query with Firebase Auth's
 * fetchSignInMethodsForEmail(). This:
 *   - Works WITHOUT authentication (no Firestore read)
 *   - Returns ['password'] if email is registered in Auth
 *   - Returns [] if not registered
 *   - Never throws PERMISSION_DENIED
 *   - Does not expose other users' Firestore data
 *
 * We also restructure handleReturningStudent to not require a Firestore
 * snap before sign-in (we don't have read permission until signed in).
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { db, auth } from '../firebase-config.js';
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    onAuthStateChanged,
    fetchSignInMethodsForEmail   // ← ADDED: works without auth, replaces Firestore check
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    doc, setDoc, getDoc, updateDoc, arrayUnion, serverTimestamp,
    query, collection, where, getDocs, arrayRemove, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { initTheme, sanitizeText } from '../js/theme.js';

// ─── INIT ────────────────────────────────────────────────────
initTheme();

async function waitForAuthReady() {
    if (auth.currentUser) return auth.currentUser;
    return new Promise((resolve) => {
        const unsub = onAuthStateChanged(auth, (user) => { unsub(); resolve(user); });
    });
}

// ─── INVITE CONTEXT ──────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const inviteId  = urlParams.get('inviteId');

let inviteData  = null;
let currentRole = 'student';

// ─── LEGAL CONTENT ───────────────────────────────────────────
const LEGAL = {
    privacy: {
        title: 'Privacy Policy',
        content: `
          <p><em>Last Updated: April 2026</em></p>
          <h4>1. Information We Collect</h4>
          <p>Nous R&D collects personal information including your full name, school email, student ID, and OJT-related data (clock-in/out times, tasks, and uploaded documents).</p>
          <h4>2. How We Use Your Data</h4>
          <p>Your data is used solely for tracking internship progress. Attendance logs and uploaded requirements are shared only with your designated OJT Adviser/Coordinator.</p>
          <h4>3. Data Security</h4>
          <p>We use Firebase's industry-standard encryption and role-based access control. While we strive to protect your data, no digital storage is 100% secure. By using OJTrack PH, you acknowledge this risk.</p>
          <h4>4. Third-Party Services</h4>
          <p>We do not sell your data. We use Firebase for authentication and database management. No advertising networks are used.</p>
          <h4>5. Data Retention</h4>
          <p>Your data is retained for the duration of your OJT program and for one year thereafter, after which it may be anonymized or deleted upon request.</p>
        `
    },
    terms: {
        title: 'Terms and Conditions',
        content: `
          <p><em>Last Updated: April 2026</em></p>
          <h4>1. User Conduct</h4>
          <p>Users must provide truthful and accurate OJT logs. Falsifying hours or documents violates institutional integrity and may result in immediate account termination and referral to the appropriate academic authority.</p>
          <h4>2. Intellectual Property</h4>
          <p>OJTrack PH and its content are owned by Nous R&D and are protected by Philippine and international intellectual property laws.</p>
          <h4>3. Limitation of Liability</h4>
          <p>Nous R&D is a tool provider and is not responsible for disputes between students, schools, and host training establishments (HTEs).</p>
          <h4>4. Modifications</h4>
          <p>We reserve the right to modify these terms at any time. Continued use of the platform constitutes acceptance of the updated terms.</p>
          <h4>5. Governing Law</h4>
          <p>These terms are governed by the laws of the Republic of the Philippines.</p>
        `
    }
};

// ─── DOM ELEMENTS ─────────────────────────────────────────────
const form       = document.getElementById('registration-form');
const submitBtn  = document.getElementById('main-submit-btn');
const submitLbl  = document.getElementById('submit-label');
const submitSpin = document.getElementById('submit-spinner');
const agreeBox   = document.getElementById('reg-agree-terms');
const errBanner  = document.getElementById('form-error-banner');
const legalModal = document.getElementById('legal-modal');
const legalTitle = document.getElementById('legal-title');
const legalCont  = document.getElementById('legal-content');

function sanitizeInput(str, maxLen = 200) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLen);
}

function setLoading(state) {
    submitBtn.disabled        = state;
    submitLbl.textContent     = state ? 'Creating account…' : 'Create Account';
    submitSpin.style.display  = state ? 'inline-block' : 'none';
}

// ─── FIX: EMAIL EXISTENCE CHECK VIA FIREBASE AUTH ────────────
//
// BEFORE (broken):
//   async function checkExistingUser(email) {
//       const q    = query(collection(db, 'users'),
//                          where('email', '==', email.toLowerCase()));
//       const snap = await getDocs(q);   ← PERMISSION_DENIED (unauthenticated)
//       ...
//   }
//
// WHY IT FAILED:
//   getDocs() with a where() clause is a Firestore LIST operation.
//   The rule `allow read: if isAuth()` requires authentication.
//   The student has no account yet → isAuth() = false → PERMISSION_DENIED.
//   This exception propagates to the outer try/catch in DOMContentLoaded,
//   which shows "Invalid or expired invite link", disables the form,
//   and returns early — handleReturningStudent() is never called,
//   so the modal never appears.
//
// AFTER (fixed):
//   fetchSignInMethodsForEmail() is a Firebase Auth SDK call that:
//   - Works WITHOUT any authentication (no Firestore read)
//   - Returns ['password'] if the email is registered in Firebase Auth
//   - Returns [] if the email is not registered
//   - Never throws PERMISSION_DENIED
//   - Requires no Firestore security rule changes
//
// ─────────────────────────────────────────────────────────────
async function checkEmailExistsInAuth(email) {
    try {
        const methods = await fetchSignInMethodsForEmail(auth, email.toLowerCase());
        return methods.length > 0;   // ['password'] = exists, [] = new user
    } catch (err) {
        if (err.code === 'auth/invalid-email') return false;
        // Re-throw anything unexpected (network error, etc.)
        throw err;
    }
}

/**
 * Tries to fetch the student's Firestore user document AFTER sign-in.
 * Called inside handleReturningStudent after signInWithEmailAndPassword
 * succeeds, so isAuth() = true and the read is permitted.
 *
 * Returns the user data or null if the document doesn't exist yet.
 * Not throwing on absence is important: Auth and Firestore can be
 * out of sync (account in Auth but no Firestore doc yet).
 */
async function fetchUserDocAfterSignIn(uid) {
    try {
        const snap = await getDoc(doc(db, 'users', uid));
        return snap.exists() ? snap.data() : null;
    } catch {
        return null;
    }
}

// ─── INVITE VALIDATION ────────────────────────────────────────
async function validateInvite(id) {
    if (!id) return null;
    const ref  = doc(db, 'invitations', id);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('Invalid invite link.');
    const data = snap.data();
    if (data.status !== 'pending') throw new Error('This invite has already been used or cancelled.');
    return { ref, invite: data };
}

// ─── BATCH HELPERS ────────────────────────────────────────────
async function removeStudentFromAllBatches(uid) {
    const q    = query(collection(db, 'batches'), where('studentUids', 'array-contains', uid));
    const snap = await getDocs(q);
    await Promise.all(
        snap.docs.map(d =>
            updateDoc(doc(db, 'batches', d.id), { studentUids: arrayRemove(uid) })
        )
    );
}

// ─── APPLY INVITE (transaction) ───────────────────────────────
async function applyInvite(uid) {
    if (!inviteId || !inviteData) return;

    const batchRef  = doc(db, 'batches',     inviteData.batchId);
    const inviteRef = doc(db, 'invitations', inviteId);
    const userRef   = doc(db, 'users',       uid);

    await runTransaction(db, async (tx) => {
        const [inviteSnap, batchSnap] = await Promise.all([
            tx.get(inviteRef),
            tx.get(batchRef),
        ]);

        if (!inviteSnap.exists())  throw new Error('Invite no longer exists.');
        if (!batchSnap.exists())   throw new Error('Batch not found.');

        const invite = inviteSnap.data();
        if (invite.status !== 'pending') throw new Error('Invite already used.');

        tx.update(batchRef, {
            studentUids: arrayUnion(uid)
        });

        tx.update(inviteRef, {
            status: 'used',
            usedBy: uid,
            usedAt: serverTimestamp()
        });

        tx.update(userRef, {
            batch:        invite.batchId,
            supervisorId: invite.supervisorId || null,
            updatedAt:    serverTimestamp()
        });
    });
}

// ─── RE-REGISTER MODAL ────────────────────────────────────────
//
// FIX: Added a CSS-aware guard. The original modal CSS uses
// opacity: 0 + pointer-events: none by default, and
// .modal:not(.hidden) { opacity: 1 } as the active state.
//
// showReRegModal removes '.hidden' to trigger the CSS transition,
// then also sets display:'flex' as an inline style.
// We keep both for cross-browser reliability, but the primary
// visibility mechanism is the CSS class removal.
//
function showReRegModal(userData) {
    const modal = document.getElementById('reRegModal');
    const info  = document.getElementById('reRegInfo');
    const pass  = document.getElementById('reRegPassword');

    if (!modal) {
        console.error('[ReRegModal] #reRegModal not found in DOM.');
        return Promise.reject(new Error('Modal element missing from page'));
    }

    // Remove hidden class FIRST — this triggers the CSS opacity transition.
    // The CSS rule `.modal:not(.hidden)` sets opacity:1 and pointer-events:auto.
    modal.classList.remove('hidden');

    // Also set inline display to ensure the element is visible
    // even if CSS is somehow not loaded.
    modal.style.display      = 'flex';
    modal.style.opacity      = '1';
    modal.style.pointerEvents = 'auto';

    document.body.classList.add('modal-open');

    if (pass) pass.value = '';

    // Show what we know. Email is always available from the invite.
    // Name/role/batch may be unknown until after sign-in.
    info.innerHTML = `
        <div class="reReg-summary">
            <p><strong>Email:</strong> ${sanitizeText(userData.email || '—')}</p>
            ${userData.name  ? `<p><strong>Name:</strong>  ${sanitizeText(userData.name)}</p>` : ''}
            ${userData.role  ? `<p><strong>Role:</strong>  ${sanitizeText(userData.role)}</p>` : ''}
            ${userData.batch ? `<p><strong>Batch:</strong> ${sanitizeText(userData.batch)}</p>` : ''}
        </div>
    `;

    return new Promise((resolve, reject) => {
        const confirmBtn = document.getElementById('confirmReReg');
        const cancelBtn  = document.getElementById('cancelReReg');

        if (!confirmBtn || !cancelBtn) {
            modal.classList.add('hidden');
            modal.style.display = 'none';
            document.body.classList.remove('modal-open');
            return reject(new Error('Modal buttons missing from DOM'));
        }

        function cleanup() {
            modal.classList.add('hidden');
            modal.style.display      = 'none';
            modal.style.opacity      = '';
            modal.style.pointerEvents = '';
            document.body.classList.remove('modal-open');
            confirmBtn.onclick = null;
            cancelBtn.onclick  = null;
            window.removeEventListener('keydown', escHandler);
        }

        confirmBtn.onclick = () => {
            const password = pass?.value || '';
            if (!password) {
                if (pass) {
                    pass.style.border = '2px solid var(--danger, red)';
                    pass.placeholder  = 'Password is required';
                    pass.focus();
                }
                return;
            }
            if (pass) pass.style.border = '';
            cleanup();
            resolve(password);
        };

        cancelBtn.onclick = () => {
            cleanup();
            reject(new Error('User cancelled'));
        };

        function escHandler(e) {
            if (e.key === 'Escape') { cleanup(); reject(new Error('User cancelled')); }
        }
        window.addEventListener('keydown', escHandler);
    });
}

// ─── RETURNING STUDENT INVITE HANDLER ────────────────────────
//
// FIX: Now accepts email (string) instead of existingSnap (Firestore doc).
//
// BEFORE:
//   async function handleReturningStudent(existingSnap) {
//       const uid      = existingSnap.id;          ← requires Firestore read
//       const userData = existingSnap.data();       ← requires Firestore read
//       const email    = userData.email || ...;
//   }
//
// AFTER:
//   async function handleReturningStudent(email) {
//       // Show modal with email (always known from invite)
//       // Sign in → get uid from Auth result → apply invite
//       // Fetch Firestore doc after sign-in for richer modal info (optional)
//   }
//
// This restructuring is necessary because we can't read Firestore
// user documents before authentication. The email is always available
// from the invite document (which allows unauthenticated get).
//
async function handleReturningStudent(email) {
    // Build minimal info object using only what we know without Firestore
    const minimalInfo = {
        email: email,
        name:  null,   // unknown until signed in
        role:  null,
        batch: null,
    };

    let password;
    try {
        password = await showReRegModal(minimalInfo);
    } catch (modalErr) {
        if (modalErr.message === 'User cancelled') {
            // Student cancelled — restore form so they can try again
            setLoading(false);
            return;
        }
        // Actual error (missing DOM elements etc.)
        console.error('[ReRegModal] Error:', modalErr);
        showBannerError('Could not show the confirmation dialog. Please refresh the page.');
        return;
    }

    setLoading(true);

    try {
        const userCred = await signInWithEmailAndPassword(auth, email, password);
        const uid      = userCred.user.uid;

        // Force token refresh so Firestore rules evaluate correctly
        await userCred.user.getIdToken(true);

        await applyInvite(uid);
        window.location.replace('/student/dashboard.html');

    } catch (err) {
        setLoading(false);
        const messages = {
            'auth/wrong-password':      'Incorrect password. Please try again.',
            'auth/invalid-credential':  'Incorrect password. Please try again.',
            'auth/too-many-requests':   'Too many attempts. Please wait a moment and try again.',
            'auth/user-disabled':       'This account has been disabled. Please contact support.',
            'auth/network-request-failed': 'Network error. Check your connection.',
        };
        showBannerError(messages[err.code] || err.message || 'Sign-in failed. Please try again.');
    }
}

// ─── DOM READY ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {

    if (inviteId) {
        currentRole = 'student';

        document.querySelector('.role-selector-main')?.style.setProperty('display', 'none');
        document.querySelector('.footer-link')?.style.setProperty('display', 'none');

        // ── STEP 1: Validate the invite (public read — always works) ──
        let inviteValidationFailed = false;

        try {
            const result = await validateInvite(inviteId);
            inviteData   = result.invite;
        } catch (err) {
            // Invite is genuinely invalid (doesn't exist, already used, etc.)
            console.error('[Invite] Validation failed:', err);
            showBannerError(err.message || 'Invalid or expired invite link.');
            form.querySelectorAll('input:not([type="button"]), button[type="submit"]')
                .forEach(el => { el.disabled = true; });
            inviteValidationFailed = true;
        }

        if (inviteValidationFailed) {
            // Still call common setup so the page isn't completely broken
            toggleRegRole(currentRole);
            setupLegalHandlers();
            return;
        }

        // ── STEP 2: Pre-fill the email field from invite ──────────────
        if (inviteData?.email) {
            const emailInput = document.getElementById('reg-email');
            if (emailInput) {
                emailInput.value    = inviteData.email.toLowerCase();
                emailInput.disabled = true;
            }
        }

        // ── STEP 3: Check if email already exists in Firebase Auth ────
        //
        // FIX: Uses fetchSignInMethodsForEmail() instead of Firestore query.
        //
        // BEFORE (broken):
        //   const existingSnap = await checkExistingUser(inviteData.email);
        //   → PERMISSION_DENIED (unauthenticated Firestore list query)
        //   → caught by outer catch → form disabled → modal never shows
        //
        // AFTER (fixed):
        //   const emailExists = await checkEmailExistsInAuth(inviteData.email);
        //   → Firebase Auth SDK call, no authentication required
        //   → returns true/false without touching Firestore
        //   → isolated try/catch so invite validation errors stay separate
        //
        if (inviteData?.email) {
            try {
                const emailExists = await checkEmailExistsInAuth(inviteData.email);

                if (emailExists) {
                    // RETURNING STUDENT: email already registered in Firebase Auth.
                    // Hide the registration form and show the re-register modal.
                    const formSections = document.querySelectorAll(
                        '.form-section, .legal-consent-section, #main-submit-btn'
                    );
                    formSections.forEach(el => { el.style.display = 'none'; });

                    await handleReturningStudent(inviteData.email);

                    // If we reach here, student cancelled the modal.
                    // Restore form so they can try again.
                    formSections.forEach(el => { el.style.display = ''; });

                    // Re-run setup after restore (was skipped during modal flow)
                    toggleRegRole(currentRole);
                    setupLegalHandlers();
                    setupPasswordStrength();
                    setupPasswordToggle();
                    setupFormValidation();
                    return;
                }

                // NEW STUDENT: email not in Auth → show normal registration form.

            } catch (err) {
                // checkEmailExistsInAuth failure (network error etc.)
                // Don't block registration — log and continue to normal form.
                console.warn('[Invite] Auth email check failed:', err.message);
                // Fall through to normal form setup
            }
        }
    }

    // ── COMMON SETUP (all flows) ─────────────────────────────────
    // Runs for:
    //   (a) Non-invite registration (inviteId is null)
    //   (b) Invite flow where email is NOT already registered
    //   (c) Invite flow where email check failed (graceful fallback)
    toggleRegRole(currentRole);
    setupLegalHandlers();
    setupPasswordStrength();
    setupPasswordToggle();
    setupFormValidation();
});

// ─── ROLE SWITCHING ──────────────────────────────────────────
window.toggleRegRole = toggleRegRole;

function toggleRegRole(role) {
    currentRole = role;
    document.getElementById('student-only-fields').style.display =
        role === 'student' ? 'block' : 'none';
    document.getElementById('supervisor-only-fields').style.display =
        role === 'supervisor' ? 'block' : 'none';
    document.getElementById('btn-student').classList.toggle('active',    role === 'student');
    document.getElementById('btn-supervisor').classList.toggle('active', role === 'supervisor');
    updateRequiredFields(role);
}

function updateRequiredFields(role) {
    const studentRequired    = ['std-school','std-course','std-year','std-section','std-company','std-total-hours'];
    const supervisorRequired = ['sup-org','sup-contact'];
    [...studentRequired, ...supervisorRequired].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.required = (role === 'student' ? studentRequired : supervisorRequired).includes(id);
    });
}

// ─── LEGAL MODAL ─────────────────────────────────────────────
function setupLegalHandlers() {
    const closeBtn  = document.getElementById('close-legal-btn');
    const underBtn  = document.getElementById('legal-understand-btn');
    const privLink  = document.getElementById('privacy-link');
    const termsLink = document.getElementById('terms-link');

    function openLegal(type) {
        const data = LEGAL[type];
        legalTitle.textContent = data.title;
        legalCont.innerHTML    = data.content;
        legalModal.classList.add('show');
        legalModal.style.display = 'flex';
    }

    function closeLegal() {
        legalModal.classList.remove('show');
        legalModal.style.display = 'none';
    }

    privLink?.addEventListener('click',  () => openLegal('privacy'));
    termsLink?.addEventListener('click', () => openLegal('terms'));
    closeBtn?.addEventListener('click',  closeLegal);
    underBtn?.addEventListener('click',  closeLegal);

    legalModal.addEventListener('click', (e) => {
        if (e.target === legalModal) closeLegal();
    });

    agreeBox.addEventListener('change', () => {
        submitBtn.disabled = !agreeBox.checked;
    });
}

// ─── PASSWORD STRENGTH ────────────────────────────────────────
function setupPasswordStrength() {
    const pwInput = document.getElementById('reg-password');
    const fill    = document.getElementById('pw-strength-fill');
    if (!pwInput || !fill) return;

    pwInput.addEventListener('input', () => {
        const val = pwInput.value;
        let score = 0;
        if (val.length >= 8)           score++;
        if (/[A-Z]/.test(val))         score++;
        if (/[0-9]/.test(val))         score++;
        if (/[^A-Za-z0-9]/.test(val))  score++;

        fill.className = 'pw-strength-fill';
        if (val.length === 0) { fill.style.width = '0%'; return; }

        const widths = ['25%', '50%', '75%', '100%'];
        fill.style.width = widths[score - 1] || '25%';
        if (score <= 1)      fill.classList.add('weak');
        else if (score <= 2) fill.classList.add('medium');
        else                 fill.classList.add('strong');
    });
}

function setupPasswordToggle() {
    const btn   = document.getElementById('toggle-pw');
    const input = document.getElementById('reg-password');
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
        const isHidden  = input.type === 'password';
        input.type      = isHidden ? 'text' : 'password';
        btn.textContent = isHidden ? '🙈' : '👁️';
    });
    input.addEventListener('mousedown', (e) => {
        if (e.offsetX > input.offsetWidth - 30) e.preventDefault();
    });
}

// ─── FIELD VALIDATION ─────────────────────────────────────────
function showFieldError(errorId, message) {
    const el = document.getElementById(errorId);
    if (el) el.textContent = message;
}

function clearFieldError(errorId) {
    const el = document.getElementById(errorId);
    if (el) el.textContent = '';
}

function setupFormValidation() {
    const emailInput = document.getElementById('reg-email');
    emailInput?.addEventListener('blur', () => {
        const val = emailInput.value.trim();
        if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
            showFieldError('email-error', 'Please enter a valid email address.');
        } else {
            clearFieldError('email-error');
        }
    });

    ['reg-firstname', 'reg-surname'].forEach((id, i) => {
        const errId = i === 0 ? 'fn-error' : 'ln-error';
        document.getElementById(id)?.addEventListener('blur', function() {
            const val = this.value.trim();
            if (val && !/^[A-Za-zÀ-ÖØ-öø-ÿ\s\-\.\']+$/.test(val)) {
                showFieldError(errId, 'Please use letters only.');
            } else {
                clearFieldError(errId);
            }
        });
    });
}

function validateForm() {
    let valid = true;
    const email    = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const fname    = document.getElementById('reg-firstname').value.trim();
    const lname    = document.getElementById('reg-surname').value.trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showFieldError('email-error', 'Valid email is required.'); valid = false;
    }
    if (!password || password.length < 8) {
        showFieldError('pw-error', 'Password must be at least 8 characters.'); valid = false;
    }
    if (!fname || !/^[A-Za-zÀ-ÖØ-öø-ÿ\s\-\.\']+$/.test(fname)) {
        showFieldError('fn-error', 'First name is required (letters only).'); valid = false;
    }
    if (!lname || !/^[A-Za-zÀ-ÖØ-öø-ÿ\s\-\.\']+$/.test(lname)) {
        showFieldError('ln-error', 'Last name is required (letters only).'); valid = false;
    }

    if (currentRole === 'student') {
        const school  = document.getElementById('std-school').value.trim();
        const course  = document.getElementById('std-course').value;
        const section = document.getElementById('std-section').value.trim();
        const company = document.getElementById('std-company').value.trim();
        const hours   = parseInt(document.getElementById('std-total-hours').value, 10);

        if (!school)  { showFieldError('school-error',  'School name is required.');  valid = false; }
        if (!course)  { showFieldError('course-error',  'Please select a course.');   valid = false; }
        if (!section) { showFieldError('section-error', 'Section is required.');      valid = false; }
        if (!company) { showFieldError('company-error', 'Company name is required.'); valid = false; }
        if (!hours || hours < 100 || hours > 2000) {
            showFieldError('hours-error', 'Enter valid hours (100–2000).'); valid = false;
        }
    }

    if (currentRole === 'supervisor') {
        const org     = document.getElementById('sup-org').value.trim();
        const contact = document.getElementById('sup-contact').value.trim();
        const checked = document.querySelectorAll('input[name="sup-course"]:checked');
        if (!org)             { showFieldError('org-error',     'School/institution is required.'); valid = false; }
        if (!contact)         { showFieldError('contact-error', 'Contact number is required.');     valid = false; }
        if (!checked.length)  { showFieldError('courses-error', 'Select at least one course.');     valid = false; }
    }

    return valid;
}

function showBannerError(message) {
    errBanner.textContent = `⚠️ ${sanitizeText(message)}`;
    errBanner.style.display = 'block';
    errBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideBannerError() {
    errBanner.style.display = 'none';
    errBanner.textContent   = '';
}

// ─── FORM SUBMIT ─────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideBannerError();
    if (!validateForm()) return;
    setLoading(true);

    const email    = document.getElementById('reg-email').value.trim().toLowerCase();
    const password = document.getElementById('reg-password').value;

    try {
        let userCred;

        try {
            userCred = await createUserWithEmailAndPassword(auth, email, password);

        } catch (authErr) {
            // Safety net for auth/email-already-in-use.
            // This should not normally fire for invite flows because we already
            // check in DOMContentLoaded, but handles edge cases
            // (e.g. student registered externally between page-load and submit).
            if (authErr.code === 'auth/email-already-in-use') {
                let enteredPassword;
                try {
                    // Show modal with email info; we don't have Firestore data yet
                    enteredPassword = await showReRegModal({ email, name: null, role: null, batch: null });
                } catch {
                    setLoading(false);
                    return;
                }

                const signedIn = await signInWithEmailAndPassword(auth, email, enteredPassword);
                const uid      = signedIn.user.uid;
                await signedIn.user.getIdToken(true);

                if (inviteId && inviteData) {
                    await applyInvite(uid);
                }

                window.location.replace('/student/dashboard.html');
                return;
            }

            throw authErr;
        }

        const uid = userCred.user.uid;
        await userCred.user.getIdToken(true);

        const payload = currentRole === 'student'
            ? buildStudentPayload(uid, email)
            : buildSupervisorPayload(uid, email);

        await setDoc(doc(db, 'users', uid), payload);

        if (inviteId && inviteData) {
            await applyInvite(uid);
        }

        window.location.replace(
            currentRole === 'student'
                ? '/student/dashboard.html'
                : '/supervisor/supervisordashboard.html'
        );

    } catch (err) {
        console.error('[Register] Submit error:', err);
        const friendly = {
            'auth/invalid-email':          'The email address format is invalid.',
            'auth/weak-password':          'Password must be at least 8 characters.',
            'auth/network-request-failed': 'Network error. Check your connection.',
        };
        showBannerError(friendly[err.code] || err.message || 'Registration failed.');
        setLoading(false);
    }
});

// ─── PAYLOAD BUILDERS ────────────────────────────────────────
function buildStudentPayload(uid, email) {
    const firstName     = sanitizeInput(document.getElementById('reg-firstname').value);
    const surname       = sanitizeInput(document.getElementById('reg-surname').value);
    const school        = sanitizeInput(document.getElementById('std-school')?.value);
    const course        = document.getElementById('std-course')?.value;
    const year          = document.getElementById('std-year')?.value;
    const section       = sanitizeInput(document.getElementById('std-section')?.value);
    const company       = sanitizeInput(document.getElementById('std-company')?.value);
    const requiredHours = Number(document.getElementById('std-total-hours')?.value || 0);
    const timeStart     = document.getElementById('std-start')?.value || null;
    const timeEnd       = document.getElementById('std-end')?.value   || null;
    const fullSection   = course && section ? `${course}-${section}` : section;

    return {
        uid,
        role:             'student',
        email:            email.toLowerCase(),
        firstName,
        surname,
        name:             `${firstName} ${surname}`,
        school,
        course,
        yearLevel:        year,
        section,
        fullSection,
        company,
        requiredHours,
        hoursCompleted:   0,
        currentSessionId: null,
        timeStart,
        timeEnd,
        batch:            inviteData?.batchId     ?? null,
        supervisorId:     inviteData?.supervisorId ?? null,
        createdAt:        serverTimestamp(),
        updatedAt:        serverTimestamp()
    };
}

function buildSupervisorPayload(uid, email) {
    const firstName      = sanitizeInput(document.getElementById('reg-firstname').value);
    const surname        = sanitizeInput(document.getElementById('reg-surname').value);
    const organization   = sanitizeInput(document.getElementById('sup-org')?.value);
    const number         = sanitizeInput(document.getElementById('sup-contact')?.value);
    const checkedCourses = Array.from(
        document.querySelectorAll('input[name="sup-course"]:checked')
    ).map(cb => cb.value);
    const staffId = `EMP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    return {
        uid,
        role:            'supervisor',
        email,
        firstName,
        surname,
        name:            `${firstName} ${surname}`,
        organization,
        number,
        designation:     'OJT Coordinator',
        assignedCourses: checkedCourses,
        staffId,
        createdAt:       serverTimestamp(),
        updatedAt:       serverTimestamp()
    };
}
