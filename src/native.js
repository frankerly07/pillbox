// Android-only features, each with a browser fallback so the app also runs in Chrome for testing.
import { Capacitor } from "@capacitor/core";
import { fmtTime, dosesOn } from "./model.js";

export const isNative = Capacitor.isNativePlatform();

// Which app is this? The two APKs differ only by application id.
export async function detectRole() {
  const q = new URLSearchParams(location.search).get("role");
  if (q) return q === "care" || q === "caregiver" ? "caregiver" : "patient";
  if (isNative) {
    try { const { App } = await import("@capacitor/app"); const info = await App.getInfo(); return info.id.endsWith(".care") ? "caregiver" : "patient"; } catch (e) {}
  }
  return "patient";
}

// ---------------- Reminders (real Android alarms) ----------------
let LN = null;
async function ln() { if (!LN) LN = (await import("@capacitor/local-notifications")).LocalNotifications; return LN; }

export async function reminderPermission() {
  if (!isNative) return ("Notification" in window) ? Notification.permission : "unsupported";
  const L = await ln(); const p = await L.checkPermissions(); return p.display;
}
export async function askReminderPermission() {
  if (!isNative) { try { return await Notification.requestPermission(); } catch (e) { return "unsupported"; } }
  const L = await ln();
  const p = await L.requestPermissions();
  try { const ex = await L.checkExactNotificationSetting(); if (ex.exact_alarm !== "granted") await L.changeExactNotificationSetting(); } catch (e) {}
  return p.display;
}

const slotId = time => 1000 + Number(time.replace(":", "")); // one alarm per time of day

/** Patient app: one repeating daily alarm per time of day, listing every medicine due then. */
export async function scheduleReminders(meds, patientName) {
  if (!isNative) return;
  const L = await ln();
  const pending = await L.getPending();
  if (pending.notifications.length) await L.cancel({ notifications: pending.notifications.filter(n => n.id >= 1000 && n.id < 4000).map(n => ({ id: n.id })) });
  const byTime = {};
  for (const m of meds) for (const t of m.times || []) (byTime[t] = byTime[t] || []).push(m);
  const notifications = Object.entries(byTime).map(([t, list]) => {
    const [hour, minute] = t.split(":").map(Number);
    return {
      id: slotId(t),
      title: "Time for your " + fmtTime(t) + " medicine",
      body: list.map(m => m.name + " " + (m.strength || "") + " (" + (m.perDose || "1 dose") + ")").join(", "),
      schedule: { on: { hour, minute }, allowWhileIdle: true },
      actionTypeId: "DOSE",
      extra: { time: t, medIds: list.map(m => m.id) },
      channelId: "doses",
    };
  });
  if (notifications.length) await L.schedule({ notifications });
}

/** Caregiver app: a one-off alert for each of today's doses that isn't taken an hour after it was due. */
export async function scheduleCaregiverChecks(patients, dueWindowMin = 60) {
  if (!isNative) return;
  const L = await ln();
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
}

/** Alert right now (caregiver: missed dose seen live; patient: double dose). */
export async function alertNow(title, body) {
  if (isNative) { const L = await ln(); await L.schedule({ notifications: [{ id: 9000 + Math.floor(Math.random() * 900), title, body, channelId: "care" }] }); return; }
  try { if (Notification.permission === "granted") new Notification(title, { body }); } catch (e) {}
}

/** Register channels and the "Taken / Snooze" buttons on the alarm. onAction({action, extra}) */
export async function setupNotifications(onAction) {
  if (!isNative) return;
  const L = await ln();
  try {
    await L.createChannel({ id: "doses", name: "Dose reminders", importance: 5, vibration: true, visibility: 1 });
    await L.createChannel({ id: "care", name: "Caregiver alerts", importance: 4, vibration: true });
  } catch (e) {}
  await L.registerActionTypes({ types: [{ id: "DOSE", actions: [{ id: "take", title: "Taken" }, { id: "snooze", title: "Snooze 10 min" }] }] });
  L.addListener("localNotificationActionPerformed", ev => onAction({ action: ev.actionId, extra: ev.notification.extra || {}, title: ev.notification.title, body: ev.notification.body }));
}
export async function snooze(title, body, extra) {
  if (!isNative) return;
  const L = await ln();
  await L.schedule({ notifications: [{ id: 4000 + Math.floor(Math.random() * 900), title, body, schedule: { at: new Date(Date.now() + 10 * 60000), allowWhileIdle: true }, actionTypeId: "DOSE", extra, channelId: "doses" }] });
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
