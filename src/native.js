// Android-only features, each with a browser fallback so the app also runs in Chrome for testing.
import { Capacitor } from "@capacitor/core";
import { fmtTime, dosesOn, reminderPlan, doseLabel, scheduleLabel, recurrenceOf, calendarStarts, calendarTitle, medToIcs } from "./model.js";

export const isNative = Capacitor.isNativePlatform();

// Which installed package is this? com.pillbox.care is the older separate app.
// It does not choose access. The unified app (com.pillbox.patient) asks how the person will use PillAlly.
// `?role=care` still opens the legacy-package preview in a browser.
export async function detectApp() {
  const q = new URLSearchParams(location.search).get("role");
  let legacyCarePackage = q === "care" || q === "caregiver";
  if (isNative) {
    try {
      const { App } = await import("@capacitor/app");
      // Never `return App` / `await App` from an async function: Capacitor plugin proxies trap
      // `.then`, so JS treats them as thenables and the await hangs forever on native.
      const info = await App.getInfo();
      legacyCarePackage = String(info.id || "").endsWith(".care");
    } catch (e) {}
  }
  return { legacyCarePackage };
}

// ---------------- Reminders (real Android alarms) ----------------
// Capacitor's registerPlugin proxy intercepts EVERY property, including `then`. Returning that
// proxy from an `async` function makes `await ln()` hang forever (Promise Resolve treats it as a
// thenable and calls plugin method "then", which never resolves the outer await). Cache the
// plugin in a binding and never await / return the proxy itself from async functions.
let LN = null;
async function loadLN() {
  if (!LN) LN = (await import("@capacitor/local-notifications")).LocalNotifications;
}
function ln() {
  if (!LN) throw new Error("LocalNotifications not loaded");
  return LN;
}

export async function reminderPermission() {
  if (!isNative) return ("Notification" in window) ? Notification.permission : "unsupported";
  try {
    await loadLN();
    const p = await ln().checkPermissions();
    return p.display;
  } catch (e) {
    return "unsupported";
  }
}
export async function askReminderPermission() {
  if (!isNative) { try { return await Notification.requestPermission(); } catch (e) { return "unsupported"; } }
  try {
    await loadLN();
    const L = ln();
    const p = await L.requestPermissions();
    try { const ex = await L.checkExactNotificationSetting(); if (ex.exact_alarm !== "granted") await L.changeExactNotificationSetting(); } catch (e) {}
    return p.display;
  } catch (e) {
    return "unsupported";
  }
}

/**
 * Patient app: one-off alarms for the next two weeks (see reminderPlan), only on days a medicine's schedule
 * is due (start/end dates, weekdays, every N days/weeks, monthly; never for as-needed) and not for doses
 * already logged. Re-run on every data change; runs are queued so they don't interleave.
 */
let reminderRun = Promise.resolve();
export function scheduleReminders(meds, doses = {}) {
  if (!isNative) return Promise.resolve();
  return (reminderRun = reminderRun.catch(() => {}).then(() => replaceReminders(meds, doses)));
}
async function replaceReminders(meds, doses) {
  try {
    await loadLN();
    const L = ln();
    const pending = await L.getPending();
    const old = pending.notifications.filter(n => n.id >= 1000 && n.id < 4000).map(n => ({ id: n.id }));
    if (old.length) await L.cancel({ notifications: old });
    const notifications = reminderPlan(meds, doses).map(r => ({
      id: r.id,
      title: "Time for your " + fmtTime(r.time) + " medicine",
      body: r.meds.map(m => m.name + (m.strength ? " " + m.strength : "") + " (" + doseLabel(m) + ")").join(", "),
      schedule: { at: r.at, allowWhileIdle: true },
      actionTypeId: "DOSE",
      extra: { day: r.day, time: r.time, medIds: r.meds.map(m => m.id) },
      channelId: "doses",
    }));
    if (notifications.length) await L.schedule({ notifications });
  } catch (e) {}
}

