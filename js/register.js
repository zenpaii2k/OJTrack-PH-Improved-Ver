/**
 * OJTrack PH — register.js (Improved)
 * ─────────────────────────────────────────────────────────────
 * Key improvements over original:
 *   1. Robust client-side validation with per-field error messages
 *   2. Password strength indicator
 *   3. Input sanitization before writing to Firestore
 *   4. Proper submit spinner / loading state
 *   5. Uses theme.js for consistency
 *   6. Invitation link context handled cleanly
 * ─────────────────────────────────────────────────────────────
 */

import { db, auth } from '../firebase-config.js';
import { createUserWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    doc, setDoc, getDoc, updateDoc, arrayUnion, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { initTheme, sanitizeText } from '../js/theme.js';

// ─── INIT ────────────────────────────────────────────────────
initTheme();

// ─── INVITE CONTEXT (for batch registration links) ───────────
const urlParams  = new URLSearchParams(window.location.search);
const inviteId   = urlParams.get('inviteId');
const batchId    = urlParams.get('batchId');

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

// ─── ROLE SWITCHING ──────────────────────────────────────────
window.toggleRegRole = function(role) {
    currentRole = role;
    document.getElementById('student-only-fields').style.display   = role === 'student'    ? 'block' : 'none';
    document.getElementById('supervisor-only-fields').style.display = role === 'supervisor' ? 'block' : 'none';
    document.getElementById('btn-student').classList.toggle('active',    role === 'student');
    document.getElementById('btn-supervisor').classList.toggle('active', role === 'supervisor');
    updateRequiredFields(role);
};

function updateRequiredFields(role) {
    const studentRequired    = ['std-school','std-course','std-year','std-section','std-company','std-total-hours'];
    const supervisorRequired = ['sup-org','sup-contact'];
    const all = [...studentRequired, ...supervisorRequired];

    all.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.required = (role === 'student' ? studentRequired : supervisorRequired).includes(id);
    });
}

// ─── INVITE CONTEXT ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    if (inviteId && batchId) {
        // If arriving via invite link, lock role to student
        currentRole = 'student';
        const roleToggle = document.querySelector('.role-selector-main');
        if (roleToggle) roleToggle.style.display = 'none';
    }

    toggleRegRole(currentRole);
    setupLegalHandlers();
    setupPasswordStrength();
    setupPasswordToggle();
    setupFormValidation();
});

// ─── LEGAL MODAL ─────────────────────────────────────────────
function setupLegalHandlers() {
    const closeBtn  = document.getElementById('close-legal-btn');
    const underBtn  = document.getElementById('legal-understand-btn');
    const privLink  = document.getElementById('privacy-link');
    const termsLink = document.getElementById('terms-link');

    function openLegal(type) {
        const data = LEGAL[type];
        legalTitle.textContent = data.title;
        legalCont.innerHTML  = data.content; // Legal content is authored by us, not user input
        legalModal.classList.add('show');
        legalModal.style.display = 'flex';
    }

    function closeLegal() {
        legalModal.classList.remove('show');
        legalModal.style.display = 'none';
    }

    if (privLink)  privLink.addEventListener('click',  () => openLegal('privacy'));
    if (termsLink) termsLink.addEventListener('click',  () => openLegal('terms'));
    if (closeBtn)  closeBtn.addEventListener('click',   closeLegal);
    if (underBtn)  underBtn.addEventListener('click',   closeLegal);

    // Close on backdrop click
    legalModal.addEventListener('click', (e) => {
        if (e.target === legalModal) closeLegal();
    });

    // Enable submit when terms accepted
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
        if (val.length >= 8)              score++;
        if (/[A-Z]/.test(val))            score++;
        if (/[0-9]/.test(val))            score++;
        if (/[^A-Za-z0-9]/.test(val))     score++;

        fill.className = 'pw-strength-fill';
        if (val.length === 0) { fill.style.width = '0'; return; }
        if (score <= 1) fill.classList.add('weak');
        else if (score <= 2) fill.classList.add('medium');
        else fill.classList.add('strong');
    });
}

function setupPasswordToggle() {
    const btn   = document.getElementById('toggle-pw');
    const input = document.getElementById('reg-password');
    if (!btn || !input) return;

    btn.addEventListener('click', () => {
        const isHidden = input.type === 'password';
        input.type  = isHidden ? 'text' : 'password';
        btn.textContent = isHidden ? '🙈' : '👁️';
    });

    // Prevent native Edge/IE reveal button
    input.addEventListener('mousedown', (e) => {
        if (e.offsetX > input.offsetWidth - 30) e.preventDefault();
    });
}

// ─── PER-FIELD VALIDATION HELPERS ─────────────────────────────
function showFieldError(errorId, message) {
    const el = document.getElementById(errorId);
    if (el) el.textContent = message;
}

function clearFieldError(errorId) {
    const el = document.getElementById(errorId);
    if (el) el.textContent = '';
}

