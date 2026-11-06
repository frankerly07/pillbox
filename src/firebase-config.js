// Paste your Firebase web app config here to turn on syncing between the patient and caregiver apps.
// Firebase console > Project settings > Your apps > Web app > SDK setup and configuration > Config.
// These values are not secret; access is protected by firestore.rules and sign-in.
// While this is null, PillAlly runs on this phone only. It does not create invite codes or sync access.
// Turning sync on also needs the Firestore rules and the Cloud Functions in functions/index.js.
// Those functions are not deployed. They need the Firebase Blaze plan (billing), which this repo does not enable.
export const firebaseConfig = null;
