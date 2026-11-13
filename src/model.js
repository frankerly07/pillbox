// Pure dose logic shared by the patient and caregiver apps. No storage, no DOM.

export const pad = n => String(n).padStart(2, "0");
export const dayKey = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
export const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const COLORS = ["#2965D2", "#3B5BDB", "#C2410C", "#9C36B5", "#0B7285", "#A61E4D"];

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

// ---- medication types, dose units, supply units ----
export const TYPES = {
  pill: { label: "Pill / tablet", short: "Pill", icon: "💊", doseUnits: ["pills"], supplyUnits: ["pills"] },
  injection: { label: "Injection", short: "Injection", icon: "💉", doseUnits: ["units", "mL", "mg", "doses"], supplyUnits: ["pens", "vials", "doses"] },
  infusion: { label: "IV infusion", short: "IV infusion", icon: "💧", doseUnits: ["mL", "mg", "units", "doses"], supplyUnits: ["bags", "vials", "doses"] },
  liquid: { label: "Liquid", short: "Liquid", icon: "🥄", doseUnits: ["mL", "mg", "doses"], supplyUnits: ["mL", "bottles", "doses"] },
  other: { label: "Other", short: "Other", icon: "✚", doseUnits: ["doses", "units", "mL", "mg", "pills"], supplyUnits: ["doses", "vials", "pens", "bags", "bottles", "pills"] },
};
const UNIT_NAMES = { pills: ["pill", "pills"], mL: ["mL", "mL"], units: ["unit", "units"], mg: ["mg", "mg"], doses: ["dose", "doses"], vials: ["vial", "vials"], pens: ["pen", "pens"], bags: ["bag", "bags"], bottles: ["bottle", "bottles"] };
export const CONTAINERS = ["vials", "pens", "bags", "bottles"];
export const unitName = (unit, n = 2) => (UNIT_NAMES[unit] || [unit, unit])[Math.abs(n) === 1 ? 0 : 1];
export const fmtNum = n => String(Math.round(n * 100) / 100);
export const qty = (n, unit) => fmtNum(n) + " " + unitName(unit, Math.round(n * 100) / 100);

// Pills per dose for old medicines: the explicit number, else the number at the start of "2 capsules", else 1.
function legacyPills(med) {
  if (Number(med.pillsPerDose) > 0) return Number(med.pillsPerDose);
  const n = parseFloat(String(med.perDose || ""));
  return n > 0 ? n : 1;
}
const SCHEDULES = ["daily", "weekdays", "everyNDays", "everyNWeeks", "monthly", "prn"];
function scheduleOf(med) {
  const s = med.schedule;
  if (s && SCHEDULES.includes(s.kind)) return s;
  return { kind: (med.times || []).length ? "daily" : "prn" }; // older medicines: times every day, none = as needed
}
/**
 * Fill in type, dose and schedule for medicines saved before those existed: a pill, its old pills-per-dose,
 * counted in pills, every day at its times (no times = as needed). Keeps every other field. Idempotent.
 */
export function normalizeMed(med) {
  const m = { ...med };
  if (!TYPES[m.type]) m.type = "pill";
  const t = TYPES[m.type];
  if (!(Number(m.doseAmount) > 0)) m.doseAmount = m.type === "pill" ? legacyPills(med) : 1;
  else m.doseAmount = Number(m.doseAmount);
  if (!UNIT_NAMES[m.doseUnit] || m.type === "pill") m.doseUnit = t.doseUnits[0];
  if (!UNIT_NAMES[m.supplyUnit] || m.type === "pill") m.supplyUnit = t.supplyUnits[0];
  m.perContainer = Number(m.perContainer) > 0 ? Number(m.perContainer) : null;
  m.times = Array.isArray(m.times) ? m.times : [];
  m.schedule = { ...scheduleOf(med) };
  if (m.schedule.kind === "prn") m.times = [];
  return m;
}
export const isPrn = med => scheduleOf(med).kind === "prn" || !(med.times || []).length;

