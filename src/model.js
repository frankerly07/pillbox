// Pure dose logic shared by the patient and caregiver apps. No storage, no DOM.

export const pad = n => String(n).padStart(2, "0");
export const dayKey = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
export const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const COLORS = ["#17705E", "#3B5BDB", "#C2410C", "#9C36B5", "#0B7285", "#A61E4D"];

export function at(date, time) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}
export function parseDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function fmtTime(t) {
  const [h, m] = t.split(":").map(Number);
  return ((h % 12) || 12) + ":" + pad(m) + " " + (h < 12 ? "AM" : "PM");
}
export const fmtClock = iso => fmtTime(hm(new Date(iso)));
export function rel(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60), r = m % 60;
  return h + " h" + (r ? " " + r + " min" : "");
}
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const doseKey = (medId, day, time) => medId + "_" + day + "_" + time.replace(":", "");

// Is this medicine scheduled on that day? (start date and optional end date)
function activeOn(med, day) {
  if (med.start && day < med.start) return false;
  if (med.end && day > med.end) return false;
  return true;
}

/**
 * Scheduled doses for one date.
 * doses: { [key]: {status:'taken'|'skipped', at, source, by} }
 * status: taken | skipped | upcoming | due | missed
 */
export function dosesOn(date, meds, doses, { now = Date.now(), dueWindowMin = 60 } = {}) {
  const day = dayKey(date), win = dueWindowMin * 60000, out = [];
  for (const m of meds) {
    if (!activeOn(m, day)) continue;
    for (const t of m.times || []) {
      const key = doseKey(m.id, day, t), when = at(date, t).getTime(), log = doses[key];
      const status = log ? log.status : now < when - 15 * 60000 ? "upcoming" : now <= when + win ? "due" : "missed";
      out.push({ key, med: m, day, time: t, when, status, log });
    }
  }
  return out.sort((a, b) => a.when - b.when || a.med.name.localeCompare(b.med.name));
}

// Summary of one day for the calendar: 'all' | 'some' | 'none' | 'future' | 'empty'
export function daySummary(date, meds, doses, opts = {}) {
  const list = dosesOn(date, meds, doses, opts);
  if (!list.length) return { state: "empty", taken: 0, total: 0, list };
  const taken = list.filter(d => d.status === "taken").length;
  const closed = list.filter(d => d.status === "taken" || d.status === "skipped" || d.status === "missed").length;
  const today = dayKey(new Date(opts.now ?? Date.now())) === dayKey(date);
  let state;
  if (closed === 0 && (today || date > new Date(opts.now ?? Date.now()))) state = "future";
  else if (taken === list.length) state = "all";
  else if (taken > 0) state = "some";
  else if (closed === 0) state = "future";
  else state = "none";
  return { state, taken, total: list.length, list };
}

export function adherence(meds, doses, days = 14, now = Date.now()) {
  let taken = 0, total = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    for (const x of dosesOn(d, meds, doses, { now })) {
      if (x.status === "upcoming" || x.status === "due") continue;
      total++; if (x.status === "taken") taken++;
    }
  }
  return { taken, total, pct: total ? Math.round(taken / total * 100) : null };
}

// ---- pill supply ----
// Pills used per dose: the explicit number, else the number at the start of "2 capsules", else 1.
export function pillsPerDose(med) {
  if (Number(med.pillsPerDose) > 0) return Number(med.pillsPerDose);
  const n = parseFloat(String(med.perDose || ""));
  return n > 0 ? n : 1;
}
export const dailyUse = med => pillsPerDose(med) * (med.times || []).length;
/** left, daily use, days left, run-out date, and whether to warn (pill threshold or a week or less left). */
export function supply(med, now = Date.now()) {
  const left = typeof med.stock === "number" ? med.stock : null;
  const daily = dailyUse(med);
  const daysLeft = left != null && daily > 0 ? Math.floor(left / daily) : null;
  const runOut = daysLeft != null ? new Date(now + daysLeft * 86400000) : null;
  const warnDays = med.refillDays ?? 7;
  const low = left != null && (left <= (med.refillAt ?? 0) || (daysLeft != null && daysLeft <= warnDays));
  const out = left != null && left <= 0;
  return { left, daily, daysLeft, runOut, low, out, warnDays };
}
export const lowStock = meds => meds.filter(m => supply(m).low);
// Pills a dose record took out of the bottle: what it saved when taken (older records: the medicine's current amount), 0 if not taken.
export function pillsTaken(log, med) {
  if (!log || log.status !== "taken") return 0;
  return Number(log.pills) > 0 ? Number(log.pills) : pillsPerDose(med || {});
}

// ---- reminders ----
export const REMINDER_DAYS = 14;
/**
 * One-off alarms for the next `days` days, one per day and time, listing the active medicines whose dose isn't logged yet.
 * id = 1000 + day offset * 200 + index of the time of day, so ids stay in 1000–3999.
 */
export function reminderPlan(meds, doses, { now = Date.now(), days = REMINDER_DAYS } = {}) {
  const times = [...new Set(meds.flatMap(m => m.times || []))].sort(), out = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(now); date.setDate(date.getDate() + i);
    const slots = {};
    for (const d of dosesOn(date, meds, doses, { now })) {
      if (d.log || d.when <= now) continue;
      (slots[d.time] = slots[d.time] || { id: 1000 + i * 200 + times.indexOf(d.time), day: d.day, time: d.time, at: new Date(d.when), meds: [] }).meds.push(d.med);
    }
    out.push(...Object.values(slots));
  }
  return out.sort((a, b) => a.at - b.at);
}
// Doses a reminder's "Taken" button stands for: that day's (older alarms: today's) doses at that time, not yet taken.
export function dosesForReminder(extra, meds, doses, now = Date.now()) {
  if (!extra || !extra.time || !extra.medIds) return [];
  const date = extra.day ? parseDay(extra.day) : new Date(now);
  return dosesOn(date, meds, doses, { now }).filter(d => d.time === extra.time && extra.medIds.includes(d.med.id) && !(d.log && d.log.status === "taken"));
}

// Last 'taken' entry for a medicine (scheduled or extra)
export function lastTaken(medId, doses) {
  let best = null;
  for (const d of Object.values(doses)) if (d.medId === medId && d.status === "taken" && (!best || d.at > best.at)) best = d;
  return best;
}

// Which open dose should a pillbox lid-open count for? Nearest within 3 h, else null (extra dose).
export function doseForLidOpen(med, meds, doses, now = Date.now()) {
  return dosesOn(new Date(now), meds, doses, { now })
    .filter(d => d.med.id === med.id && !d.log && Math.abs(d.when - now) < 3 * 3600000)
    .sort((a, b) => Math.abs(a.when - now) - Math.abs(b.when - now))[0] || null;
}

// Overall status of a patient for the caregiver list
export function patientStatus(meds, doses, now = Date.now()) {
  const list = dosesOn(new Date(now), meds, doses, { now });
  const missed = list.filter(d => d.status === "missed");
  const due = list.filter(d => d.status === "due");
  const taken = list.filter(d => d.status === "taken").length;
  const level = missed.length ? "missed" : due.length ? "due" : "ok";
  return { level, missed, due, taken, total: list.length, low: lowStock(meds) };
}
