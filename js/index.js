import { auth, db } from "../firebase-config.js";
import { signInWithEmailAndPassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc, updateDoc} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { initTheme, setupThemeToggle, sanitizeText } from '/js/theme.js';

initTheme();
setupThemeToggle('theme-toggle-btn');

// Global state for role selection
let selectedRole = 'student'; 

// --- 1. UI NAVIGATION & MODAL LOGIC ---
window.showView = (viewName) => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`${viewName}-view`);
    if(target) target.classList.add('active');
};

window.setRole = (role) => {

    selectedRole = role; 
    document.querySelectorAll('.role-toggle').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`${role}-role`);
    if(activeBtn) activeBtn.classList.add('active');
    
    const indicator = document.getElementById('role-indicator');
    if(indicator) {

        const displayRole = (role.toLowerCase() === 'supervisor') 
            ? 'Adviser' 
            : role.charAt(0).toUpperCase() + role.slice(1);
            
        indicator.innerHTML = `Accessing as <strong>${displayRole}</strong>`;
    }
};

window.toggleModal = (show) => {
    const modal = document.getElementById('login-modal');
    if(modal) modal.style.display = show ? 'flex' : 'none';
};

document.addEventListener('DOMContentLoaded', () => {
    const loginTrigger = document.getElementById('login-trigger');
    if (loginTrigger) {
        loginTrigger.addEventListener('click', () => {
            toggleModal(true);
        });
    }
});

// --- 2. CONSOLIDATED FIREBASE LOGIN LOGIC ---
const authForm = document.getElementById('auth-form');

if (authForm) {
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const pass = document.getElementById('login-password').value;
        const submitBtn = authForm.querySelector('button[type="submit"]');

        try {
            submitBtn.disabled = true;
            submitBtn.textContent = "Verifying...";

            const userCredential = await signInWithEmailAndPassword(auth, email, pass);
            const user = userCredential.user;

            const userDocRef = doc(db, "users", user.uid);
            const userSnap = await getDoc(userDocRef);

            if (userSnap.exists()) {
                const userData = userSnap.data();
                
                if (selectedRole !== userData.role) {
                    await signOut(auth);
                    alert(`Access Denied: Your account is a ${userData.role}.`);
                    return;
                }

                // --- SESSION TRACKER LOGIC ---
                // Generate a unique ID for THIS specific browser login
                const newSessionId = Math.random().toString(36).substring(2, 15);
                
                // Save to Firestore (The "Master" ID)
                await updateDoc(userDocRef, { 
                    currentSessionId: newSessionId 
                });

                // Save to Browser (The "Local" ID)
                localStorage.setItem("ojt_session_id", newSessionId);

                // --- REDIRECTION ---
                window.location.href = userData.role === "student" 
                    ? "/student/dashboard.html" 
                    : "/supervisor/supervisordashboard.html";
            } else {
                await signOut(auth);
                alert("User profile not found.");
            }
        } catch (error) {
            console.error("Login Error:", error);
            alert("Login failed: Invalid credentials.");
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "SIGN IN TO DASHBOARD";
        }
    });
}

const passwordInput = document.getElementById('login-password');
const toggleBtn = document.getElementById('toggle-password');

toggleBtn.addEventListener('click', () => {
    // Toggle the type attribute
    const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
    passwordInput.setAttribute('type', type);
    
    // Toggle the emoji icon
    toggleBtn.textContent = type === 'password' ? '👁️' : '🙈';
});

// --- 2. Forgot Password Logic ---
const forgotPasswordLink = document.getElementById('forgot-password-link');

forgotPasswordLink.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;

    if (!email) {
        alert("Please enter your email address first to reset your password.");
        return;
    }

    try {
        await sendPasswordResetEmail(auth, email);
        alert("Password reset email sent! Please check your inbox (and spam folder).");
    } catch (error) {
        console.error("Error code:", error.code);
        // Direct handling for dummy/missing accounts
        if (error.code === 'auth/user-not-found') {
            alert("No account found with this email.");
        } else {
            alert("Error: " + error.message);
        }
    }
});

const feedbackForm = document.getElementById('feedbackForm');
const responseMessage = document.getElementById('responseMessage');
const submitBtn = document.getElementById('submitBtn');

