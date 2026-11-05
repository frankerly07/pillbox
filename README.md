# Pillbox

One Android app for taking medicines, helping someone else, or both. The product name is Pillbox.

On first open you choose what you see: **I take medicines**, **I help someone else**, or **Both**. You can switch later. That choice only changes the screens on this phone. It does not open another person's medicines.

There is a separate optional question, "Did a healthcare professional recommend this app?" Answer Yes, No, or Skip. The answer is stored on the phone, does not change access, and is not a medical recommendation.

Today, each medicine that is due has its own button. One tap logs the saved amount at the current time, then confirms that amount and time with Undo. You can log an additional treatment, correct the amount, unit, or time on a log, or remove a log after a second tap. Removing a log puts the supply back and does not change the schedule. **Skip this scheduled dose** marks that one scheduled dose as not taken and leaves the schedule in place. An additional log does not move reminders. Interval schedules still count from the last scheduled dose actually logged, unless **Keep fixed schedule** is on. The app does not recommend a dose and does not change the dose saved on the medicine when you log what was given.

## Getting the APK

Every push to `main` builds the apps on GitHub Actions and publishes them. Download them from the **Latest build** release:

- **`Pillbox.apk`** (`com.pillbox.patient`) is the app to install. A new build installs over an older Pillbox and keeps that app's records.
- **`Pillbox-Care.apk`** (`com.pillbox.care`) is the older separate app. Keep installing updates of it if you already use it: the update does not delete its records. It tells you how to export a backup. New phones should use Pillbox.apk only.

On the phone, open the file and allow "Install unknown apps" for your browser or Files app when Android asks. Both builds are signed with the same key, which is never stored in the repository: it lives in the private GitHub Actions cache, or in `PILLBOX_KEYSTORE_B64` and `PILLBOX_KEYSTORE_PASSWORD` if you add those secrets.

## Moving off the separate Pillbox Care app

Android gives each application id its own storage. Pillbox cannot read Pillbox Care's data, and this project does not delete either one.

1. Open the Pillbox Care app that is already installed. Use **Export backup**. That downloads `pillbox-backup.json` with medicines, logs, events, and supply history. It does not include account passwords or invite codes.
2. Install or open **Pillbox** (`com.pillbox.patient`). Choose how you use it, then **More** or **Settings › Import backup** and pick the file.
3. Imported people are marked **on this phone only**. The file is not a live link to another phone.

If Pillbox Care has no records you need, you can leave it installed. Uninstalling it deletes only that app's data.

## On this phone, and real sync

Until `src/firebase-config.js` has a config, Pillbox is **on this phone only**. It does not create a code, show a QR, or pretend that another phone is connected. Example medicines, when you start empty, are labeled as examples.

Real linking needs all of the following. None of them are done by this repository:

1. A Firebase project (Analytics can be off) and the web config pasted into `src/firebase-config.js`. These values are not secret; `firestore.rules` decides access.
2. Email/password sign-in, and a Firestore database.
3. **Blaze (billing)** so Cloud Functions can run. Do not enable billing unless you mean to. This repo never enables it and has no service-account keys.
4. Publish `firestore.rules`.
5. Deploy `functions/index.js` only after you set `PILLBOX_FUNCTIONS_DEPLOY=1` on purpose. The file refuses to register otherwise. The Firebase CLI uploads the `functions` folder only, so a deploy must also bundle `src/` (the handlers import it). Tests cover the handlers with an in-memory database; they do not talk to Google.

What the functions do, once deployed:

- The patient picks **View only** or **Can log and edit** and gets a code. The QR and the typed code are the same 80-bit random value (`pillbox:invite:v1:` plus the code). The stored record is a hash. It expires in 30 minutes, works once, and has no medicines or health details.
- The other person sees the patient's name and the permission **before** it connects.
- The patient can remove someone. A used code cannot be reused. Eight wrong tries in 15 minutes pause further tries.
- A caregiver's app cannot write another person's doses directly. Logging for someone else goes through the dose function, which applies the inventory change once inside a transaction. Until that function is deployed, a signed-in caregiver can be set up to view only after a successful invite, and logging for them will say the function is not deployed.
- The signed-in owner can still log their own doses through a Firestore transaction using the same tested rules. A modified app signed in as the owner can still mis-count the owner's own supply; the function is what stops a linked person from bypassing it.

Publishing the rules without the functions turns linking off. That is deliberate. The old 6-digit code that any signed-in client could write is not accepted.

## Finding a medicine

You can still type a name. **Search drug list** asks the NIH RxNav service (RxNorm) for products that include a strength and a form. **Scan package** reads a barcode on this phone. The picture is not uploaded. Android uses ML Kit through Google Play Services, on the device. A browser that has a barcode detector can use the camera; otherwise you type the digits.

