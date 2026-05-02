import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

/**
 * @param {string} allowedRole - The role required for this page ('student' or 'adviser')
 */
export function protectPage(allowedRole) {
    return new Promise((resolve) => {
        // Prevent "Flash of Protected Content" (FOUC)
        document.body.style.display = 'none'; 

        onAuthStateChanged(auth, async (user) => {
            if (!user) {
                // Not logged in? Go to login page
                window.location.replace("/index.html");
                return;
            }

            try {
                const userDocRef = doc(db, "users", user.uid);
                const userSnap = await getDoc(userDocRef);
                
                if (userSnap.exists()) {
                    const userData = userSnap.data();
                    const userRole = userData.role; // Assuming roles are 'student' or 'adviser'
                    const localSessionId = localStorage.getItem("ojt_session_id");

                    // --- SESSION VALIDATION (Prevent Double Login) ---
                    if (userData.currentSessionId && userData.currentSessionId !== localSessionId) {
                        alert("Session Expired: Logged in on another device.");
                        await signOut(auth);
                        localStorage.removeItem("ojt_session_id");
                        window.location.replace("/index.html");
                        return;
                    }

                    // --- ROLE-BASED ACCESS CONTROL (The "URL Guard") ---
                    if (userRole === allowedRole) {
                        // Correct user for this page - Show the content
                        document.body.style.display = 'block';
                        resolve(user); 
                    } else {
                        // WRONG ROLE: Redirect them to THEIR assigned dashboard
                        console.warn("Access Denied: Redirecting to appropriate dashboard.");
                        
                        if (userRole === 'supervisor') {
                            window.location.replace("/supervisor/supervisordashboard.html");
                        } else if (userRole === 'student') {
                            window.location.replace("/student/dashboard.html");
                        } else {
                            // Fallback for unknown roles
                            window.location.replace("/index.html");
                        }
                    }
                } else {
                    // No Firestore profile found
                    await signOut(auth);
                    window.location.replace("/index.html");
                }
            } catch (error) {
                console.error("Security Guard Error:", error);
                window.location.replace("/index.html");
            }
        });
    });
}