/** Caregiver app: a one-off alert for each of today's doses that isn't taken an hour after it was due. */
export async function scheduleCaregiverChecks(patients, dueWindowMin = 60) {
  if (!isNative) return;
  try {
    await loadLN();
    const L = ln();
    const pending = await L.getPending();
    const old = pending.notifications.filter(n => n.id >= 5000).map(n => ({ id: n.id }));
    if (old.length) await L.cancel({ notifications: old });
    const now = Date.now(), notifications = [];
    let id = 5000;
    for (const p of patients) {
      for (const d of dosesOn(new Date(), p.meds, p.doses, { now, dueWindowMin })) {
        const fire = d.when + dueWindowMin * 60000;
        if (d.log || fire <= now) continue;
        notifications.push({ id: id++, title: p.name + " may have missed a dose", body: d.med.name + " at " + fmtTime(d.time) + " isn't marked taken yet.", schedule: { at: new Date(fire), allowWhileIdle: true }, channelId: "care", extra: { pid: p.id, key: d.key } });
      }
    }
    if (notifications.length) await L.schedule({ notifications });
  } catch (e) {}
}

/** Alert right now (caregiver: missed dose seen live; patient: double dose). */
export async function alertNow(title, body) {
  try {
    if (isNative) {
      await loadLN();
      await ln().schedule({ notifications: [{ id: 9000 + Math.floor(Math.random() * 900), title, body, channelId: "care" }] });
      return;
    }
    if (Notification.permission === "granted") new Notification(title, { body });
  } catch (e) {}
}

/** Register channels and the "Taken / Snooze" buttons on the alarm. onAction({action, extra}) */
export async function setupNotifications(onAction) {
  if (!isNative) return;
  try {
    await loadLN();
    const L = ln();
    try {
      await L.createChannel({ id: "doses", name: "Dose reminders", importance: 5, vibration: true, visibility: 1 });
      await L.createChannel({ id: "care", name: "Caregiver alerts", importance: 4, vibration: true });
    } catch (e) {}
    await L.registerActionTypes({ types: [{ id: "DOSE", actions: [{ id: "take", title: "Taken" }, { id: "snooze", title: "Snooze 10 min" }] }] });
    L.addListener("localNotificationActionPerformed", ev => {
      try { onAction({ action: ev.actionId, extra: ev.notification.extra || {}, title: ev.notification.title, body: ev.notification.body }); }
      catch (e) {}
    });
  } catch (e) {}
}
export async function snooze(title, body, extra) {
  if (!isNative) return;
  try {
    await loadLN();
    await ln().schedule({ notifications: [{ id: 4000 + Math.floor(Math.random() * 900), title, body, schedule: { at: new Date(Date.now() + 10 * 60000), allowWhileIdle: true }, actionTypeId: "DOSE", extra, channelId: "doses" }] });
  } catch (e) {}
}

// ---------------- "Add to my calendar" ----------------
// Android: repeating events in the phone's calendar (@ebarooni/capacitor-calendar). Anywhere that fails, or in the
// browser: an .ics file to share (Android share sheet) or download. Never throws; returns
// { ok, method: "device" | "ics", ids, message } where ids are the device event ids (to remove them later).
// Same proxy caution as LocalNotifications above: keep the plugin in a binding, never return or await it.
let CAL = null;
async function loadCal() { if (!CAL) CAL = (await import("@ebarooni/capacitor-calendar")).CapacitorCalendar; }

