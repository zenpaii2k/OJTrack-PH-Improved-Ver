// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDjY-QLoaKeNcPdkR4UAwfHmQpTM_IWf5w",
  authDomain: "ojtrackph.firebaseapp.com",
  projectId: "ojtrackph",
  storageBucket: "ojtrackph.firebasestorage.app",
  messagingSenderId: "284735198459",
  appId: "1:284735198459:web:a312b4c8d89ba2e75e0c5e"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
