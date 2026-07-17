import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBTjhIdiBiEH9C7ENppOcg025l6JbgGBA4",
  authDomain: "timememo-23a3c.firebaseapp.com",
  projectId: "timememo-23a3c",
  storageBucket: "timememo-23a3c.firebasestorage.app",
  messagingSenderId: "1088696799271",
  appId: "1:1088696799271:web:e97b1d9ebdef54e8dcbe02",
  measurementId: "G-PDDCJHTT1P"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
auth.languageCode = 'ko';