// Days between two local dates, ignoring daylight-saving shifts.
const dayNum = d => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
/**
 * Is this medicine scheduled on that date? Respects start/end dates. As-needed (prn) is never "due".
 * Every N days / weeks counts from the start date; monthly day 31 falls on the last day of shorter months.
 * Without `doses` this is the fixed schedule; with them, interval schedules count from the last dose taken (scheduledOn).
 */
export function isDueOn(med, date, doses) {
  if (doses) return scheduledOn(med, date, doses).length > 0;
  const day = dayKey(date);
  if (med.start && day < med.start) return false;
  if (med.end && day > med.end) return false;
  const s = scheduleOf(med);
  const anchor = med.start ? parseDay(med.start) : new Date(1970, 0, 1);
  const n = Math.max(1, Math.floor(Number(s.n) || 1));
  const diff = dayNum(date) - dayNum(anchor);
  switch (s.kind) {
    case "prn": return false;
    case "weekdays": return (s.days || []).map(Number).includes(date.getDay());
    case "everyNDays": return diff >= 0 && diff % n === 0;
    case "everyNWeeks": return diff >= 0 && diff % (7 * n) === 0;
    case "monthly": {
      const want = Math.floor(Number(s.dayOfMonth)) || anchor.getDate();
      const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      return date.getDate() === Math.min(Math.max(want, 1), last);
    }
    default: return true;
  }
}

// ---- interval schedules count from the last dose taken ----
// Every N days / every N weeks / monthly: once a dose is logged as taken, the next one is due that interval after
// when it was actually taken (to the minute), not on the fixed date. schedule.fixed ("Keep fixed schedule") turns this off.
const INTERVAL_KINDS = ["everyNDays", "everyNWeeks", "monthly"];
export const anchorsToLastDose = med => { const s = scheduleOf(med); return INTERVAL_KINDS.includes(s.kind) && !s.fixed; };
const minutesOf = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
/** `d` plus k intervals of the schedule, same local time of day. Monthly keeps the day of month (31 → last day). */
export function addInterval(d, schedule, k = 1) {
  const n = Math.max(1, Math.floor(Number(schedule.n) || 1)), out = new Date(d);
  if (schedule.kind === "monthly") {
    const dom = d.getDate();
    out.setDate(1); out.setMonth(out.getMonth() + k);
    out.setDate(Math.min(dom, new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate()));
  } else out.setDate(out.getDate() + k * n * (schedule.kind === "everyNWeeks" ? 7 : 1));
  return out;
}
/**
 * The taken (non-extra) doses an interval medicine counts from, oldest first: { at (rounded to the minute), slot (the
 * set time of day it stands for), cutoff (the last day still on the old timing: the dose's day or the day it was taken) }.
 * Empty for other schedules or with "Keep fixed schedule".
 */
export function doseAnchors(med, doses) {
  const times = med.times || [];
  if (!doses || !times.length || !anchorsToLastDose(med)) return [];
  const out = [];
  for (const d of Object.values(doses)) {
    if (!d || d.medId !== med.id || d.status !== "taken" || d.extra || !d.at || !d.day) continue;
    const ms = new Date(d.at).getTime(); if (isNaN(ms)) continue;
    const at = new Date(Math.round(ms / 60000) * 60000), takenDay = dayKey(at);
    const slot = times.includes(d.slot) ? d.slot : times.includes(d.time) ? d.time : times[0];
    out.push({ at, slot, cutoff: takenDay > d.day ? takenDay : d.day });
  }
  return out.sort((a, b) => a.at - b.at);
}
/**
 * The doses of one medicine on one date: [{ time ("HH:MM" it's due), slot (its set time of day), when (ms) }].
 * Fixed dates and set times until a dose is taken; after that, for interval schedules, the last dose taken + k intervals,
 * with any other times of day keeping their distance from the one taken. Days up to a dose's cutoff keep the timing
 * they had, so history doesn't move. `doses` may be the dose log or anchors from doseAnchors.
 */