What is actually looked up:

- A name, sent only as that name. Your doses, history, and identity are not included.
- A 10-digit NDC printed with hyphens (4-4-2, 5-3-2, or 5-4-1), or the 11-digit form. A 10-digit code with no hyphens is tried as all three hyphenations, and only codes RxNav recognizes are shown.
- A GTIN built the GS1 way for a US NDC: a 12-digit code starting with 3, or a 14-digit code with `03` after the packaging digit, plus a valid check digit. The embedded 10 digits are still hyphenated three ways and checked. Lot, serial, and expiry numbers are ignored.
- A normal store UPC that does not use that pattern is **not** treated as a drug. UPC-E is not expanded. There is no local database of every product, and no assumption that every barcode is an NDC.

RxNav is free and needs no account. NLM asks for no more than 20 requests a second from one address; a burst can return “busy”. The service has to be reachable. openFDA is not called, so no FDA API key and no billing. Nothing here sets your dose, your schedule, or converts mg, mL, and units. You confirm the name, strength text, and brand or generic before it is saved, and you enter how much you take yourself. A saved pick keeps its RxNorm id and NDC when there was one.

OCR of a printed label is not included.

## Medicines, schedules and supply

Each medicine has a **type** (pill/tablet, injection, IV infusion, liquid or other), a **dose** (pills, mL, units (IU), mg or doses) and a **schedule**: every day, certain days of the week, every N days, every N weeks (both counted from the start date), once a month on a set day (day 31 falls on the last day of shorter months), or as needed. As-needed medicines get no alarms or missed-dose alerts; log them from the Today screen when they happen. Interval schedules (every N days, every N weeks, monthly) count from the last scheduled dose actually logged: a weekly dose logged late on Tuesday at 9:30 AM is next due the following Tuesday at 9:30 AM. Until the first dose is logged they use the start date and set times; turn on **Keep fixed schedule** to always use the set dates instead. Skipped doses and additional logs don't move the schedule, and days already past keep their times. Times of day and start/end dates apply to every schedule, and the Today list, calendar, adherence, alarms and caregiver alerts all follow it.

Supply is counted in pills for pills, and in vials, pens, bags, bottles, mL or doses for the rest, with an optional "doses per vial" (or pen/bag). Taking a dose subtracts what it uses (2 pills, 5 mL, a quarter of a pen…), and Undo puts it back. The medicine's page shows what's left, the run-out date (following the schedule) and days left. It warns when you're down to a set number of days (7 by default) or a set count. **Add refill** and **Correct count** keep a supply history that says who made each change, so a patient and their doctor or caregiver can both enter medicines and counts and see each other's changes.

Medicines saved by older versions open as daily pills with their old pills per dose (or as needed if they had no times); nothing is lost.

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
npm run dev            # http://localhost:5173 — ?role=care previews the old Pillbox Care package
npm run sync           # build the web app and copy it into the Android project
```

Building APKs locally needs the Android SDK: `cd android && ./gradlew assemblePatientDebug assembleCaregiverDebug`.

### Layout

- `src/model.js`: dose schedule logic (pure functions)
- `src/dose-log.js`: one log, edit, skip, or removal, and the inventory delta, including retries
- `src/access.js`: permissions and invite codes. A screen role is not an input
- `src/cloud-handlers.js`: invite and dose handlers tested against an in-memory database
- `src/migrate.js`: keep this install's records, and backup import/export
- `src/store.js`: `LocalStore` (this phone) and `CloudStore` (Firebase)
- `src/native.js`: Android alarms, caregiver alerts, Bluetooth, and which package is installed
- `src/main.js`: screens
- `functions/index.js`: undeployed Firebase wrapper
- `android/app/build.gradle`: `patient` (`com.pillbox.patient`) and `caregiver` (`com.pillbox.care`)
- `firestore.rules`: who can read and write what. Clients cannot write invites or the access map

## Known limits

- Linking and caregiver logging do not work until Firebase config, rules, and Cloud Functions are deployed on Blaze. The app says so. It does not create a local code that looks real.
- Caregiver missed-dose alerts are scheduled on the caregiver's phone from the latest data it has seen. If that phone has been offline, it can't know about a dose logged that morning. Server push alerts are not in this build.
- Two phones of the same owner can still race on that owner's own supply if a modified app writes around the transaction. The tested transaction covers the normal app. A linked person's writes are denied by the rules and only the function applies them.
- If a clinic uses this for real patients, patient data falls under health privacy rules (such as HIPAA in the US). That needs a signed agreement with the backend provider and a review before going live.
- GitHub drops Actions cache entries that go unused for 7 days. If the signing key is dropped, the next build gets a new key, and each phone must uninstall the old app once before installing the new one. Saving the key as repository secrets avoids this, and is required before publishing to the Play Store.
