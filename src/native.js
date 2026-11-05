// Android-only features, each with a browser fallback so the app also runs in Chrome for testing.
import { Capacitor } from "@capacitor/core";
import { fmtTime, dosesOn, reminderPlan, doseLabel } from "./model.js";

export const isNative = Capacitor.isNativePlatform();

// Which app is this? The two APKs differ only by application id.
export async function detectRole() {
  const q = new URLSearchParams(location.search).get("role");
  if (q) return q === "care" || q === "caregiver" ? "caregiver" : "patient";
  if (isNative) {
    try {
      const { App } = await import("@capacitor/app");
      // Never `return App` / `await App` from an async function: Capacitor plugin proxies trap
      // `.then`, so JS treats them as thenables and the await hangs forever on native.
      const info = await App.getInfo();
      return info.id.endsWith(".care") ? "caregiver" : "patient";
    } catch (e) {}
  }
  return "patient";
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
