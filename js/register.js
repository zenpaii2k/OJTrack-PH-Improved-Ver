import { db, auth } from '../firebase-config.js';
import {
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    signInWithEmailAndPassword
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

// ─── FIRESTORE LOOKUP ────────────────────────────────────────

/**
 * Looks up a Firestore user document by email address.
 * Returns { id, data() } or null if not found.
 */
async function checkExistingUser(email) {
    const q    = query(collection(db, 'users'), where('email', '==', email.toLowerCase()));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { id: d.id, data: () => d.data() };
}

// ─── INVITE VALIDATION ────────────────────────────────────────

/**
 * Fetches and validates the invite document.
 *
 * FIX: The Firestore rule for invitations now uses:
 *   allow get: if true;
 * so this call succeeds even before the user is authenticated.
 * Previously `allow read: if isAuth()` blocked unauthenticated users
 * → PERMISSION_DENIED immediately on page load.
 */
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

/**
 * Atomically:
 *   1. Re-validates the invite is still pending.
 *   2. Adds student uid to batch.studentUids (arrayUnion — idempotent).
 *   3. Marks invite as used.
 *   4. Updates user doc with batch + supervisorId.
 *
 * FIX (Bug #4 — batch UPDATE rule):
 *   The Firestore rule now has a third update path that allows a student
 *   to append their own uid to studentUids. Previously both rule branches
 *   failed for a student → transaction always rolled back.
 *
 * FIX (Bug #5 — double tx.update on same doc):
 *   Removed the conditional arrayRemove before arrayUnion.
 *   Two tx.update() calls on the same document ref in a transaction
 *   cause the Firestore SDK to apply only the LAST one — the arrayRemove
 *   was silently discarded anyway. arrayUnion is idempotent: if the
 *   student uid is already present, the array is unchanged (size +0).
 */
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

        // ── FIX: single arrayUnion only (no preceding arrayRemove) ──
        tx.update(batchRef, {
            studentUids: arrayUnion(uid)   // idempotent — safe for new + returning students
        });

        // Mark invite as claimed
        tx.update(inviteRef, {
            status: 'used',
            usedBy: uid,
            usedAt: serverTimestamp()
        });

        // Sync user document
        tx.update(userRef, {
            batch:        invite.batchId,
            supervisorId: invite.supervisorId || null,
            updatedAt:    serverTimestamp()
        });
    });
}

// ─── RE-REGISTER MODAL ────────────────────────────────────────

/**
 * Shows the reRegModal with the existing user's profile info.
 * Returns a Promise that resolves with the entered password on confirm,
 * or rejects on cancel / ESC.
 *
 * This function is unchanged from the original — only the TRIGGER
 * logic has changed (it now fires on page load for invite flows,
 * not only on form submission failure).
 */
