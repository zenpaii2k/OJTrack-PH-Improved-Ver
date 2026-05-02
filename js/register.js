import { db, auth } from '../firebase-config.js';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
    doc, setDoc, getDoc, updateDoc, arrayUnion, serverTimestamp, query, collection, where, getDocs, arrayRemove
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { initTheme, sanitizeText } from '../js/theme.js';

// ─── INIT ────────────────────────────────────────────────────
initTheme();

async function waitForAuthReady() {
    if (auth.currentUser) return auth.currentUser;

    return new Promise((resolve) => {
        const unsub = onAuthStateChanged(auth, (user) => {
            unsub();
            resolve(user);
        });
    });
}

// ─── INVITE CONTEXT (for batch registration links) ───────────
const urlParams  = new URLSearchParams(window.location.search);
const inviteId   = urlParams.get('inviteId');
let inviteData = null;
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
    submitBtn.disabled = state;
    submitLbl.textContent = state ? 'Creating account…' : 'Create Account';
    submitSpin.style.display = state ? 'inline-block' : 'none';
}

function showError(msg) {
    errBanner.textContent = `⚠️ ${sanitizeText(msg)}`;
    errBanner.style.display = 'block';
}

async function checkExistingUser(email) {
    const q = query(collection(db, "users"), where("email", "==", email));
    const snap = await getDocs(q);

    if (!snap.empty) {
        return snap.docs[0]; // existing user
    }
    return null;
}

// ---- VALIDATE INVITE

async function validateInvite(id) {
    if (!id) return null;

    const ref = doc(db, "invitations", id);
    const snap = await getDoc(ref);

    if (!snap.exists()) throw new Error("Invalid invite.");

    const data = snap.data();

    if (data.status !== "pending" || data.usedBy) {
        throw new Error("Invite no longer valid.");
    }

    return { ref, invite: data };

}

async function removeStudentFromAllBatches(uid) {
    const q = query(collection(db, "batches"), where("studentUids", "array-contains", uid));
    const snap = await getDocs(q);

    const updates = [];

    snap.forEach(docSnap => {
        updates.push(
            updateDoc(doc(db, "batches", docSnap.id), {
                studentUids: arrayRemove(uid)
            })
        );
    });

    await Promise.all(updates);
}

const ensureAuth = async () => {
    return new Promise((resolve, reject) => {
        const unsub = onAuthStateChanged(auth, (user) => {
            unsub(); // run once

            if (user?.uid) {
                resolve(user);
            } else {
                reject(new Error("Auth not ready"));
            }
        });
    });
};

// ─── ROLE SWITCHING ──────────────────────────────────────────
function toggleRegRole (role) {
window.toggleRegRole = toggleRegRole;
    currentRole = role;

    document.getElementById('student-only-fields').style.display =
        role === 'student' ? 'block' : 'none';

    document.getElementById('supervisor-only-fields').style.display =
        role === 'supervisor' ? 'block' : 'none';

    document.getElementById('btn-student').classList.toggle('active', role === 'student');
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
document.addEventListener('DOMContentLoaded', async () => {
    if (inviteId) {
        currentRole = 'student';

        document.querySelector('.role-selector-main')?.style.setProperty('display', 'none');
        document.querySelector('.footer-link')?.style.setProperty('display', 'none');

        try {
            const result = await validateInvite(inviteId);
            inviteData = result.invite; 
        } catch (err) {
            alert(err.message);
            window.location.href = '/index.html';
            return;
        }
    }

    toggleRegRole(currentRole);
    setupLegalHandlers();
    setupPasswordStrength();
    setupPasswordToggle();
    setupFormValidation();

    if (inviteId && inviteData?.email) {
    const emailInput = document.getElementById('reg-email');

    emailInput.value = inviteData.email.toLowerCase();
    emailInput.disabled = true;
}

if (inviteId && inviteData?.email) {
    const existingSnap = await checkExistingUser(inviteData.email);

        if (existingSnap) {
            const existingData = existingSnap.data();

            let password;

    try {
        password = await showReRegModal(existingData);
    } catch {
        return;
    }

    try {
        await signInWithEmailAndPassword(auth, existingData.email, password);
    } catch (err) {
        showBannerError("Incorrect password.");
        return;
    }

    await handleReturningInviteUser(existingSnap.id, existingData);
        }
    }
});

async function handleReturningInviteUser(uid, userData) {
    setLoading(true);
    const batchId = inviteData?.batchId;

    try {
        // 2. Add to NEW batch
        if (batchId) {
            await updateDoc(doc(db, "batches", batchId), {
                studentUids: arrayUnion(uid)
            });
        }

        await updateDoc(doc(db, "users", uid), {
            batch: batchId ?? null,
            supervisorId: inviteData?.supervisorId ?? null,
            updatedAt: serverTimestamp(),
            // Ensure you aren't trying to update 'role' or 'uid' here
        });

        window.location.replace("/student/dashboard.html");

    } catch (err) {
        console.error("Invite Update Error:", err);
        showBannerError("Permission denied: Could not join batch.");
        setLoading(false);
    }
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
        if (val.length === 0) {
            fill.style.width = '0%';
        } else {
            const widths = ['25%', '50%', '75%', '100%'];
            fill.style.width = widths[score - 1] || '25%';

            if (score <= 1) fill.classList.add('weak');
            else if (score <= 2) fill.classList.add('medium');
            else fill.classList.add('strong');
        }

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

// ─── FORM SUBMIT ─────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideBannerError();

    if (!validateForm()) return;

    setLoading(true);

    try {
        const email = document.getElementById('reg-email').value.trim().toLowerCase();
        const password = document.getElementById('reg-password').value;

        const fname = sanitizeInput(document.getElementById('reg-firstname').value);
        const lname = sanitizeInput(document.getElementById('reg-surname').value);

        let authUser;

        // ─────────────────────────────
        // TRY CREATE ACCOUNT (ONLY FLOW)
        // ─────────────────────────────
        try {
            const cred = await createUserWithEmailAndPassword(auth, email, password);
            authUser = cred.user;

        } catch (err) {

            if (err.code === "auth/email-already-in-use") {

                const existingSnap = await checkExistingUser(email);

                if (!existingSnap) {
                    throw new Error("Account exists but no user record found.");
                }

                const existingData = existingSnap.data();

                const confirmed = await showReRegModal(existingData).catch(() => false);

                if (!confirmed) {
                    setLoading(false);
                    return; // ⛔ STOP instead of throwing
                }

                // ✅ INVITE FLOW (this is your main case)
                if (inviteId) {
                    showBannerError("Account already exists. Please log in to continue.");
                    return;
                }

                // ❌ Non-invite → send to login instead
                showBannerError("Account already exists. Please log in.");
                setLoading(false);
                return;
            }

            throw err;
        }

        const uid = authUser.uid;

        const payload =
            currentRole === "student"
                ? buildStudentPayload(uid, email)
                : buildSupervisorPayload(uid, email);

        // ─────────────────────────────
        // SAVE USER DATA
        // ─────────────────────────────
        await setDoc(doc(db, "users", uid), payload, { merge: true });

        if (inviteData?.batchId) {
            await updateDoc(doc(db, "batches", inviteData.batchId), {
                studentUids: arrayUnion(uid)
            });
        }

        // ─────────────────────────────
        // REDIRECT
        // ─────────────────────────────
        window.location.replace("/student/dashboard.html");

    } catch (err) {
        showBannerError(err.message);
        setLoading(false);
    }
});

