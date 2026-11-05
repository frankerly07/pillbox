# Pillbox

Two Android apps from one codebase:

- **Pillbox** (patient): add medicines, tap once to mark a dose taken, see a calendar of every day, get real alarms with a "Taken" button right on the notification, and connect a Bluetooth pillbox.
- **Pillbox Care** (caregiver, family member or doctor): link to one or more patients with a 6-digit code, see each patient's day and calendar at a glance, get an alert when a dose is missed or pills are running low, mark a dose as given, and add or change a patient's medicines.

## Getting the APKs

Every push to `main` builds both apps on GitHub Actions. Download them from the **Latest build** release on the repository's Releases page:

- `Pillbox.apk` goes on the patient's phone.
- `Pillbox-Care.apk` goes on the caregiver's phone.

On the phone, open the file and allow "Install unknown apps" for your browser or Files app when Android asks. Both apps are signed with the same key on every build, so a new build installs over the old one and keeps your data. The key is never stored in the repository: it lives in the repository's private GitHub Actions cache, or in `PILLBOX_KEYSTORE_B64` and `PILLBOX_KEYSTORE_PASSWORD` secrets if you add them.

## Turning on sync (Firebase)

Until `src/firebase-config.js` has a config, both apps run in on-this-phone mode: the patient app works fully on its own, and the caregiver app shows example patients.

1. Go to https://console.firebase.google.com and create a project (Google Analytics can be off).
2. **Build > Authentication > Get started**, then enable **Email/Password**.
3. **Build > Firestore Database > Create database**. Pick production mode and a location near you.
4. In Firestore, open the **Rules** tab, paste the contents of `firestore.rules`, and press **Publish**.
5. **Project settings > Your apps > Web (`</>`)**. Register an app named Pillbox and copy the `firebaseConfig` values into `src/firebase-config.js`.

Then push. The next build will ask each person to create an account on first open.

## Medicines, schedules and supply

Each medicine has a **type** (pill/tablet, injection, IV infusion, liquid or other), a **dose** (pills, mL, units (IU), mg or doses) and a **schedule**: every day, certain days of the week, every N days, every N weeks (both counted from the start date), once a month on a set day (day 31 falls on the last day of shorter months), or as needed. As-needed medicines get no alarms or missed-dose alerts; log them from the Today screen whenever they're taken. Interval schedules (every N days, every N weeks, monthly) count from the last dose actually taken: a weekly dose taken late on Tuesday at 9:30 AM is next due the following Tuesday at 9:30 AM. Until the first dose is logged they use the start date and set times; turn on **Keep fixed schedule** to always use the set dates instead. Skipped and extra doses don't move the schedule, and days already past keep their times. Times of day and start/end dates apply to every schedule, and the Today list, calendar, adherence, alarms and caregiver alerts all follow it.

Supply is counted in pills for pills, and in vials, pens, bags, bottles, mL or doses for the rest, with an optional "doses per vial" (or pen/bag). Taking a dose subtracts what it uses (2 pills, 5 mL, a quarter of a pen…), and Undo puts it back. The medicine's page shows what's left, the run-out date (following the schedule) and days left. It warns when you're down to a set number of days (7 by default) or a set count. **Add refill** and **Correct count** keep a supply history that says who made each change, so a patient and their doctor or caregiver can both enter medicines and counts and see each other's changes.

Medicines saved by older versions open as daily pills with their old pills per dose (or as needed if they had no times); nothing is lost.

## Linking a caregiver

1. Patient: **More > Care team > Get a link code**. The code works for 24 hours.
2. Caregiver: **Add patient**, type the code, press **Link patient**.

The patient can remove a caregiver from the same screen.

## The pillbox device (later)

The app talks to an ESP32 over Bluetooth Low Energy using the Nordic UART service:

| | UUID |
|---|---|
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| TX (notify, device to phone) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

When compartment N's lid opens, the device sends the text `OPEN:N`. In the app, each medicine can be assigned a compartment (1 to 8). On `OPEN:N` the app marks the nearest open dose of that medicine (within 3 hours) as taken. If it was already taken, the app warns that it was already taken instead. Until the hardware exists, **More > Pillbox** has buttons that simulate a lid opening.

## Developing

```
npm install
npm run dev            # open http://localhost:5173 (patient) or ?role=care (caregiver)
npm run sync           # build the web app and copy it into the Android project
```

Building APKs locally needs the Android SDK: `cd android && ./gradlew assemblePatientDebug assembleCaregiverDebug`.

### Layout

- `src/model.js`: dose schedule logic (pure functions)
- `src/store.js`: data layer, `LocalStore` (one phone) and `CloudStore` (Firebase), with the same interface
- `src/native.js`: Android alarms, caregiver alerts, Bluetooth, and app detection
- `src/main.js`: screens for both apps
- `android/app/build.gradle`: the `patient` and `caregiver` product flavors
- `firestore.rules`: who can read and write what

## Known limits

- Caregiver missed-dose alerts are scheduled on the caregiver's phone from the latest data it has seen. If the caregiver's phone has been offline all day, it can't know about a dose taken that morning. Server push alerts (Firebase Cloud Functions plus Cloud Messaging) would fix this and are the next step.
- If a clinic uses this for real patients, patient data falls under health privacy rules (such as HIPAA in the US). That needs a signed agreement with the backend provider and a review before going live.
- GitHub drops Actions cache entries that go unused for 7 days. If the signing key is dropped, the next build gets a new key, and each phone must uninstall the old app once before installing the new one. Saving the key as repository secrets avoids this, and is required before publishing to the Play Store.