function showReRegModal(userData) {
    const modal = document.getElementById('reRegModal');
    const info  = document.getElementById('reRegInfo');
    const pass  = document.getElementById('reRegPassword');

    if (!modal) {
        console.error('Re-registration modal not found in DOM');
        return Promise.reject(new Error('Modal missing'));
    }

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');

    // Reset the password field every time the modal opens
    if (pass) pass.value = '';

    info.innerHTML = `
        <div class="reReg-summary">
            <p><strong>Name:</strong>  ${sanitizeText(userData.name  || '—')}</p>
            <p><strong>Email:</strong> ${sanitizeText(userData.email || '—')}</p>
            <p><strong>Role:</strong>  ${sanitizeText(userData.role  || '—')}</p>
            <p><strong>Batch:</strong> ${sanitizeText(userData.batch || 'None')}</p>
        </div>
    `;

    return new Promise((resolve, reject) => {
        const confirmBtn = document.getElementById('confirmReReg');
        const cancelBtn  = document.getElementById('cancelReReg');

        function cleanup() {
            modal.classList.add('hidden');
            modal.style.display = 'none';
            document.body.classList.remove('modal-open');
            confirmBtn.onclick = null;
            cancelBtn.onclick  = null;
            window.removeEventListener('keydown', escHandler);
        }

        confirmBtn.onclick = () => {
            const password = pass?.value || '';
            if (!password) {
                if (pass) {
                    pass.style.border = '1px solid red';
                    pass.focus();
                }
                return;
            }
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

/**
 * Called when the invite flow detects an existing account for the
 * invited email address (whether the student is new here but has an
 * old account, or was previously removed from a batch).
 *
 * Flow:
 *   1. Show re-register modal → student enters their password.
 *   2. signInWithEmailAndPassword to verify identity.
 *   3. applyInvite() to join the batch atomically.
 *   4. Redirect to student dashboard.
 *
 * This function handles ALL cases — intentionally removed students,
 * accidentally removed students, and students who have an old account
 * and are being re-invited. The distinction does not matter here:
 * the invite is valid, the student proved their identity, so they join.
 */
async function handleReturningStudent(existingSnap) {
    const uid      = existingSnap.id;
    const userData = existingSnap.data();
    const email    = userData.email || inviteData?.email || '';

    let password;
    try {
        password = await showReRegModal(userData);
    } catch {
        // Student cancelled the modal — abort gracefully, do NOT disable the form
        setLoading(false);
        return;
    }

    setLoading(true);

    try {
        await signInWithEmailAndPassword(auth, email, password);
        const user = await waitForAuthReady();
        if (!user) throw new Error('Authentication failed.');

        // Wait for the Auth token to propagate so Firestore rules can
        // evaluate isStudent() / isAdviser() correctly in applyInvite().
        await user.getIdToken(true);

        await applyInvite(uid);
        window.location.replace('/student/dashboard.html');

    } catch (err) {
        setLoading(false);
        if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
            showBannerError('Incorrect password. Please try again.');
        } else if (err.code === 'auth/too-many-requests') {
            showBannerError('Too many attempts. Please wait a moment and try again.');
        } else {
            showBannerError(err.message || 'Sign-in failed. Please try again.');
        }
    }
}

// ─── DOM READY ───────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {

    // ── INVITE FLOW ──────────────────────────────────────────
    if (inviteId) {
        currentRole = 'student';

        // Hide role selector and "already have account" link —
        // invite is always for students only.
        document.querySelector('.role-selector-main')?.style.setProperty('display', 'none');
        document.querySelector('.footer-link')?.style.setProperty('display', 'none');

        try {
            // STEP 1: Validate the invite document.
            //
            // FIX: Now succeeds because the Firestore rule is:
            //   allow get: if true;
            // Previously `allow read: if isAuth()` blocked unauthenticated
            // reads → PERMISSION_DENIED on page load, inviteData stayed null.
            const result = await validateInvite(inviteId);
            inviteData   = result.invite;

            // STEP 2: Proactively check if an account already exists
            // for the email address attached to this invite.
            //
            // This is the KEY CHANGE from the original flow.
            // Original: existing-user check only happened inside the form
            //   submit handler AFTER createUserWithEmailAndPassword() failed
            //   with auth/email-already-in-use — a delayed, reactive check.
            //
            // New: We check immediately on page load (before the student
            //   even sees the form). If an account exists for the invited
            //   email, we show the re-register modal RIGHT AWAY.
            //
            // This covers ALL cases:
            //   - NEW student  → no account found → show normal form
            //   - RETURNING student (removed by adviser) → account found → re-register modal
            //   - RETURNING student (accidental removal) → account found → re-register modal
            //   - Student re-invited after voluntarily leaving → account found → re-register modal
            if (inviteData?.email) {
                const emailInput = document.getElementById('reg-email');

                // Pre-fill and lock the email field regardless of whether
                // the account exists or not (email is set by the adviser).
                if (emailInput) {
                    emailInput.value    = inviteData.email.toLowerCase();
                    emailInput.disabled = true;
                }

                // Check Firestore for an existing account with this email.
                const existingSnap = await checkExistingUser(inviteData.email);

                if (existingSnap) {
                    // ACCOUNT EXISTS — show re-register modal immediately.
                    // Do NOT render the registration form fields; hide them
                    // so the student isn't confused by a partially visible form.
                    const formSections = document.querySelectorAll(
                        '.form-section, .legal-consent-section, #main-submit-btn'
                    );
                    formSections.forEach(el => { el.style.display = 'none'; });

                    // Show modal. handleReturningStudent handles sign-in +
                    // applyInvite + redirect internally.
                    await handleReturningStudent(existingSnap);

                    // If we reach here, the student cancelled the modal.
                    // Restore the form so they can try again.
                    formSections.forEach(el => { el.style.display = ''; });
                    return; // Don't proceed to setupLegalHandlers etc. yet
                }
            }

        } catch (err) {
            console.error('[Invite] Validation error:', err);
            showBannerError(err.message || 'Invalid or expired invite link.');

            // Disable only the submit-related inputs, not the entire form,
            // so the student can still read the error clearly.
            form.querySelectorAll('input:not([type="button"]), button[type="submit"]')
                .forEach(el => { el.disabled = true; });

            return; // Stop setup — invite is invalid
        }
    }

    // ── COMMON SETUP (runs for all flows) ─────────────────────
    // NOTE: For non-invite flows (student navigates from index.html),
    // inviteId is null so the block above is skipped entirely.
    // Nothing below changes the standard registration behavior.
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
    document.getElementById('btn-student').classList.toggle('active', role === 'student');
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
        if (val.length >= 8)            score++;
        if (/[A-Z]/.test(val))          score++;
        if (/[0-9]/.test(val))          score++;
        if (/[^A-Za-z0-9]/.test(val))   score++;

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
    let valid  = true;
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

        if (!school)  { showFieldError('school-error',  'School name is required.');        valid = false; }
        if (!course)  { showFieldError('course-error',  'Please select a course.');          valid = false; }
        if (!section) { showFieldError('section-error', 'Section is required.');             valid = false; }
        if (!company) { showFieldError('company-error', 'Company name is required.');        valid = false; }
        if (!hours || hours < 100 || hours > 2000) {
            showFieldError('hours-error', 'Enter valid hours (100–2000).'); valid = false;
        }
    }

    if (currentRole === 'supervisor') {
        const org     = document.getElementById('sup-org').value.trim();
        const contact = document.getElementById('sup-contact').value.trim();
        const checked = document.querySelectorAll('input[name="sup-course"]:checked');
        if (!org)              { showFieldError('org-error',     'School/institution is required.'); valid = false; }
        if (!contact)          { showFieldError('contact-error', 'Contact number is required.');     valid = false; }
        if (!checked.length)   { showFieldError('courses-error', 'Select at least one course.');     valid = false; }
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
//
// NOTE: This handler is reached ONLY when:
//   (a) There is NO inviteId in the URL (standard registration from index.html), OR
//   (b) There IS an inviteId but the invited email has NO existing account
//       (new student registering for the first time via invite).
//
// The case of inviteId + EXISTING account is handled entirely in
// DOMContentLoaded → handleReturningStudent() → redirect.
// The form is hidden in that case; this handler never fires.
//
// The `auth/email-already-in-use` catch below remains as a safety
// net for edge cases (e.g. student creates an account externally
// between page load and form submit), but it is NOT the primary
// path for returning students in the invite flow.
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideBannerError();
    if (!validateForm()) return;
    setLoading(true);

    const email    = document.getElementById('reg-email').value.trim().toLowerCase();
    const password = document.getElementById('reg-password').value;

    try {
        let userCred;

        // ── Try to create a new account ───────────────────────
        try {
            userCred = await createUserWithEmailAndPassword(auth, email, password);

        } catch (authErr) {
            // SAFETY NET: account already exists but wasn't caught on page load.
            // This should rarely happen in normal use after the page-load check.
            // It can occur if the student created an account externally, or if
            // checkExistingUser() returned null due to eventual consistency.
            if (authErr.code === 'auth/email-already-in-use') {
                const existingSnap = await checkExistingUser(email);
                if (!existingSnap) {
                    throw new Error('Account exists in Auth but no profile found. Contact support.');
                }

                const uid      = existingSnap.id;
                let enteredPassword;

                try {
                    enteredPassword = await showReRegModal(existingSnap.data());
                } catch {
                    // Student cancelled the modal
                    setLoading(false);
                    return;
                }

                await signInWithEmailAndPassword(auth, email, enteredPassword);
                const user = await waitForAuthReady();
                if (!user) throw new Error('Authentication failed after sign-in.');

                await user.getIdToken(true); // Force token refresh before Firestore writes

                if (inviteId && inviteData) {
                    await applyInvite(uid);
                }

                window.location.replace('/student/dashboard.html');
                return;
            }

            // Any other Auth error — re-throw to the outer catch
            throw authErr;
        }

        // ── New account created successfully ──────────────────
        const uid = userCred.user.uid;

        // Force token refresh so Firestore rules can evaluate getRole()
        // against the user document we're about to write.
        await userCred.user.getIdToken(true);

        const payload = currentRole === 'student'
            ? buildStudentPayload(uid, email)
            : buildSupervisorPayload(uid, email);

        await setDoc(doc(db, 'users', uid), payload);

        // Apply invite AFTER user doc is written so getRole() resolves correctly.
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
            'auth/invalid-email':    'The email address format is invalid.',
            'auth/weak-password':    'Password must be at least 8 characters.',
            'auth/network-request-failed': 'Network error. Check your connection.',
        };
        showBannerError(friendly[err.code] || err.message || 'Registration failed.');
        setLoading(false);
    }
});