feedbackForm.addEventListener('submit', function (event) {
    event.preventDefault();

    // Visual feedback for the user
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    const formData = new FormData(feedbackForm);

    // Replace 'YOUR_FORM_ID' with the actual ID from formspree.io 
    // This allows the browser to send the email directly to support@ojtrack.ph
    fetch("https://formspree.io/f/xwvrqyqj", {
        method: 'POST',
        body: formData,
        headers: {
            'Accept': 'application/json'
        }
    })
    .then(response => {
        if (response.ok) {
            responseMessage.textContent = 'Success! Your feedback has been sent to NOUS R&D.';
            responseMessage.style.color = '#28a745'; // Professional Green
            feedbackForm.reset();
        } else {
            return response.json().then(data => {
                if (Object.hasOwn(data, 'errors')) {
                    throw new Error(data["errors"].map(error => error["message"]).join(", "));
                } else {
                    throw new Error('Oops! There was a problem submitting your form');
                }
            })
        }
    })
    .catch(error => {
        console.error('Error:', error);
        responseMessage.textContent = 'Error: ' + error.message;
        responseMessage.style.color = '#dc3545'; // Error Red
    })
    .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Feedback';
    });
});

// --- 4. LEGAL MODAL LOGIC ---
const legalData = {
    privacy: {
        title: "Privacy Policy",
        content: `
            <p>Last Updated: April 2026</p>
            <h4 style="color: #CC9704; margin-top: 15px;">1. Information We Collect</h4>
            <p>Nous R&D collects personal information including your full name, school email address, student ID, and OJT-related data (clock-in/out times, tasks, and location data if enabled).</p>
            
            <h4 style="color: #CC9704; margin-top: 15px;">2. How We Use Data</h4>
            <p>Your data is used solely for tracking internship progress. Attendance logs and uploaded requirements are shared only with your designated OJT Adviser/Coordinator.</p>
            
            <h4 style="color: #CC9704; margin-top: 15px;">3. Data Security</h4>
            <p>We utilize Firebase's industry-standard encryption. While we strive to protect your data, no method of digital storage is 100% secure. By using OJTrack PH, you acknowledge this risk.</p>
            
            <h4 style="color: #CC9704; margin-top: 15px;">4. Third-Party Services</h4>
            <p>We do not sell your data. We use Formspree for feedback and Firebase for authentication and database management.</p>
        `
    },
    terms: {
        title: "Terms and Conditions",
        content: `
            <p>Last Updated: April 2026</p>
            <h4 style="color: #CC9704; margin-top: 15px;">1. User Conduct</h4>
            <p>Users must provide truthful and accurate logs. Falsifying OJT hours or documents is a violation of institutional integrity and may result in account termination.</p>
            
            <h4 style="color: #CC9704; margin-top: 15px;">2. Intellectual Property</h4>
            <p>OJTrack PH and its original content, features, and functionality are owned by Nous R&D and are protected by international copyright and trademark laws.</p>
            
            <h4 style="color: #CC9704; margin-top: 15px;">3. Limitation of Liability</h4>
            <p>Nous R&D is a tool provider. We are not responsible for disputes between the student, the school, and the host training establishment (HTE).</p>
            
            <h4 style="color: #CC9704; margin-top: 15px;">4. Modifications</h4>
            <p>We reserve the right to modify these terms at any time. Continued use of the platform signifies acceptance of updated terms.</p>
        `
    }
};

// Function to open the modal
const openLegalModal = (type) => {
    const modal = document.getElementById('legal-modal');
    const title = document.getElementById('legal-title');
    const content = document.getElementById('legal-content');

    if (modal && legalData[type]) {
        title.innerText = legalData[type].title;
        content.innerHTML = legalData[type].content;
        modal.style.display = 'flex'; // Using flex to center like the login modal
    }
};

// Function to close the modal
const closeLegalModal = () => {
    const modal = document.getElementById('legal-modal');
    if (modal) modal.style.display = 'none';
};

// Event Listeners for Legal Links
document.getElementById('privacy-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    openLegalModal('privacy');
});

document.getElementById('terms-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    openLegalModal('terms');
});

// Close buttons
document.getElementById('close-legal-btn')?.addEventListener('click', closeLegalModal);
document.getElementById('legal-understand-btn')?.addEventListener('click', closeLegalModal);

// Close on outside click
window.addEventListener('click', (e) => {
    const legalModal = document.getElementById('legal-modal');
    if (e.target === legalModal) closeLegalModal();
});