const DAY_TO_PLUGIN = [7, 1, 2, 3, 4, 5, 6]; // JS Sunday=0 → plugin Monday=1 … Sunday=7
export async function addMedToCalendar(med, doses = {}) {
  const starts = calendarStarts(med, doses), r = recurrenceOf(med, doses);
  if (!starts.length || !r) return { ok: false, method: "none", ids: [], message: "Nothing to add: this medicine has no upcoming scheduled doses." };
  if (isNative) {
    let denied = false;
    try {
      await loadCal();
      const perm = await CAL.requestFullCalendarAccess();
      if (perm.result !== "granted") denied = true;
      else {
        // The plugin has no "last day of shorter months" rule, so days 29–31 go through the .ics file instead.
        if (r.byMonthDay > 28) throw new Error("monthly day " + r.byMonthDay);
        const recurrence = { frequency: r.freq.toLowerCase(), interval: r.interval };
        if (r.byDay) recurrence.byWeekDay = r.byDay.map(d => DAY_TO_PLUGIN[d]);
        if (r.byMonthDay) recurrence.byMonthDay = [r.byMonthDay];
        if (med.end) { const [y, m, d] = med.end.split("-").map(Number); recurrence.end = new Date(y, m - 1, d, 23, 59, 59).getTime(); }
        const ids = [];
        for (const { start } of starts) {
          const res = await CAL.createEvent({
            title: calendarTitle(med),
            description: "Take " + doseLabel(med) + " (" + scheduleLabel(med) + ")." + (med.notes ? " " + med.notes : ""),
            startDate: start.getTime(), endDate: start.getTime() + 15 * 60000,
            recurrence, color: med.color || undefined,
          });
          if (res && res.id) ids.push(String(res.id));
        }
        return { ok: true, method: "device", ids, message: "Added to your calendar" };
      }
    } catch (e) {}
    const shared = await shareIcs(med, doses);
    if (denied) return { ...shared, message: shared.ok ? "No calendar permission, so we made a calendar file to share instead." : "Calendar access wasn't allowed. You can turn it on in Android settings." };
    return shared;
  }
  return shareIcs(med, doses);
}
export async function removeMedFromCalendar(ids = []) {
  if (!isNative || !ids.length) return;
  try { await loadCal(); await CAL.deleteEventsById({ ids }); } catch (e) {}
}
/** Share (Android) or download (browser) the medicine's .ics file. */
export async function shareIcs(med, doses = {}) {
  const ics = medToIcs(med, doses), name = (String(med.name || "medicine").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "medicine") + ".ics";
  if (!ics) return { ok: false, method: "none", ids: [], message: "Nothing to add: this medicine has no upcoming scheduled doses." };
  try {
    if (isNative) {
      const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
      const { Share } = await import("@capacitor/share");
      const f = await Filesystem.writeFile({ path: name, data: ics, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: med.name + " schedule", files: [f.uri], dialogTitle: "Add to calendar" });
    } else {
      const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
      const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    return { ok: true, method: "ics", ids: [], message: isNative ? "Calendar file ready to share" : "Calendar file downloaded. Open it to add the doses." };
  } catch (e) {
    const cancelled = /cancel/i.test(String(e && e.message || e));
    return { ok: false, method: "ics", ids: [], message: cancelled ? "Not added to a calendar." : "Couldn't make the calendar file." };
  }
}

// ---------------- Pillbox over Bluetooth ----------------
// ESP32 firmware advertises the Nordic UART service and notifies "OPEN:<compartment>" on TX.
export const BLE_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const BLE_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

export async function connectPillbox(onOpen, onStatus) {
  try {
    if (isNative) {
      const { BleClient } = await import("@capacitor-community/bluetooth-le");
      await BleClient.initialize({ androidNeverForLocation: true });
      const dev = await BleClient.requestDevice({ services: [BLE_SERVICE] });
      onStatus("Connecting to " + (dev.name || "pillbox") + "…");
      await BleClient.connect(dev.deviceId, () => onStatus("Disconnected"));
      await BleClient.startNotifications(dev.deviceId, BLE_SERVICE, BLE_TX, v => parse(new TextDecoder().decode(v)));
      onStatus("Connected to " + (dev.name || "pillbox"));
    } else if (navigator.bluetooth) {
      const dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE] }] });
      onStatus("Connecting to " + (dev.name || "pillbox") + "…");
      const gatt = await dev.gatt.connect();
      const ch = await (await gatt.getPrimaryService(BLE_SERVICE)).getCharacteristic(BLE_TX);
      await ch.startNotifications();
      ch.addEventListener("characteristicvaluechanged", e => parse(new TextDecoder().decode(e.target.value)));
      dev.addEventListener("gattserverdisconnected", () => onStatus("Disconnected"));
      onStatus("Connected to " + (dev.name || "pillbox"));
    } else onStatus("Bluetooth isn't available on this device.");
  } catch (e) { onStatus("Couldn't connect: " + (e.message || e)); }
  function parse(msg) { const m = /OPEN:(\d+)/i.exec(msg.trim()); if (m) onOpen(Number(m[1])); }
}

