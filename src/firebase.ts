import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const env = import.meta.env;

const projectId = env.VITE_FIREBASE_PROJECT_ID as string | undefined;
const databaseURL =
  (env.VITE_FIREBASE_DATABASE_URL as string | undefined) ||
  (projectId ? `https://${projectId}-default-rtdb.firebaseio.com` : undefined);

if (!projectId) {
  throw new Error("Missing VITE_FIREBASE_PROJECT_ID");
}
if (!databaseURL) {
  throw new Error("Missing VITE_FIREBASE_DATABASE_URL");
}

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL,
  projectId,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app, databaseURL);