export function scheduledOn(med, date, doses) {
  const day = dayKey(date), times = med.times || [];
  if (med.start && day < med.start) return [];
  if (med.end && day > med.end) return [];
  const anc = Array.isArray(doses) ? doses : doseAnchors(med, doses);
  let a = null;
  for (const x of anc) if (x.cutoff < day) a = x; // the latest dose taken before this day
  if (!a) return isDueOn(med, date) ? times.map(t => ({ time: t, slot: t, when: at(date, t).getTime() })) : [];
  const s = scheduleOf(med), base = minutesOf(a.slot), out = [];
  const k0 = s.kind === "monthly"
    ? (date.getFullYear() - a.at.getFullYear()) * 12 + date.getMonth() - a.at.getMonth()
    : Math.round((dayNum(date) - dayNum(a.at)) / (Math.max(1, Math.floor(Number(s.n) || 1)) * (s.kind === "everyNWeeks" ? 7 : 1)));
  for (let k = Math.max(1, k0 - 1); k <= k0 + 1; k++) {
    const b = addInterval(a.at, s, k);
    for (const t of times) {
      const w = new Date(b); w.setMinutes(w.getMinutes() + minutesOf(t) - base);
      if (dayKey(w) === day && !out.some(o => o.when === w.getTime())) out.push({ time: hm(w), slot: t, when: w.getTime() });
    }
  }
  return out.sort((x, y) => x.when - y.when);
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ordinal = n => n + ((n % 100 >= 11 && n % 100 <= 13) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
export function scheduleLabel(med) {
  const s = scheduleOf(med), n = Math.max(1, Math.floor(Number(s.n) || 1));
  switch (s.kind) {
    case "prn": return "as needed";
    case "weekdays": {
      const d = [...new Set((s.days || []).map(Number))].sort();
      if (d.length === 7) return "daily";
      if (d.join() === "1,2,3,4,5") return "weekdays";
      return d.map(x => WD[x]).join(", ") || "no days chosen";
    }
    case "everyNDays": return n === 1 ? "daily" : "every " + n + " days";
    case "everyNWeeks": return n === 1 ? "weekly" : "every " + n + " weeks";
    case "monthly": return "monthly on the " + ordinal(Math.floor(Number(s.dayOfMonth)) || (med.start ? parseDay(med.start).getDate() : 1));
    default: return "daily";
  }
}
// "40 units", "2 pills"; old pill medicines keep their own wording ("1 softgel") while it still matches.
export function doseLabel(med) {
  const m = normalizeMed(med);
  if (m.type === "pill" && m.perDose && parseFloat(m.perDose) === m.doseAmount) return m.perDose;
  return qty(m.doseAmount, m.doseUnit);
}
export const typeIcon = med => TYPES[normalizeMed(med).type].icon;
// "Injection · 40 units · every 2 weeks"
export const medSummary = med => [TYPES[normalizeMed(med).type].short, doseLabel(med), scheduleLabel(med)].join(" · ");

/**
 * Scheduled doses for one date.
 * doses: { [key]: {status:'taken'|'skipped', at, source, by} }
 * status: taken | skipped | upcoming | due | missed
 */
export function dosesOn(date, meds, doses, { now = Date.now(), dueWindowMin = 60 } = {}) {
  const day = dayKey(date), win = dueWindowMin * 60000, out = [];
  for (const m of meds) {
    const sched = scheduledOn(m, date, doses), used = new Set();
    // A dose logged at a time that has since moved (an earlier log's time was corrected) still counts for its slot.
    const byKey = sched.map(x => doses[doseKey(m.id, day, x.time)] ? doseKey(m.id, day, x.time) : null);
    byKey.forEach(k => k && used.add(k));
    sched.forEach((x, i) => {
      if (byKey[i]) return;
      const hit = Object.keys(doses).find(k => { const l = doses[k]; return !used.has(k) && l && l.medId === m.id && l.day === day && !l.extra && l.time && (l.slot || l.time) === x.slot; });
      if (hit) { used.add(hit); byKey[i] = hit; x.time = doses[hit].time; x.when = at(date, x.time).getTime(); }
    });
    for (const [i, { time, slot, when }] of sched.entries()) {
      const key = byKey[i] || doseKey(m.id, day, time), log = doses[key];
      const status = log ? log.status : now < when - 15 * 60000 ? "upcoming" : now <= when + win ? "due" : "missed";
      out.push({ key, med: m, day, time, slot, when, status, log });
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

// ---- supply ----
/**
 * How much of the supply one dose uses, in the supply unit: the dose amount when both are the same unit
 * (2 pills, 5 mL), a share of a container when "doses per vial" is set, else one container / one dose.
 */
export function supplyPerDose(med) {
  const m = normalizeMed(med);
  if (m.supplyUnit === m.doseUnit) return m.doseAmount;
  if (CONTAINERS.includes(m.supplyUnit)) return (m.doseUnit === "doses" ? m.doseAmount : 1) / (m.perContainer || 1);
  return 1;
}
/**
 * left, use per dose, days left, run-out date (the first scheduled dose the supply can't cover), and whether
 * to warn (at or below the count threshold, or that many days or fewer left). As-needed medicines have no run-out date.
 */
export function supply(med, now = Date.now(), doses) {
  const m = normalizeMed(med);
  const left = typeof m.stock === "number" ? m.stock : null;
  const perDose = supplyPerDose(m);
  let daysLeft = null, runOut = null;
  if (left != null && !isPrn(m) && perDose > 0) {
    const anc = doseAnchors(m, doses);
    let need = 0;
    for (let i = 0; i < 732 && runOut == null; i++) {
      const date = new Date(now); date.setDate(date.getDate() + i); date.setHours(12, 0, 0, 0);
      if (m.end && dayKey(date) > m.end) break;
      for (const { when } of scheduledOn(m, date, anc)) {
        if (i === 0 && when <= now) continue;
        need += perDose;
        if (need > left + 1e-9) { runOut = date; daysLeft = i; break; }
      }
    }
  }
  const warnDays = m.refillDays ?? 7;
  const out = left != null && left <= 1e-9;
  const low = left != null && (out || left <= (m.refillAt ?? 0) + 1e-9 || (daysLeft != null && daysLeft <= warnDays));
  return { left, perDose, unit: m.supplyUnit, daysLeft, runOut, low, out, warnDays };
}
export const lowStock = (meds, doses, now = Date.now()) => meds.filter(m => supply(m, now, doses).low);
// Supply a dose record used: what it saved when taken (older records: the medicine's current amount), 0 if not taken.
export function supplyTaken(log, med) {
  if (!log || log.status !== "taken") return 0;
  if (Number(log.used) > 0) return Number(log.used);
  return Number(log.pills) > 0 ? Number(log.pills) : supplyPerDose(med || {});
}

// ---- logged times (when a dose was actually taken or skipped, vs. when it was scheduled) ----
/** "Taken 8:14 AM" / "Skipped 8:05 AM"; adds the weekday when it was logged on another day than `day`. */
export function fmtLogged(log, day) {
  if (!log || !log.at) return "";
  const d = new Date(log.at);
  return (log.status === "skipped" ? "Skipped " : "Taken ") + (day && dayKey(d) !== day ? WD[d.getDay()] + " " : "") + fmtTime(hm(d));
}
/** What was actually logged, if the record saved a snapshot; otherwise the medicine's current dose. */
export function administrationLabel(log, med) {
  if (log && Number(log.amount) > 0 && log.unit) return qty(Number(log.amount), log.unit);
  return doseLabel(med);
}
/** "Scheduled 8:00 AM · Taken 8:14 AM", or "Additional treatment · Taken …" for an unscheduled log. */
export const fmtDoseTimes = d => (d.log && d.log.extra ? "Additional treatment" : "Scheduled " + fmtTime(d.time)) + (d.log && d.log.at ? " · " + fmtLogged(d.log, d.day) : "");
/** Where the "Taken earlier?" picker starts: now for today's doses, the scheduled time for other days. */
export const defaultLogTime = (day, scheduled, now = Date.now()) => day === dayKey(new Date(now)) ? hm(new Date(now)) : scheduled;
/**
 * The moment a dose scheduled on `day` at `scheduled` was taken, from a picked "HH:MM". Normally that day; a time
 * more than 12 h before the scheduled one means just after midnight (11 PM dose taken 12:30 AM) if that has passed.
 * null when it would be in the future.
 */
export function logTimeFor(day, scheduled, picked, now = Date.now()) {
  if (!/^\d{1,2}:\d{2}$/.test(picked || "")) return null;
  const date = parseDay(day), sched = at(date, scheduled || "12:00").getTime();
  let t = at(date, picked);
  if (t.getTime() < sched - 12 * 3600000) { const next = new Date(t); next.setDate(next.getDate() + 1); if (next.getTime() <= now) t = next; }
  return t.getTime() > now + 60000 ? null : t;
}

/**
 * The new moment for a logged dose whose time is changed to `picked` ("HH:MM"): that time on the day before, the
 * day of, or the day after when it was logged, whichever is nearest (within 12 h of) the logged moment, so the day
 * doesn't jump. null when that would be in the future.
 */
export function editedLogTime(loggedAt, picked, now = Date.now()) {
  if (!/^\d{1,2}:\d{2}$/.test(picked || "")) return null;
  const was = new Date(loggedAt), ms = was.getTime();
  if (isNaN(ms)) return null;
  let best = null;
  for (const k of [0, -1, 1]) {
    const d = new Date(was); d.setDate(d.getDate() + k);
    const t = at(d, picked);
    if (t.getTime() > now + 60000 || Math.abs(t - ms) > 12 * 3600000) continue;
    if (!best || Math.abs(t - ms) < Math.abs(best - ms)) best = t;
  }
  return best;
}

// ---- reminders ----
export const REMINDER_DAYS = 14;
/**
 * One-off alarms for the next `days` days, one per day and time, listing the active medicines whose dose isn't logged yet.
 * id = 1000 + day offset * 200 + index of the time of day, so ids stay in 1000–3999.
 */
export function reminderPlan(meds, doses, { now = Date.now(), days = REMINDER_DAYS } = {}) {
  const byDay = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(now); date.setDate(date.getDate() + i);
    byDay.push(dosesOn(date, meds, doses, { now }).filter(d => !d.log && d.when > now));
  }
  // times counted from the last dose (9:30 after a late 9:00 dose) get their own ids too
  const times = [...new Set(meds.flatMap(m => m.times || []).concat(byDay.flat().map(d => d.time)))].sort(), out = [];
  byDay.forEach((list, i) => {
    const slots = {};
    for (const d of list) (slots[d.time] = slots[d.time] || { id: 1000 + i * 200 + times.indexOf(d.time), day: d.day, time: d.time, at: new Date(d.when), meds: [] }).meds.push(d.med);
    out.push(...Object.values(slots));
  });
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
  return { level, missed, due, taken, total: list.length, low: lowStock(meds, doses, now) };
}

// ---- adherence progress (on-time rate, streak, badges) ----
export const ON_TIME_WINDOW_MIN = 60;
/** Taken within ON_TIME_WINDOW_MIN minutes (either side) of its scheduled time. */
export const isOnTime = (d, windowMin = ON_TIME_WINDOW_MIN) =>
  !!(d.log && d.log.status === "taken" && d.log.at && Math.abs(new Date(d.log.at).getTime() - d.when) <= windowMin * 60000);
/**
 * One day's scheduled doses (as-needed medicines and extra doses never count): how many, how many on time, and how
 * many are still open (not on time, but not logged and still inside the on-time window, so they could be).
 */
export function dayOnTime(date, meds, doses, now = Date.now(), windowMin = ON_TIME_WINDOW_MIN) {
  const list = dosesOn(date, meds.filter(m => !isPrn(m)), doses, { now });
  let onTime = 0, open = 0;
  for (const d of list) {
    if (isOnTime(d, windowMin)) onTime++;
    else if (!d.log && now <= d.when + windowMin * 60000) open++;
  }
  return { total: list.length, onTime, open, failed: list.length - onTime - open };
}
/** On-time rate over the last `days` days including today; doses still open are left out. pct null with nothing to count. */
export function onTimeRate(meds, doses, days, now = Date.now()) {
  let onTime = 0, total = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const s = dayOnTime(d, meds, doses, now);
    onTime += s.onTime; total += s.total - s.open;
  }
  return { onTime, total, pct: total ? Math.round(onTime / total * 100) : null };
}
/**
 * Consecutive days, back from today, with every scheduled dose on time. Days with nothing scheduled are skipped.
 * Today counts once all its doses are on time; while some are still open it neither counts nor breaks the streak.
 */
export function onTimeStreak(meds, doses, now = Date.now(), maxDays = 400) {
  let streak = 0;
  for (let i = 0; i < maxDays; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const s = dayOnTime(d, meds, doses, now);
    if (!s.total) continue;
    if (s.failed) break;
    if (s.open) continue; // only possible today (or later doses of today)
    streak++;
  }
  return streak;
}
export const BADGES = [
  { days: 3, emoji: "🌱", label: "3-day streak" },
  { days: 7, emoji: "⭐", label: "1 week on time" },
  { days: 14, emoji: "🏅", label: "2 weeks on time" },
  { days: 30, emoji: "🏆", label: "1 month on time" },
];
export const badgesFor = streak => BADGES.filter(b => streak >= b.days);
export function encouragement(streak, rate7Pct) {
  const next = BADGES.find(b => streak < b.days);
  if (!next) return "A whole month of on-time doses. Amazing work!";
  const togo = next.days - streak, until = togo + (togo === 1 ? " more day" : " more days") + " to " + next.emoji + " " + next.label + ".";
  if (streak === 0) return rate7Pct != null && rate7Pct >= 80 ? "You're doing well this week. " + until : "Every on-time dose counts. " + until;
  return "Great job, " + streak + (streak === 1 ? " day" : " days") + " in a row! " + until;
}
/** Everything the Today progress card shows. */
export function adherenceProgress(meds, doses, now = Date.now()) {
  const rate7 = onTimeRate(meds, doses, 7, now), rate30 = onTimeRate(meds, doses, 30, now), streak = onTimeStreak(meds, doses, now);
  return { rate7, rate30, streak, badges: badgesFor(streak), message: encouragement(streak, rate7.pct) };
}

// ---- calendar export (.ics with RRULE) ----
const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const icsLocal = d => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00";
const icsUtc = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = s => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// Fold lines longer than 75 octets (RFC 5545 §3.1) without splitting a character.
function icsFold(line) {
  const enc = new TextEncoder(), out = [];
  let cur = "", len = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; len = 0; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}
/** The repeat rule for a medicine: { freq: DAILY|WEEKLY|MONTHLY, interval, byDay: [0-6], byMonthDay }. null for as-needed. */
export function recurrenceOf(med, doses) {
  const s = scheduleOf(med), n = Math.max(1, Math.floor(Number(s.n) || 1));
  switch (s.kind) {
    case "prn": return null;
    case "weekdays": return { freq: "WEEKLY", interval: 1, byDay: [...new Set((s.days || []).map(Number))].sort() };
    case "everyNDays": return { freq: "DAILY", interval: n };
    case "everyNWeeks": return { freq: "WEEKLY", interval: n };
    case "monthly": {
      // counting from the last dose taken keeps that dose's day of the month (see addInterval)
      const anc = doseAnchors(med, doses);
      if (anc.length) return { freq: "MONTHLY", interval: 1, byMonthDay: anc[anc.length - 1].at.getDate() };
      return { freq: "MONTHLY", interval: 1, byMonthDay: Math.min(31, Math.max(1, Math.floor(Number(s.dayOfMonth)) || (med.start ? parseDay(med.start).getDate() : 1))) };
    }
    default: return { freq: "DAILY", interval: 1 };
  }
}
export function rruleOf(med, doses) {
  const r = recurrenceOf(med, doses); if (!r) return null;
  let rule = "FREQ=" + r.freq + (r.interval > 1 ? ";INTERVAL=" + r.interval : "");
  if (r.byDay) rule += ";BYDAY=" + r.byDay.map(d => BYDAY[d]).join(",");
  // days 29–31: the last day of shorter months, like the app (largest of 28..d that exists)
  if (r.byMonthDay) rule += r.byMonthDay > 28 ? ";BYMONTHDAY=" + Array.from({ length: r.byMonthDay - 27 }, (_, i) => 28 + i).join(",") + ";BYSETPOS=-1" : ";BYMONTHDAY=" + r.byMonthDay;
  if (med.end) rule += ";UNTIL=" + med.end.replace(/-/g, "") + "T235959";
  return rule;
}
/**
 * The first doses of a medicine's calendar series: its next scheduled day from today on (interval schedules count from
 * the last dose taken), one entry per time of day. [] for as-needed or when nothing is scheduled in the next ~13 months.
 */
export function calendarStarts(med, doses = {}, now = Date.now()) {
  const m = normalizeMed(med);
  if (isPrn(m)) return [];
  for (let i = 0; i < 400; i++) {
    const date = new Date(now); date.setDate(date.getDate() + i); date.setHours(12, 0, 0, 0);
    if (m.end && dayKey(date) > m.end) return [];
    const list = scheduledOn(m, date, doses);
    if (list.length) return list.map(x => ({ time: x.slot, start: new Date(x.when) }));
  }
  return [];
}
export const calendarTitle = med => typeIcon(med) + " " + [med.name, med.strength].filter(Boolean).join(" ") + " (" + doseLabel(med) + ")";
/** An .ics file with one repeating event per time of day. "" for as-needed medicines. */
export function medToIcs(med, doses = {}, now = Date.now()) {
  const starts = calendarStarts(med, doses, now), rule = rruleOf(med, doses);
  if (!starts.length || !rule) return "";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//PillAlly//Medicine schedule//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const { time, start } of starts) {
    const end = new Date(start.getTime() + 15 * 60000);
    lines.push("BEGIN:VEVENT", "UID:" + med.id + "-" + time.replace(":", "") + "@pillbox", "DTSTAMP:" + icsUtc(new Date(now)),
      "DTSTART:" + icsLocal(start), "DTEND:" + icsLocal(end), "RRULE:" + rule,
      "SUMMARY:" + icsText(calendarTitle(med)),
      "DESCRIPTION:" + icsText("Take " + doseLabel(med) + " (" + scheduleLabel(med) + ")." + (med.notes ? " " + med.notes : "")),
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

// ---- health events (bleeds, side effects, symptoms, activity) ----
export const EVENT_TYPES = {
  bleed: { label: "Bleed", icon: "🩸" },
  sideEffect: { label: "Side effect", icon: "⚠️" },
  symptom: { label: "Symptom", icon: "🤒" },
  activity: { label: "Activity", icon: "🏃" },
  other: { label: "Other", icon: "📝" },
};
export const BODY_AREAS = {
  leftKnee: "Left knee", rightKnee: "Right knee", leftAnkle: "Left ankle", rightAnkle: "Right ankle",
  leftElbow: "Left elbow", rightElbow: "Right elbow", leftHip: "Left hip", rightHip: "Right hip",
  leftShoulder: "Left shoulder", rightShoulder: "Right shoulder",
  leftUpperArm: "Left upper arm", rightUpperArm: "Right upper arm",
  leftForearm: "Left forearm", rightForearm: "Right forearm",
  leftWrist: "Left wrist", rightWrist: "Right wrist",
  leftHand: "Left hand", rightHand: "Right hand",
  leftThigh: "Left thigh", rightThigh: "Right thigh",
  leftCalf: "Left shin", rightCalf: "Right shin",
  leftFoot: "Left foot", rightFoot: "Right foot",
  head: "Head", neck: "Neck", mouth: "Mouth / gums", nose: "Nose",
  chest: "Chest", stomach: "Stomach", lowerStomach: "Lower stomach", groin: "Groin",
  // Kept so older logs still have a name. The neck was saved as Head, the forearm as
  // the wrist, and the shin as Muscle (calf). The shin dots keep the leftCalf and
  // rightCalf ids. Each limb muscle was one id for both sides. Nose, mouth, upper
  // arm, and lower stomach stay choosable from the list; this chart has no dot for them.
  muscleThigh: "Muscle (thigh)", muscleCalf: "Muscle (calf)", muscleArm: "Muscle (arm)",
  other: "Other",
};
/** Ids kept so events saved before the split still have a name. They are not separate dots. */
export const LEGACY_BODY_AREAS = ["muscleThigh", "muscleCalf", "muscleArm"];
export const SEVERITIES = { 1: "Mild", 2: "Moderate", 3: "Severe" };
export const BLEED_CAUSES = { spontaneous: "Spontaneous", injury: "Injury", unknown: "Unknown" };

const str = v => (typeof v === "string" ? v.trim() : "");
/**
 * A clean event record: a known type (else "other"), `at` as an ISO time (invalid → now) and its local `day`,
 * a known body area, severity 1–3, cause (bleeds only), whole minutes of duration (activity only), the dose key
 * it was treated with, and trimmed notes. Anything not set is null. Who logged / edited it is kept.
 */
export function normalizeEvent(e = {}, now = Date.now()) {
  const type = EVENT_TYPES[e.type] ? e.type : "other";
  let t = e.at instanceof Date ? e.at.getTime() : typeof e.at === "number" ? e.at : Date.parse(e.at);
  if (!Number.isFinite(t)) t = now;
  const d = new Date(t), sev = Number(e.severity), dur = Math.round(Number(e.durationMin));
  const out = {
    id: str(e.id) || uid(), type, at: d.toISOString(), day: dayKey(d),
    area: BODY_AREAS[e.area] ? e.area : null,
    severity: Number.isInteger(sev) && sev >= 1 && sev <= 3 ? sev : null,
    cause: type === "bleed" && BLEED_CAUSES[e.cause] ? e.cause : null,
    durationMin: type === "activity" && e.durationMin !== "" && e.durationMin != null && dur > 0 ? dur : null,
    treatedWith: str(e.treatedWith) || null,
    notes: str(e.notes),
  };
  for (const k of ["by", "byName", "editedBy", "editedByName"]) if (str(e[k])) out[k] = str(e[k]);
  for (const k of ["createdAt", "updatedAt"]) if (Number.isFinite(e[k])) out[k] = e[k];
  return out;
}
/** Events on one local date (events: map or array), earliest first. */
export function eventsOn(date, events) {
  const day = dayKey(date);
  return Object.values(events || {}).filter(e => e && e.at && dayKey(new Date(e.at)) === day).sort((a, b) => a.at.localeCompare(b.at));
}
/** "Bleed · Left knee · Moderate · Injury", "Activity · 45 min · Mild". */
export function eventLabel(e) {
  const t = EVENT_TYPES[e.type] || EVENT_TYPES.other;
  return [t.label, BODY_AREAS[e.area], e.durationMin > 0 ? rel(e.durationMin * 60000) : null, SEVERITIES[e.severity],
    e.type === "bleed" ? BLEED_CAUSES[e.cause] : null].filter(Boolean).join(" · ");
}
/** How a taken dose reads in the "Treated with" picker: "Factor VIII 2000 IU · Tue 8:14 AM" (weekday when not on `now`'s day). */
export function doseLinkLabel(dose, meds, now = Date.now()) {
  const med = (meds || []).find(m => m.id === dose.medId), d = new Date(dose.at);
  const name = med ? [med.name, med.strength].filter(Boolean).join(" ") : "Medicine";
  return name + " · " + (dayKey(d) !== dayKey(new Date(now)) ? WD[d.getDay()] + " " : "") + fmtTime(hm(d));
}
/** Doses taken in the last `hours` hours (up to now), newest first, for linking an event to its treatment: [{ key, label, at }]. */
export function recentDosesForLink(meds, doses, now = Date.now(), hours = 48) {
  const from = now - hours * 3600000, out = [];
  for (const [key, d] of Object.entries(doses || {})) {
    if (!d || d.status !== "taken" || !d.at) continue;
    const t = new Date(d.at).getTime();
    if (!(t >= from && t <= now + 60000)) continue;
    out.push({ key, label: doseLinkLabel(d, meds, now), at: d.at });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