// Package barcode scan. On Android this is ML Kit on the phone (the picture is not uploaded).
// A browser with BarcodeDetector can scan too. Otherwise the person types the code.
// This is not the caregiver invitation scanner.
const PACKAGE_FORMATS = ["QrCode", "UpcA", "UpcE", "Ean13", "Ean8", "Code128", "Code39", "DataMatrix", "Itf", "Pdf417"];
export function packageScanSupport() {
  if (isNative) return "native";
  if (typeof BarcodeDetector !== "undefined" && navigator.mediaDevices?.getUserMedia) return "browser";
  return "manual";
}
export async function scanPackageBarcode() {
  if (!isNative) return { ok: false, code: packageScanSupport() === "browser" ? "browser" : "unavailable" };
  try {
    const { BarcodeScanner, BarcodeFormat } = await import("@capacitor-mlkit/barcode-scanning");
    const mod = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
    if (!mod.available) {
      await BarcodeScanner.installGoogleBarcodeScannerModule();
      return { ok: false, code: "module" };
    }
    const formats = PACKAGE_FORMATS.map(name => BarcodeFormat[name]).filter(Boolean);
    const { barcodes } = await BarcodeScanner.scan({ formats });
    const text = barcodes && barcodes[0] && (barcodes[0].rawValue || barcodes[0].displayValue);
    if (!text) return { ok: false, code: "cancelled" };
    return { ok: true, text: String(text) };
  } catch (e) {
    const msg = String(e && (e.message || e) || "");
    if (/cancel/i.test(msg)) return { ok: false, code: "cancelled" };
    if (/denied|permission/i.test(msg)) return { ok: false, code: "denied" };
    return { ok: false, code: "unavailable" };
  }
}
let cancelBrowserScan = null;
export function stopBrowserScan() { if (cancelBrowserScan) cancelBrowserScan(); }
export async function startBrowserScan(video) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
  catch (e) {
    const denied = e && (e.name === "NotAllowedError" || e.name === "PermissionDeniedError");
    return { ok: false, code: denied ? "denied" : "unavailable" };
  }
  video.srcObject = stream;
  try { await video.play(); } catch (e) {}
  let det;
  try { det = new BarcodeDetector({ formats: ["qr_code", "upc_a", "upc_e", "ean_13", "ean_8", "code_128", "code_39", "data_matrix", "itf", "pdf417"] }); }
  catch (e) { try { det = new BarcodeDetector(); } catch (err) { stream.getTracks().forEach(t => t.stop()); return { ok: false, code: "unavailable" }; } }
  return new Promise(resolve => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      cancelBrowserScan = null;
      stream.getTracks().forEach(t => t.stop());
      resolve(result);
    };
    cancelBrowserScan = () => finish({ ok: false, code: "cancelled" });
    const tick = async () => {
      if (done) return;
      try {
        const codes = await det.detect(video);
        const text = codes && codes[0] && codes[0].rawValue;
        if (text) { finish({ ok: true, text: String(text) }); return; }
      } catch (e) {}
      if (!done) requestAnimationFrame(tick);
    };
    tick();
  });
}