// ─── PAYLOAD BUILDERS ────────────────────────────────────────

function buildStudentPayload(uid, email) {
    const firstName = sanitizeInput(document.getElementById('reg-firstname').value);
    const surname   = sanitizeInput(document.getElementById('reg-surname').value);
    const school    = sanitizeInput(document.getElementById('std-school')?.value);
    const course    = document.getElementById('std-course')?.value;
    const year      = document.getElementById('std-year')?.value;
    const section   = sanitizeInput(document.getElementById('std-section')?.value);
    const company   = sanitizeInput(document.getElementById('std-company')?.value);
    const requiredHours = Number(document.getElementById('std-total-hours')?.value || 0);
    const timeStart = document.getElementById('std-start')?.value || null;
    const timeEnd   = document.getElementById('std-end')?.value   || null;
    const fullSection = course && section ? `${course}-${section}` : section;

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
    const firstName    = sanitizeInput(document.getElementById('reg-firstname').value);
    const surname      = sanitizeInput(document.getElementById('reg-surname').value);
    const organization = sanitizeInput(document.getElementById('sup-org')?.value);
    const number       = sanitizeInput(document.getElementById('sup-contact')?.value);
    const checkedCourses = Array.from(
        document.querySelectorAll('input[name="sup-course"]:checked')
    ).map(cb => cb.value);
    const staffId = `EMP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    return {
        uid,
        role:             'supervisor',
        email,
        firstName,
        surname,
        name:             `${firstName} ${surname}`,
        organization,
        number,
        designation:      'OJT Coordinator',
        assignedCourses:  checkedCourses,
        staffId,
        createdAt:        serverTimestamp(),
        updatedAt:        serverTimestamp()
    };
}