function setupFormValidation() {
    // Real-time email validation
    const emailInput = document.getElementById('reg-email');
    emailInput?.addEventListener('blur', () => {
        const val = emailInput.value.trim();
        if (val && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
            showFieldError('email-error', 'Please enter a valid email address.');
        } else {
            clearFieldError('email-error');
        }
    });

    // Real-time name validation
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

// ─── MAIN VALIDATION BEFORE SUBMIT ────────────────────────────
function validateForm() {
    let valid = true;
    const errors = [];

    const email    = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const fname    = document.getElementById('reg-firstname').value.trim();
    const lname    = document.getElementById('reg-surname').value.trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showFieldError('email-error', 'Valid email is required.');
        valid = false;
    }

    if (!password || password.length < 8) {
        showFieldError('pw-error', 'Password must be at least 8 characters.');
        valid = false;
    }

    if (!fname || !/^[A-Za-zÀ-ÖØ-öø-ÿ\s\-\.\']+$/.test(fname)) {
        showFieldError('fn-error', 'First name is required (letters only).');
        valid = false;
    }

    if (!lname || !/^[A-Za-zÀ-ÖØ-öø-ÿ\s\-\.\']+$/.test(lname)) {
        showFieldError('ln-error', 'Last name is required (letters only).');
        valid = false;
    }

    if (currentRole === 'student') {
        const school = document.getElementById('std-school').value.trim();
        const course = document.getElementById('std-course').value;
        const section= document.getElementById('std-section').value.trim();
        const company= document.getElementById('std-company').value.trim();
        const hours  = parseInt(document.getElementById('std-total-hours').value, 10);

        if (!school) { showFieldError('school-error',  'School name is required.'); valid = false; }
        if (!course) { showFieldError('course-error',  'Please select a course.'); valid = false; }
        if (!section){ showFieldError('section-error', 'Section is required.'); valid = false; }
        if (!company){ showFieldError('company-error', 'Company name is required.'); valid = false; }
        if (!hours || hours < 100 || hours > 2000) {
            showFieldError('hours-error', 'Enter a valid number of hours (100–2000).'); valid = false;
        }
    }

    if (currentRole === 'supervisor') {
        const org     = document.getElementById('sup-org').value.trim();
        const contact = document.getElementById('sup-contact').value.trim();
        const checked = document.querySelectorAll('input[name="sup-course"]:checked');

        if (!org)     { showFieldError('org-error',     'School/institution is required.'); valid = false; }
        if (!contact) { showFieldError('contact-error', 'Contact number is required.'); valid = false; }
        if (checked.length === 0) { showFieldError('courses-error', 'Select at least one course.'); valid = false; }
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
    errBanner.textContent = '';
}

function setLoading(loading) {
    submitBtn.disabled     = loading;
    submitLbl.textContent  = loading ? 'Creating account…' : 'Create Account';
    submitSpin.style.display = loading ? 'inline-block' : 'none';
}

// ─── FORM SUBMIT ─────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideBannerError();

    if (!validateForm()) return;

    // Build the Firestore payload
    const email    = document.getElementById('reg-email').value.trim().toLowerCase();
    const password = document.getElementById('reg-password').value;

    // Sanitize text inputs
    const fname = sanitizeInput(document.getElementById('reg-firstname').value.trim());
    const lname = sanitizeInput(document.getElementById('reg-surname').value.trim());
    const fullName = `${fname} ${lname}`;

    let userData = {
        role:      currentRole,
        firstName: fname,
        lastName:  lname,
        name:      fullName,
        email:     email,
        createdAt: serverTimestamp(),
    };

    if (currentRole === 'student') {
        userData = {
            ...userData,
            school:       sanitizeInput(document.getElementById('std-school').value.trim()),
            course:       document.getElementById('std-course').value,
            yearLevel:    document.getElementById('std-year').value,
            section:      sanitizeInput(document.getElementById('std-section').value.trim()),
            company:      sanitizeInput(document.getElementById('std-company').value.trim()),
            requiredHours: parseInt(document.getElementById('std-total-hours').value, 10) || 600,
            completedHours: 0,
            shiftStart:   document.getElementById('std-start').value || null,
            shiftEnd:     document.getElementById('std-end').value   || null,
            adviserName:  sanitizeInput(document.getElementById('std-supervisor-name').value.trim()),
            batchId:      batchId || null,
        };
    } else {
        const assignedCourses = [...document.querySelectorAll('input[name="sup-course"]:checked')]
            .map(cb => cb.value);
        userData = {
            ...userData,
            orgName:         sanitizeInput(document.getElementById('sup-org').value.trim()),
            contactNumber:   sanitizeInput(document.getElementById('sup-contact').value.trim()),
            assignedCourses: assignedCourses,
        };
    }

    setLoading(true);

    try {
        // 1. Create Firebase Auth account
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        const uid  = cred.user.uid;
        userData.uid = uid;

        // 2. Write Firestore user document
        await setDoc(doc(db, 'users', uid), userData);

        // 3. If invited to a batch, update the batch document
        if (batchId && inviteId && currentRole === 'student') {
            const batchRef = doc(db, 'batches', batchId);
            await updateDoc(batchRef, {
                studentUids: arrayUnion(uid),
            });
        }

        // 4. Redirect to appropriate dashboard
        const dest = currentRole === 'student'
            ? '/student/dashboard.html'
            : '/supervisor/supervisordashboard.html';
        window.location.replace(dest);

    } catch (err) {
        setLoading(false);
        console.error('[Register] Error:', err.code);

        const friendlyErrors = {
            'auth/email-already-in-use': 'This email is already registered. Please sign in instead.',
            'auth/invalid-email':        'The email address format is invalid.',
            'auth/weak-password':        'Your password is too weak. Use at least 8 characters.',
            'auth/network-request-failed': 'Network error. Please check your connection.',
        };

        showBannerError(friendlyErrors[err.code] || `Registration failed: ${err.message}`);
    }
});

// ─── SECURITY: INPUT SANITIZATION ────────────────────────────
/**
 * Strips leading/trailing whitespace and limits length.
 * For text stored in Firestore, this prevents trivially large payloads.
 */
function sanitizeInput(str, maxLen = 200) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLen);
}