function buildStudentPayload(uid, email) {
    const firstName = sanitizeInput(document.getElementById('reg-firstname').value);
    const surname   = sanitizeInput(document.getElementById('reg-surname').value);

    const school  = sanitizeInput(document.getElementById('std-school')?.value);
    const course  = document.getElementById('std-course')?.value;
    const year    = document.getElementById('std-year')?.value;
    const section = sanitizeInput(document.getElementById('std-section')?.value);
    const company = sanitizeInput(document.getElementById('std-company')?.value);
    const requiredHours = Number(document.getElementById('std-total-hours')?.value || 0);

    const timeStart = document.getElementById('std-start')?.value || null;
    const timeEnd   = document.getElementById('std-end')?.value || null;

    const fullSection = course && section ? `${course}-${section}` : section;

    return {
        uid,

        // ─── CORE USER ─────────────────────
        role: currentRole,
        email,
        firstName,
        surname,
        name: `${firstName} ${surname}`,

        // ─── ACADEMIC ──────────────────────
        school,
        course,
        yearLevel: year,
        section,
        fullSection,
        company,
        requiredHours,

        // ─── TRACKING ──────────────────────
        hoursCompleted: 0,
        currentSessionId: null,

        timeStart,
        timeEnd,

        // ─── INVITE / BATCH ────────────────
        batch: inviteData?.batchId ?? null,
        supervisorId: inviteData?.supervisorId ?? null,

        // ─── SYSTEM ────────────────────────
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };

}

function buildSupervisorPayload(uid, email) {
    const firstName = sanitizeInput(document.getElementById('reg-firstname').value);
    const surname   = sanitizeInput(document.getElementById('reg-surname').value);

    const organization = sanitizeInput(document.getElementById('sup-org')?.value);
    const number       = sanitizeInput(document.getElementById('sup-contact')?.value);

    // Get selected courses (checkboxes)
    const checkedCourses = Array.from(
        document.querySelectorAll('input[name="sup-course"]:checked')
    ).map(cb => cb.value);

    const designation = "OJT Coordinator"; 

    // Generate simple staff ID (you can improve this later)
    const staffId = `EMP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    return {
        uid,

        role: "supervisor",
        email,
        firstName,
        surname,
        name: `${firstName} ${surname}`,
        organization,
        number,
        designation,
        assignedCourses: checkedCourses,

        staffId,

        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };
}

function showReRegModal(userData) {
    const modal = document.getElementById("reRegModal");
    const info  = document.getElementById("reRegInfo");
    const pass  = document.getElementById("reRegPassword");

    document.body.classList.add("modal-open");

    info.innerHTML = `
        <div class="reReg-summary">
            <p><strong>Name:</strong> ${userData.name}</p>
            <p><strong>Email:</strong> ${userData.email}</p>
            <p><strong>Role:</strong> ${userData.role}</p>
            <p><strong>Batch:</strong> ${userData.batch || "None"}</p>
        </div>
    `;

    modal.classList.remove("hidden");
    pass.value = "";
    pass.focus();

    return new Promise((resolve, reject) => {
        const confirmBtn = document.getElementById("confirmReReg");
        const cancelBtn  = document.getElementById("cancelReReg");

        function cleanup() {
            modal.classList.add("hidden");
            document.body.classList.remove("modal-open");

            confirmBtn.onclick = null;
            cancelBtn.onclick = null;
        }

        confirmBtn.onclick = () => {
            const password = pass.value;

            if (!password) {
                pass.style.border = "1px solid red";
                pass.focus();
                return;
            }

            cleanup();
            resolve(password);
        };

        cancelBtn.onclick = () => {
            cleanup();
            reject(new Error("User cancelled re-registration"));
        };

        // ESC key support (nice UX upgrade)
        function escHandler(e) {
            if (e.key === "Escape") {
                cleanup();
                reject(new Error("User cancelled re-registration"));
                window.removeEventListener("keydown", escHandler);
            }
        }

        window.addEventListener("keydown", escHandler);
    });
}