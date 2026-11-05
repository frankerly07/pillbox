import "./style.css";
import * as M from "./model.js";
import { makeStore } from "./store.js";
import * as N from "./native.js";

const { esc, fmtTime, fmtClock, dayKey } = M;
const $app = document.getElementById("app");
const $nav = document.getElementById("tabs");

const S = {
  role: "patient", store: null, user: null,
  patients: [], snaps: {}, pid: null, // pid: patient being viewed
  view: "today", sub: "today",
  cal: { y: new Date().getFullYear(), m: new Date().getMonth(), sel: dayKey(new Date()) },
  editing: null, sheet: null, alert: null, ble: "Not connected", link: null, auth: { mode: "signin", error: "" },
  settings: loadSettings(), perm: "default",
};
function loadSettings() { try { return { dueWindowMin: 60, ...JSON.parse(localStorage.getItem("pillbox.settings") || "{}") }; } catch (e) { return { dueWindowMin: 60 }; } }
function saveSettings() { try { localStorage.setItem("pillbox.settings", JSON.stringify(S.settings)); } catch (e) {} }
const opts = () => ({ now: Date.now(), dueWindowMin: S.settings.dueWindowMin });
const snap = (pid = S.pid) => S.snaps[pid] || { meds: [], doses: {}, name: "" };
const isCare = () => S.role === "caregiver";

// ---------------- actions ----------------
const stockEv = (reason, note = "") => ({ reason, note, by: S.role, byName: S.user?.name || "" });
// Change the pill count. If that can't be saved, put back the dose change that went with it (revert) so the
// count and the dose log don't drift apart, and throw an error the caller shows as a toast.
async function adjustStock(pid, medId, delta, ev, revert) {
  try { await S.store.adjustStock(pid, medId, delta, ev); }
  catch (err) {
    let undone = false;
    if (revert) undone = await revert().then(() => true, () => false);
    throw new Error("Couldn't update the supply count" + (undone ? ", so the change was undone" : revert ? " and couldn't undo the dose change" : "") + ". " + (err.message || String(err)));
  }
}
const putBack = (pid, key, was) => () => was ? S.store.setDose(pid, key, was) : S.store.clearDose(pid, key);
// `when` (a Date) is for doses logged late with "Taken earlier?"; otherwise it's now.
async function takeDose(pid, d, source = "app", when = new Date()) {
  const p = snap(pid);
  const existing = p.doses[d.key];
  if (existing && existing.status === "taken") { showAlert("dup", "Already taken at " + fmtClock(existing.at) + "."); return false; }
  const used = M.supplyPerDose(d.med); // in the supply unit: pills, a share of a vial, mL…
  await S.store.setDose(pid, d.key, { medId: d.med.id, day: d.day, time: d.time, slot: d.slot || d.time, status: "taken", at: when.toISOString(), source, by: S.role, byName: S.user?.name || "", used });
  // Anything logged here before was a skip, which used nothing, so taking always comes out of the supply.
  await adjustStock(pid, d.med.id, -used, stockEv("taken"), putBack(pid, d.key, existing));
  return true;
}
// Correct when a dose was taken. The supply already changed when it was logged, so only the time moves.
async function setDoseTime(pid, key, when) {
  const was = snap(pid).doses[key]; if (!was) return;
  // extra (as-needed) doses are filed under the day and time they were taken, so those move with it
  const moved = was.extra ? { day: dayKey(when), time: M.hm(when) } : {};
  await S.store.setDose(pid, key, { ...was, ...moved, at: when.toISOString(), timeEditedAt: new Date().toISOString(), timeEditedBy: S.user?.name || S.role });
}
async function skipDose(pid, d) {
  const was = snap(pid).doses[d.key];
  await S.store.setDose(pid, d.key, { medId: d.med.id, day: d.day, time: d.time, slot: d.slot || d.time, status: "skipped", at: new Date().toISOString(), source: "app", by: S.role, byName: S.user?.name || "" });
  const back = M.supplyTaken(was, d.med);
  if (back) await adjustStock(pid, d.med.id, back, stockEv("undo"), putBack(pid, d.key, was));
}
async function undoDose(pid, key) {
  const was = snap(pid).doses[key]; if (!was) return;
  await S.store.clearDose(pid, key);
  const med = snap(pid).meds.find(m => m.id === was.medId), back = M.supplyTaken(was, med);
  if (med && back) await adjustStock(pid, med.id, back, stockEv("undo"), putBack(pid, key, was));
}
async function takeExtra(pid, med, force = false) {
  const last = M.lastTaken(med.id, snap(pid).doses);
  if (!force && last && Date.now() - new Date(last.at).getTime() < 2 * 3600000) {
    S.alert = { kind: "dup", text: "You took " + med.name + " at " + fmtClock(last.at) + ", less than 2 hours ago.", force: med.id }; render(); return;
  }
  const now = new Date();
  const key = "extra_" + med.id + "_" + now.getTime(), used = M.supplyPerDose(med);
  await S.store.setDose(pid, key, { medId: med.id, day: dayKey(now), time: M.hm(now), status: "taken", at: now.toISOString(), source: "app", by: S.role, byName: S.user?.name || "", extra: true, used });
  await adjustStock(pid, med.id, -used, stockEv("taken", "extra dose"), putBack(pid, key, null));
  toast(med.name + " logged", key);
}
async function lidOpened(slot, source) {
  const pid = S.pid, p = snap(pid);
  const med = p.meds.find(m => Number(m.slot) === Number(slot));
  if (!med) { toast("No medicine is set for compartment " + slot); return; }
  const d = M.doseForLidOpen(med, p.meds, p.doses);
  if (d) { await takeDose(pid, d, source); toast(med.name + " (" + fmtTime(d.time) + ") marked taken"); return; }
  const last = M.lastTaken(med.id, p.doses);
  if (last && Date.now() - new Date(last.at).getTime() < 4 * 3600000) {
    showAlert("dup", "You already took " + med.name + " at " + fmtClock(last.at) + ". Compartment " + slot + " was opened again.");
    N.alertNow("Already taken", med.name + " was taken at " + fmtClock(last.at) + ".");
    return;
  }
  await takeExtra(pid, med, true);
}
function showAlert(kind, text) { S.alert = { kind, text }; render(); }
let toastT;
function toast(text, undo) {
  const el = document.getElementById("toast");
  el.innerHTML = esc(text) + (undo ? ` <button class="btn-sm btn-quiet toast-undo" data-act="undo" data-key="${undo}">Undo</button> <button class="btn-sm btn-quiet toast-undo" data-act="edit-time" data-key="${undo}">Change time</button>` : "");
  el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), undo ? 6000 : 3200);
}

// "Add to my calendar" (patient app). Updates m.addToCalendar / m.calendarEventIds in place; the caller saves m
// and shows the returned message (if any) as a toast.
// Events are (re)made when it's turned on or the schedule, dose or name changes; removed when it's turned off.
const calKey = m => JSON.stringify([m.name, m.strength, m.type, m.doseAmount, m.doseUnit, m.times, m.schedule, m.start || null, m.end || null]);
async function syncCalendar(before, m) {
  if (isCare()) return;
  const was = !!before?.addToCalendar, ids = before?.calendarEventIds || [];
  if (!m.addToCalendar || M.isPrn(m)) {
    m.addToCalendar = false; m.calendarEventIds = [];
    if (!was) return "";
    await N.removeMedFromCalendar(ids);
    return ids.length ? "Removed from your calendar" : "Calendar off. Delete the events in your calendar app if you added the file.";
  }
  if (was && calKey(before) === calKey(m)) return "";
  if (was) await N.removeMedFromCalendar(ids);
  const r = await N.addMedToCalendar(m, snap().doses);
  m.addToCalendar = r.ok; m.calendarEventIds = r.ids || [];
  return r.message;
}

// ---------------- shared pieces ----------------
const header = (title, sub, right = "") => `<header class="top"><div style="min-width:0"><div class="eyebrow">${esc(sub)}</div><h1>${esc(title)}</h1></div>${right}</header>`;
function alertBanner() {
  if (!S.alert) return "";
  return `<div class="banner ${S.alert.kind}" role="alert"><div>${esc(S.alert.text)}</div><div class="row">${S.alert.force ? `<button class="btn-sm btn-danger" data-act="force" data-med="${S.alert.force}">Log anyway</button>` : ""}<button class="btn-sm" data-act="dismiss">OK</button></div></div>`;
}
function exampleBanner() {
  if (!S.store.example) return "";
  const what = isCare() ? "These are example patients so you can see how the caregiver app works." : "These are example medicines.";
  return `<div class="banner info"><div><strong>${what}</strong> ${isCare() ? "Real patients appear once sync is set up." : "Replace them with your own."}</div><button class="btn-sm" data-act="clear-examples">Start empty</button></div>`;
}

function wells(pid, list) {
  return `<div class="pack">` + list.map(d => `<button class="well ${d.status}" data-act="well" data-pid="${pid}" data-key="${d.key}" aria-label="${esc(d.med.name)}, ${esc(M.fmtDoseTimes(d))}${d.log ? "" : ", " + d.status}">
    <span class="pill" aria-hidden="true"></span>
    <span class="time">${d.log ? `<span class="sched">Scheduled</span> ` : ""}${fmtTime(d.time)}</span><span class="name"><span aria-hidden="true">${M.typeIcon(d.med)}</span> ${esc(d.med.name)}</span><span class="dose">${d.med.strength ? esc(d.med.strength) + " · " : ""}${esc(M.doseLabel(d.med))}</span>
    <span class="chip ${d.status}">${d.log ? M.fmtLogged(d.log, d.day) : d.status === "upcoming" || d.status === "due" || d.status === "missed" ? (isCare() ? d.status : "Tap when taken") : d.status}</span>
    ${d.log && d.log.by === "caregiver" && !isCare() ? `<span class="muted small">by ${esc(d.log.byName || "caregiver")}</span>` : ""}
    ${d.log && d.log.by === "patient" && isCare() && d.log.source === "pillbox" ? `<span class="muted small">from pillbox</span>` : ""}</button>`).join("") + `</div>`;
}

// Patient Today: on-time rates, streak and badges.
function progressCard(pid) {
  const p = snap(pid);
  if (!p.meds.some(m => !M.isPrn(m))) return "";
  const a = M.adherenceProgress(p.meds, p.doses);
  const bar = (label, r) => `<div class="prog-row"><span>${label}</span><div class="meter" role="progressbar" aria-label="${label} on time" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.pct ?? 0}"><i style="width:${r.pct ?? 0}%"></i></div><span class="mono">${r.pct ?? "–"}${r.pct != null ? "%" : ""}</span></div>`;
  return `<section class="next stack-tight progress"><div class="row spread"><div class="eyebrow">On time (within ${M.ON_TIME_WINDOW_MIN} min)</div><div><span class="big-sm mono">${a.streak}</span> <span class="muted">${a.streak === 1 ? "day" : "days"} streak</span></div></div>
    ${bar("7 days", a.rate7)}${bar("30 days", a.rate30)}
    ${a.badges.length ? `<div class="badges">${a.badges.map(b => `<span class="badge" title="${esc(b.label)}"><span aria-hidden="true">${b.emoji}</span> ${esc(b.label)}</span>`).join("")}</div>` : ""}
    <div class="muted">${esc(a.message)}</div></section>`;
}

function todayBlock(pid) {
  const p = snap(pid), now = new Date(), list = M.dosesOn(now, p.meds, p.doses, opts());
  const groupDue = list.filter(d => (d.status === "due" || d.status === "missed") && !d.log);
  const nextT = groupDue.length ? groupDue[0].time : null;
  const group = nextT ? groupDue.filter(d => d.time === nextT) : [];
  const upcoming = list.find(d => d.status === "upcoming");
  const taken = list.filter(d => d.status === "taken").length;
  let h = "";
  if (group.length) {
    h += `<button class="take-all" data-act="take-group" data-pid="${pid}" data-time="${nextT}">
      <span class="eyebrow">${group[0].status === "missed" ? "Late" : "Due now"} · ${fmtTime(nextT)}</span>
      <span class="take-label">${isCare() ? "Mark as given" : "I took my medicine"}</span>
      <span class="take-meds">${group.map(d => esc(d.med.name) + " " + esc(d.med.strength)).join(" · ")}</span></button>
      <div class="row" style="margin-top:-6px"><button class="btn-quiet btn-sm" data-act="earlier-group" data-pid="${pid}" data-time="${nextT}">Taken earlier?</button></div>`;
  } else {
    h += `<section class="next"><div class="row spread"><div><div class="eyebrow">Next dose</div>${upcoming ? `<div class="big time">${fmtTime(upcoming.time)}</div><div><strong>${esc(upcoming.med.name)}</strong> ${esc(upcoming.med.strength)}</div><div class="muted">in ${M.rel(upcoming.when - now)}</div>` : `<div class="big">All done</div><div class="muted">${list.length ? "No more doses today." : "No scheduled doses."}</div>`}</div>
      <div style="text-align:right"><div class="eyebrow">Taken</div><div class="big mono">${taken}/${list.length}</div></div></div></section>`;
  }
  if (!isCare()) h += progressCard(pid);
  h += `<section class="stack"><h2>Today's doses</h2>`;
  h += list.length ? wells(pid, list) : `<p class="muted">${isCare() ? "No scheduled doses today." : "Add a medicine with times and it shows up here."}</p>`;
  h += `</section>`;
  const prn = p.meds.filter(M.isPrn);
  if (prn.length) h += `<section class="stack"><h2>As needed</h2><div class="list">` + prn.map(m => { const l = M.lastTaken(m.id, p.doses); return `<div class="item"><div><span aria-hidden="true">${M.typeIcon(m)}</span> <strong>${esc(m.name)}</strong> ${esc(m.strength)} <span class="muted">· ${esc(M.doseLabel(m))}</span><div class="muted">${l ? "Last taken " + fmtClock(l.at) + (l.day === dayKey(now) ? " today" : " on " + M.parseDay(l.day).toLocaleDateString()) : "Not taken yet"}</div></div><button class="btn-sm" data-act="take-prn" data-pid="${pid}" data-med="${m.id}">Log dose</button></div>`; }).join("") + `</div></section>`;
  const low = M.lowStock(p.meds, p.doses);
  if (low.length) h += `<div class="banner dup"><div><strong>Refill soon:</strong> ${low.map(m => esc(m.name) + " (" + left(m, p.doses) + " left)").join(", ")}</div></div>`;
  return h;
}

const CAL_STATUS = { taken: "Taken", skipped: "Skipped", missed: "Missed", due: "Due", upcoming: "Upcoming" };
// The "actual" side of a calendar day row: when it was taken (and how far off schedule), or why not.
function actualText(d) {
  if (d.status === "missed") return `<strong class="stock-low">Missed · not taken</strong>`;
  if (!d.log) return `<span class="muted">Not taken yet</span>`;
  const t = new Date(d.log.at), off = t.getTime() - d.when;
  const logged = esc(M.fmtLogged(d.log, d.day)).replace(/(\d{1,2}:\d{2} [AP]M)$/, `<strong class="mono">$1</strong>`);
  if (d.log.status !== "taken") return logged;
  return logged + (M.isOnTime(d) ? ` <span class="ontime">· on time</span>` : ` <span class="late">· ${M.rel(off)} ${off > 0 ? "late" : "early"}</span>`);
}
function calendarBlock(pid) {
  const p = snap(pid), { y, m, sel } = S.cal, first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
  const title = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const todayK = dayKey(new Date());
  let cells = "";
  for (let i = 0; i < first.getDay(); i++) cells += `<span></span>`;
  for (let d = 1; d <= days; d++) {
    const date = new Date(y, m, d), k = dayKey(date), s = M.daySummary(date, p.meds, p.doses, opts());
    cells += `<button class="cal-day ${s.state}${k === sel ? " sel" : ""}${k === todayK ? " today" : ""}" data-act="cal-sel" data-day="${k}" aria-label="${date.toDateString()}: ${s.taken} of ${s.total} taken"><span>${d}</span>${s.total && date <= new Date() ? `<i>${s.taken}/${s.total}</i>` : ""}</button>`;
  }
  const selDate = M.parseDay(sel), sum = M.daySummary(selDate, p.meds, p.doses, opts());
  const extras = Object.entries(p.doses).filter(([, v]) => v.extra && v.day === sel);
  const ad = M.adherence(p.meds, p.doses, 30);
  return `<section class="stack">
    <div class="row spread"><button class="btn-sm" data-act="cal-prev" aria-label="Previous month">‹</button><h2>${esc(title)}</h2><button class="btn-sm" data-act="cal-next" aria-label="Next month">›</button></div>
    <div class="cal"><div class="cal-head">${["S", "M", "T", "W", "T", "F", "S"].map(x => `<span>${x}</span>`).join("")}</div><div class="cal-grid">${cells}</div></div>
    <div class="legend"><span><i class="lg all"></i>All taken</span><span><i class="lg some"></i>Some missed</span><span><i class="lg none"></i>None taken</span></div>
    <div class="next"><div class="eyebrow">Last 30 days</div><div class="big mono">${ad.pct ?? "–"}${ad.pct != null ? "%" : ""}</div><div class="muted">${ad.taken} of ${ad.total} scheduled doses taken</div></div>
    <h2 id="day-detail">${selDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h2>
    ${sum.list.length ? `<div class="muted">${sum.taken} of ${sum.total} scheduled doses taken${sum.list.some(d => d.status === "missed") ? ` · <span class="stock-low">${sum.list.filter(d => d.status === "missed").length} missed</span>` : ""}</div>` : ""}
    ${sum.list.length || extras.length ? `<div class="list day-list">` + sum.list.map(d => `<div class="item dd ${d.status}"><div class="stack-tight">
        <div><span aria-hidden="true">${M.typeIcon(d.med)}</span> <strong>${esc(d.med.name)}</strong> ${esc(d.med.strength || "")} <span class="chip ${d.status}">${CAL_STATUS[d.status] || d.status}</span></div>
        <div class="dd-amt">${esc(M.doseLabel(d.med))}</div>
        <div class="dd-times"><span>Scheduled <strong class="mono">${fmtTime(d.time)}</strong></span><span>${actualText(d)}</span></div>
        ${d.log && (d.log.by === "caregiver" || d.log.source === "pillbox") ? `<div class="muted small">${d.log.by === "caregiver" ? "Logged by " + esc(d.log.byName || "caregiver") : ""}${d.log.by === "caregiver" && d.log.source === "pillbox" ? " · " : ""}${d.log.source === "pillbox" ? "From pillbox" : ""}</div>` : ""}</div>
      ${d.log ? `<button class="btn-sm" data-act="undo" data-pid="${pid}" data-key="${d.key}">Undo</button>` : d.status !== "upcoming" ? `<button class="btn-sm btn-primary" data-act="open-sheet" data-pid="${pid}" data-key="${d.key}">Log…</button>` : ""}</div>`).join("")
      + extras.map(([k, v]) => { const med = p.meds.find(x => x.id === v.medId); return `<div class="item dd taken"><div class="stack-tight"><div>${med ? `<span aria-hidden="true">${M.typeIcon(med)}</span> ` : ""}<strong>${esc(med ? med.name : "Medicine")}</strong> ${esc(med?.strength || "")} <span class="chip taken">extra</span></div>${med ? `<div class="dd-amt">${esc(M.doseLabel(med))}</div>` : ""}<div class="dd-times"><span>As needed</span><span>Taken <strong class="mono">${fmtClock(v.at)}</strong></span></div></div><button class="btn-sm" data-act="open-sheet" data-pid="${pid}" data-key="${k}">Details</button></div>`; }).join("") + `</div>` : `<p class="muted">Nothing scheduled.</p>`}
  </section>`;
}

const REASON = { taken: "Dose taken", undo: "Dose undone", refill: "Refill", adjust: "Count corrected", start: "Starting count" };
const fmtDate = d => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const cap = s => s === "mL" ? s : s.charAt(0).toUpperCase() + s.slice(1);
const left = (m, doses) => { const s = M.supply(m, Date.now(), doses); return M.qty(s.left || 0, s.unit); };
function supplyLine(m, doses) {
  const s = M.supply(m, Date.now(), doses);
  if (s.left == null) return `<span class="muted">Supply not tracked</span>`;
  const days = s.daysLeft != null ? ` · about ${s.daysLeft} ${s.daysLeft === 1 ? "day" : "days"}, runs out ${fmtDate(s.runOut)}` : "";
  return `<span class="${s.low ? "stock-low" : "muted"}">${s.out ? "Out of " + M.unitName(s.unit) : M.qty(s.left, s.unit) + " left"}${days}${s.low && !s.out ? " · refill soon" : ""}</span>`;
}
function supplyBar(m, doses) {
  const s = M.supply(m, Date.now(), doses); if (s.left == null) return "";
  const full = Math.max(m.fullCount || 0, s.left, 1), pct = Math.round(s.left / full * 100);
  return `<div class="meter ${s.low ? "low" : ""}" role="img" aria-label="${M.fmtNum(s.left)} of ${M.qty(full, s.unit)} left"><i style="width:${pct}%"></i></div>`;
}
const timesText = m => M.isPrn(m) ? "" : " · " + m.times.map(fmtTime).join(", ");
function medsBlock(pid) {
  const p = snap(pid);
  if (S.editing) return medForm();
  if (S.medDetail) { const m = p.meds.find(x => x.id === S.medDetail); if (m) return medDetail(pid, m); S.medDetail = null; }
  const low = M.lowStock(p.meds, p.doses);
  return (low.length ? `<div class="banner dup"><div><strong>Refill soon:</strong> ${low.map(m => esc(m.name)).join(", ")}</div></div>` : "") +
    `<div class="list">` + (p.meds.length ? p.meds.map(m => `<button class="item item-btn" data-act="med-open" data-med="${m.id}"><div class="row" style="flex-wrap:nowrap;min-width:0;width:100%"><span class="swatch" style="background:${esc(m.color)}"></span><div class="stack-tight" style="min-width:0;flex:1"><div><span aria-hidden="true">${M.typeIcon(m)}</span> <strong>${esc(m.name)}</strong> ${esc(m.strength)}</div>
     <div class="muted">${esc(M.medSummary(m))}${timesText(m)}</div>
     ${supplyBar(m, p.doses)}<div>${supplyLine(m, p.doses)}</div></div><span class="chev" aria-hidden="true">›</span></div></button>`).join("") : `<div class="item muted">No medicines yet.</div>`) + `</div>
    <div class="row"><button class="btn-primary" data-act="new">Add medicine</button></div>`;
}
function medDetail(pid, m) {
  const p = snap(pid), s = M.supply(m, Date.now(), p.doses), u = s.unit;
  const log = (p.stockLog || []).filter(e => e.medId === m.id).slice().reverse().slice(0, 40);
  const st = S.stockForm;
  const runText = s.runOut ? `Runs out around <strong>${fmtDate(s.runOut)}</strong>.`
    : s.left == null ? "Set a count to start tracking supply."
    : M.isPrn(m) ? "As-needed medicine, so there's no run-out date."
    : "Enough for every scheduled dose" + (m.end ? " until it ends." : " for now.");
  return `<div class="row spread"><button class="btn-sm" data-act="med-close">‹ All medicines</button><button class="btn-sm" data-act="edit" data-med="${m.id}">Edit</button></div>
   <section class="sheet stack"><div><div class="eyebrow">${esc(M.medSummary(m))}</div><h2><span aria-hidden="true">${M.typeIcon(m)}</span> ${esc(m.name)} ${esc(m.strength)}</h2>
     ${!M.isPrn(m) ? `<div class="muted">${m.times.map(fmtTime).join(", ")}${m.start ? " · from " + fmtDate(M.parseDay(m.start)) : ""}${m.end ? " to " + fmtDate(M.parseDay(m.end)) : ""}</div>` : ""}
     ${m.prescribedBy ? `<div class="muted">Prescribed by ${esc(m.prescribedBy)}</div>` : ""}
     ${m.updatedByName ? `<div class="muted small">Last changed by ${esc(m.updatedByName)}${m.updatedByRole === "caregiver" ? " (care team)" : ""}${m.updatedAt ? " on " + fmtDate(new Date(m.updatedAt)) : ""}</div>` : ""}</div>
     ${!isCare() && !M.isPrn(m) ? `<div class="row spread" style="flex-wrap:nowrap"><div><strong>Add to my calendar</strong><div class="muted small">${m.addToCalendar ? (m.calendarEventIds?.length ? "On. Repeating events are in your phone's calendar." : "On. Added with a calendar file.") : "Off. Puts each dose in your phone's calendar."}</div></div>
       <button class="btn-sm ${m.addToCalendar ? "" : "btn-primary"}" role="switch" aria-checked="${!!m.addToCalendar}" data-act="cal-toggle" data-med="${m.id}">${m.addToCalendar ? "Turn off" : "Turn on"}</button></div>` : ""}
     <div class="supply-grid">
       <div><div class="eyebrow">${esc(cap(M.unitName(u)))} left</div><div class="big mono">${s.left != null ? M.fmtNum(s.left) : "–"}</div></div>
       <div><div class="eyebrow">Per dose</div><div class="big mono">${M.fmtNum(s.perDose)}</div></div>
       <div><div class="eyebrow">Days left</div><div class="big mono ${s.low ? "stock-low" : ""}">${s.daysLeft ?? "–"}</div></div>
     </div>
     ${supplyBar(m, p.doses)}
     <div>${runText} ${s.low ? `<span class="stock-low">Time to refill.</span>` : ""}</div>
     ${st ? `<form class="stack" id="stockform"><div class="field"><label for="s-n">${st.mode === "refill" ? cap(M.unitName(u)) + " added" : cap(M.unitName(u)) + " you have now"}</label><input id="s-n" name="n" type="number" min="0" step="any" inputmode="decimal" required value="${st.mode === "refill" ? (m.fullCount || (u === "pills" ? 30 : 1)) : (s.left != null ? M.fmtNum(s.left) : "")}"></div>
         <div class="field"><label for="s-note">Note (optional)</label><input id="s-note" name="note" placeholder="${st.mode === "refill" ? "e.g. CVS pickup, Rx #1234" : "e.g. Dropped two"}"></div>
         <div class="row"><button class="btn-primary" type="submit">${st.mode === "refill" ? "Add refill" : "Save count"}</button><button type="button" data-act="stock-cancel">Cancel</button></div></form>`
       : `<div class="row"><button class="btn-primary" data-act="stock-refill">Add refill</button><button data-act="stock-adjust">Correct count</button></div>`}
   </section>
   <section class="stack"><h2>Supply history</h2>
     ${log.length ? `<div class="list">` + log.map(e => `<div class="item"><div style="min-width:0"><strong>${esc(REASON[e.reason] || "Change")}</strong>${e.note ? ` <span class="muted">· ${esc(e.note)}</span>` : ""}
       <div class="muted small">${fmtDate(new Date(e.at))} at ${fmtClock(e.at)}${e.byName ? " · " + esc(e.byName) : ""}${e.by === "caregiver" ? " (care team)" : ""}</div></div>
       <div class="mono delta ${e.delta > 0 ? "plus" : ""}">${e.delta > 0 ? "+" : ""}${M.fmtNum(e.delta)}${e.after != null ? `<div class="muted small">${M.fmtNum(e.after)} left</div>` : ""}</div></div>`).join("") + `</div>`
       : `<p class="muted">Every dose, refill and correction will be listed here.</p>`}
   </section>`;
}
const FREQ = [["daily", "Every day"], ["weekdays", "Certain days of the week"], ["everyNDays", "Every few days"], ["everyNWeeks", "Every few weeks"], ["monthly", "Once a month"], ["prn", "As needed"]];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const opt = (v, label, sel) => `<option value="${v}" ${v === sel ? "selected" : ""}>${esc(label)}</option>`;
function medForm() {
  const m = S.editing, T = M.TYPES[m.type], sc = m.schedule, pill = m.type === "pill", u = m.supplyUnit;
  const container = M.CONTAINERS.includes(u), everyN = sc.kind === "everyNDays" || sc.kind === "everyNWeeks";
  const fixedToggle = `<label class="opt"><input type="checkbox" name="fixed" ${sc.fixed ? "checked" : ""}><span>Keep fixed schedule</span></label><div class="muted">${sc.fixed ? "Always on the set days and times, however late a dose is taken." : "The next dose is due one interval after the last one was actually taken (taken Tuesday 9:30 AM → next due a week later at 9:30 AM). Until the first dose, the set days and times are used."}</div>`;
  let freq = "";
  if (sc.kind === "weekdays") freq = `<div class="opts" role="group" aria-label="Days of the week">${WEEKDAYS.map((d, i) => `<label class="opt"><input type="checkbox" name="days" value="${i}" ${(sc.days || []).map(Number).includes(i) ? "checked" : ""}><span>${d}</span></label>`).join("")}</div>`;
  else if (everyN) freq = `<div class="amount"><span>Every</span><input name="n" type="number" min="1" max="365" inputmode="numeric" required value="${sc.n || 2}" aria-label="Repeat every"><span>${sc.kind === "everyNDays" ? "days" : "weeks"}</span></div><div class="muted">Counts from the start date.</div>${fixedToggle}`;
  else if (sc.kind === "monthly") freq = `<div class="amount"><span>On day</span><input name="dayOfMonth" type="number" min="1" max="31" inputmode="numeric" required value="${sc.dayOfMonth || (m.start ? M.parseDay(m.start).getDate() : new Date().getDate())}" aria-label="Day of the month"><span>of each month</span></div><div class="muted">In shorter months, the last day.</div>${fixedToggle}`;
  else if (sc.kind === "prn") freq = `<div class="muted">No reminders or missed-dose alerts. Log a dose on the Today screen whenever you take it.</div>`;
  return `<form class="sheet stack" id="medform"><h2>${m.isNew ? "Add medicine" : "Edit medicine"}</h2>
   <div class="field"><label for="f-name">Name</label><input id="f-name" name="name" required value="${esc(m.name)}" placeholder="e.g. Amoxicillin"></div>
   <fieldset class="field"><legend>Type</legend><div class="opts">${Object.entries(M.TYPES).map(([k, t]) => `<label class="opt"><input type="radio" name="type" value="${k}" data-live ${m.type === k ? "checked" : ""}><span><span aria-hidden="true">${t.icon}</span> ${esc(t.label)}</span></label>`).join("")}</div></fieldset>
   <div class="${pill ? "grid2" : "stack"}"><div class="field"><label for="f-strength">Strength (optional)</label><input id="f-strength" name="strength" value="${esc(m.strength)}" placeholder="${pill ? "e.g. 250 mg" : "e.g. 100 units/mL"}"></div>
   <div class="field"><label for="f-dose">Each dose</label><div class="amount"><input id="f-dose" name="doseAmount" type="number" min="0" step="any" inputmode="decimal" required value="${M.fmtNum(m.doseAmount)}">${pill ? `<span>pills</span>` : `<select name="doseUnit" aria-label="Dose unit">${T.doseUnits.map(x => opt(x, x === "units" ? "units (IU)" : x, m.doseUnit)).join("")}</select>`}</div></div></div>
   <div class="field"><label for="f-freq">How often</label><select id="f-freq" name="freq" data-live>${FREQ.map(([k, l]) => opt(k, l, sc.kind)).join("")}</select>${freq}</div>
   ${sc.kind !== "prn" ? `<div class="field"><label>Times of day</label><div class="times" id="f-times">${(m.times || []).map((t, i) => `<span class="t"><input type="time" id="f-time-${i}" value="${t}" aria-label="Dose time ${i + 1}"><button type="button" class="btn-quiet btn-sm" data-act="rmtime" data-i="${i}" aria-label="Remove time">✕</button></span>`).join("")}
     <button type="button" class="btn-sm" data-act="addtime">Add time</button></div></div>` : ""}
   ${!isCare() && sc.kind !== "prn" ? `<label class="opt"><input type="checkbox" name="addToCalendar" ${m.addToCalendar ? "checked" : ""}><span>📅 Add to my calendar</span></label>` : ""}
   <div class="grid2"><div class="field"><label for="f-start">Start date</label><input id="f-start" name="start" type="date" ${everyN ? "required" : ""} value="${esc(m.start || "")}"></div>
   <div class="field"><label for="f-end">End date (optional)</label><input id="f-end" name="end" type="date" value="${esc(m.end || "")}"></div></div>
   <h3>Supply</h3>
   ${pill ? "" : `<div class="grid2"><div class="field"><label for="f-unit">Counted in</label><select id="f-unit" name="supplyUnit" data-live>${T.supplyUnits.map(x => opt(x, x, u)).join("")}</select></div>
     ${container ? `<div class="field"><label for="f-per">Doses per ${M.unitName(u, 1)} (optional)</label><input id="f-per" name="perContainer" type="number" min="1" step="any" inputmode="decimal" value="${m.perContainer ?? ""}" placeholder="1"></div>` : "<div></div>"}</div>`}
   <div class="grid2"><div class="field"><label for="f-full">${esc(cap(M.unitName(u)))} in a full refill</label><input id="f-full" name="fullCount" type="number" min="0" step="any" inputmode="decimal" value="${m.fullCount ?? ""}" placeholder="${pill ? "e.g. 30" : "e.g. 4"}"></div>
   ${m.isNew ? `<div class="field"><label for="f-stock">${esc(cap(M.unitName(u)))} you have now</label><input id="f-stock" name="stock" type="number" min="0" step="any" inputmode="decimal" value="${m.stock ?? ""}"></div>` : "<div></div>"}</div>
   ${m.isNew ? "" : `<div class="muted">To change the count, use Add refill or Correct count on the medicine's page, so the history stays right.</div>`}
   <div class="grid2"><div class="field"><label for="f-refilld">Warn when this many days are left</label><input id="f-refilld" name="refillDays" type="number" min="0" inputmode="numeric" value="${m.refillDays ?? 7}"></div>
   <div class="field"><label for="f-refill">Or this many ${esc(M.unitName(u))}</label><input id="f-refill" name="refillAt" type="number" min="0" step="any" inputmode="decimal" value="${m.refillAt ?? (pill ? 5 : 1)}"></div></div>
   <div class="field"><label for="f-rx">Prescribed by (optional)</label><input id="f-rx" name="prescribedBy" value="${esc(m.prescribedBy || "")}" placeholder="e.g. Dr. Patel"></div>
   ${pill || m.type === "other" ? `<div class="field"><label for="f-slot">Pillbox compartment</label><select id="f-slot" name="slot"><option value="">None</option>${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}" ${Number(m.slot) === n ? "selected" : ""}>${n}</option>`).join("")}</select></div>` : ""}
   <div class="field"><label for="f-notes">Notes</label><input id="f-notes" name="notes" value="${esc(m.notes)}" placeholder="${pill ? "e.g. Take with food" : "e.g. Rotate injection site"}"></div>
   <div class="row spread"><div class="row"><button class="btn-primary" type="submit">Save</button><button type="button" data-act="cancel">Cancel</button></div>${!m.isNew ? `<button type="button" class="btn-danger btn-sm" data-act="delete">${m.confirmDelete ? "Tap again to delete" : "Delete"}</button>` : ""}</div>
  </form>`;
}

function remindersCard() {
  const label = { granted: "On", denied: "Blocked. Turn them on in Android settings.", default: "Not set up yet", prompt: "Not set up yet", "prompt-with-rationale": "Not set up yet", unsupported: "Not available in this browser" }[S.perm] || S.perm;
  return `<div class="row spread"><div><strong>${isCare() ? "Missed-dose alerts" : "Dose alarms"}</strong><div class="muted">${esc(label)}</div></div>${S.perm === "granted" ? "" : `<button class="btn-sm btn-primary" data-act="perm">Turn on</button>`}</div>`;
}
function accountCard() {
  if (S.store.mode !== "cloud") return `<div class="row spread"><div><strong>Sync</strong><div class="muted">Off. Data stays on this phone until sync is set up.</div></div></div>`;
  return `<div class="row spread"><div><strong>${esc(S.user.name)}</strong><div class="muted">${esc(S.user.email || "")}</div></div><button class="btn-sm" data-act="signout">Sign out</button></div>`;
}

// ---------------- patient app ----------------
function patientView() {
  const pid = S.pid, p = snap(pid), now = new Date();
  switch (S.view) {
    case "calendar": return header("Calendar", "Your doses by day") + `<div class="stack">${calendarBlock(pid)}</div>`;
    case "meds": return header("Medicines", p.meds.length + " on your list") + `<div class="stack">${exampleBanner()}${medsBlock(pid)}</div>`;
    case "more": return header("More", "Pillbox, care team and settings") + `<div class="stack">
      <section class="sheet stack"><h2>Care team</h2>
        <p class="muted">Let a family member, caregiver or doctor see your doses and get an alert if you miss one.</p>
        ${(p.caregivers || []).length ? `<div class="list">${p.caregivers.map(c => `<div class="item"><div><strong>${esc((p.caregiverNames || {})[c] || "Caregiver")}</strong></div><button class="btn-sm btn-danger" data-act="unlink" data-uid="${c}">Remove</button></div>`).join("")}</div>` : ""}
        ${S.link ? `<div class="code">${S.link.code.slice(0, 3)} ${S.link.code.slice(3)}</div><div class="muted">Have them enter this code in the Pillbox Care app. It works for 24 hours.</div>` : `<button class="btn-primary" data-act="mkcode">Get a link code</button>`}
      </section>
      <section class="sheet stack"><h2>Pillbox</h2>
        <div class="row spread"><div><strong>Bluetooth pillbox</strong><div class="muted">${esc(S.ble)}</div></div><button class="btn-sm btn-primary" data-act="ble">Connect</button></div>
        <p class="muted">No pillbox yet? Tap a compartment to test what happens when its lid opens.</p>
        ${p.meds.filter(m => m.slot).length ? `<div class="pack">` + p.meds.filter(m => m.slot).sort((a, b) => a.slot - b.slot).map(m => `<button class="well" data-act="sim" data-slot="${m.slot}"><span class="time">Compartment ${esc(m.slot)}</span><span class="name">${esc(m.name)}</span><span class="dose">Open lid</span></button>`).join("") + `</div>` : `<p class="muted">Assign a compartment to a medicine first.</p>`}
      </section>
      <section class="sheet stack"><h2>Settings</h2>${remindersCard()}${accountCard()}</section></div>`;
    default: return header("Today", now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })) + `<div class="stack">${alertBanner()}${exampleBanner()}${todayBlock(pid)}</div>`;
  }
}

// ---------------- caregiver app ----------------
function caregiverView() {
  if (S.view === "settings") return header("Settings", "Pillbox Care") + `<div class="stack"><section class="sheet stack">${remindersCard()}${accountCard()}</section></div>`;
  if (S.view === "link") return header("Add a patient", "Link with a code") + `<div class="stack">
    <form class="sheet stack" id="joinform"><p>Ask the patient to open Pillbox, go to <strong>More › Care team</strong> and tap <strong>Get a link code</strong>.</p>
    <div class="field"><label for="j-code">6-digit code</label><input id="j-code" name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" required placeholder="123 456"></div>
    ${S.joinError ? `<div class="banner dup">${esc(S.joinError)}</div>` : ""}
    <button class="btn-primary" type="submit">Link patient</button></form></div>`;
  if (S.pid && S.snaps[S.pid]) {
    const p = snap(), tabs = [["today", "Today"], ["calendar", "Calendar"], ["meds", "Medicines"]];
    let body = S.sub === "calendar" ? calendarBlock(S.pid) : S.sub === "meds" ? medsBlock(S.pid) : todayBlock(S.pid);
    return header(p.name, "Patient", `<button class="btn-sm" data-act="back">All patients</button>`) + `<div class="stack">${alertBanner()}
      <div class="seg" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${S.sub === k}" data-act="sub" data-sub="${k}">${l}</button>`).join("")}</div>${body}</div>`;
  }
  // patient list
  const cards = S.patients.map(pt => {
    const p = S.snaps[pt.id]; if (!p) return `<div class="pcard"><strong>${esc(pt.name)}</strong><div class="muted">Loading…</div></div>`;
    const st = M.patientStatus(p.meds, p.doses, Date.now()), ad = M.adherence(p.meds, p.doses, 7);
    const msg = st.missed.length ? st.missed.map(d => d.med.name + " " + fmtTime(d.time)).join(", ") + " not taken" : st.due.length ? st.due.map(d => d.med.name).join(", ") + " due now" : st.total ? "On track today" : "Nothing scheduled today";
    return `<button class="pcard ${st.level}" data-act="open" data-pid="${pt.id}">
      <div class="row spread" style="flex-wrap:nowrap"><strong class="pname">${esc(p.name)}</strong><span class="chip ${st.level === "ok" ? "taken" : st.level}">${st.level === "ok" ? "OK" : st.level}</span></div>
      <div>${esc(msg)}</div>
      <div class="row muted small"><span>Today ${st.taken}/${st.total}</span><span>7-day ${ad.pct ?? "–"}${ad.pct != null ? "%" : ""}</span>${st.low.length ? `<span class="stock-low">Refill: ${st.low.map(m => esc(m.name)).join(", ")}</span>` : ""}</div></button>`;
  }).join("");
  return header("Patients", new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })) + `<div class="stack">${alertBanner()}${exampleBanner()}
    ${S.patients.length ? `<div class="stack">${cards}</div>` : `<div class="sheet"><h2>No patients yet</h2><p class="muted">Link a patient with the 6-digit code from their Pillbox app.</p></div>`}
    <div class="row"><button class="btn-primary" data-act="go-link">Add a patient</button></div></div>`;
}

// ---------------- auth screen ----------------
function authView() {
  const a = S.auth, signup = a.mode === "signup";
  return `<div class="stack auth">${header(isCare() ? "Pillbox Care" : "Pillbox", isCare() ? "For caregivers, family and doctors" : "Your medicine, on time")}
    <form class="sheet stack" id="authform"><h2>${signup ? "Create account" : "Sign in"}</h2>
      ${signup ? `<div class="field"><label for="a-name">Your name</label><input id="a-name" name="name" required autocomplete="name"></div>` : ""}
      <div class="field"><label for="a-email">Email</label><input id="a-email" name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label for="a-pw">Password</label><input id="a-pw" name="password" type="password" minlength="6" required autocomplete="${signup ? "new-password" : "current-password"}"></div>
      ${a.error ? `<div class="banner dup">${esc(a.error)}</div>` : ""}
      <button class="btn-primary" type="submit">${signup ? "Create account" : "Sign in"}</button>
      <button type="button" class="btn-quiet" data-act="auth-toggle">${signup ? "I already have an account" : "Create an account"}</button>
      ${signup ? "" : `<button type="button" class="btn-quiet" data-act="auth-reset">Forgot password</button>`}
    </form></div>`;
}

// ---------------- render ----------------
const NAV = {
  patient: [["today", "Today"], ["calendar", "Calendar"], ["meds", "Medicines"], ["more", "More"]],
  caregiver: [["patients", "Patients"], ["link", "Add patient"], ["settings", "Settings"]],
};
function render() {
  if (!S.user) { $app.innerHTML = authView(); $nav.hidden = true; return; }
  $nav.hidden = false;
  const items = NAV[S.role];
  $nav.innerHTML = `<div class="in" style="grid-template-columns:repeat(${items.length},1fr)">` + items.map(([k, l]) => `<a href="#${k}" ${S.view === k || (k === "patients" && S.view === "today") ? 'aria-current="page"' : ""}>${l}</a>`).join("") + `</div>`;
  $app.innerHTML = (isCare() ? caregiverView() : patientView()) + sheetView();
}
// Dose sheet. S.sheet = { pid, key } for one dose, or { pid, time, group: true } for "Taken earlier?" on the
// take-all button. `edit` shows the time picker (late logging, or changing a taken dose's time).
function timeForm(day, scheduled, value, label) {
  return `<form class="stack" id="timeform"><div class="field"><label for="t-at">${label}</label>
    <input id="t-at" name="at" type="time" required value="${esc(S.sheet.value || value || M.defaultLogTime(day, scheduled))}"></div>
    ${S.sheet.error ? `<div class="banner dup">${esc(S.sheet.error)}</div>` : ""}
    <div class="row"><button class="btn-primary" type="submit">Save</button><button type="button" data-act="edit-cancel">Cancel</button></div></form>`;
}
function sheetView() {
  if (!S.sheet) return "";
  const { pid, key } = S.sheet, p = snap(pid);
  const wrap = body => `<div class="overlay" data-act="close-sheet"><div class="panel" role="dialog" aria-label="Dose details">${body}<button class="btn-quiet" data-act="close-sheet">Close</button></div></div>`;
  if (S.sheet.group) {
    const list = M.dosesOn(new Date(), p.meds, p.doses, opts()).filter(d => d.time === S.sheet.time && !d.log);
    if (!list.length) { S.sheet = null; return ""; }
    return wrap(`<div class="eyebrow">Scheduled ${fmtTime(S.sheet.time)}</div><h2>When did you take ${list.length === 1 ? "it" : "them"}?</h2>
      <div class="muted">${list.map(d => esc(d.med.name)).join(" · ")}</div>${timeForm(list[0].day, S.sheet.time, "", "Taken at")}`);
  }
  const d = findDose(pid, key);
  if (!d) { S.sheet = null; return ""; }
  const who = d.log ? (d.log.byName && d.log.by === "caregiver" ? " by " + esc(d.log.byName) : "") + (d.log.source === "pillbox" ? " (pillbox)" : "") : "";
  let actions;
  if (S.sheet.edit) actions = timeForm(d.day, d.time, d.log ? M.hm(new Date(d.log.at)) : "", d.log ? "Taken at" : "When did you take it?");
  else if (d.log) actions = `<div class="row">${d.log.status === "taken" ? `<button data-act="edit-time" data-pid="${pid}" data-key="${d.key}">Change time</button>` : ""}<button data-act="undo" data-pid="${pid}" data-key="${d.key}">Undo</button></div>`;
  else actions = `<button class="btn-primary" data-act="take-key" data-pid="${pid}" data-key="${d.key}">Taken now</button>
      <button data-act="edit-time" data-pid="${pid}" data-key="${d.key}">Taken earlier?</button>
      <button class="btn-quiet" data-act="skip" data-pid="${pid}" data-key="${d.key}">Skip this dose</button>`;
  return wrap(`<div class="eyebrow">${esc(M.medSummary(d.med))}</div><h2>${esc(d.med.name)} ${esc(d.med.strength)}</h2>${d.med.notes ? `<div class="muted">${esc(d.med.notes)}</div>` : ""}
    <p class="dose-times"><strong>${esc(M.fmtDoseTimes(d))}</strong>${who}</p>${actions}`);
}
function route() {
  const h = location.hash.slice(1), valid = NAV[S.role].map(x => x[0]);
  S.view = valid.includes(h) ? h : valid[0];
  if (isCare() && S.view !== "patients") S.pid = null;
  S.editing = null; S.sheet = null; S.joinError = ""; S.medDetail = null; S.stockForm = null;
  render(); window.scrollTo(0, 0);
}

function findDose(pid, key) {
  const p = snap(pid), log = p.doses[key];
  if (log && log.extra) { // as-needed / extra doses aren't on the schedule
    const med = p.meds.find(m => m.id === log.medId);
    return med && { key, med, day: log.day, time: log.time, slot: log.time, when: new Date(log.at).getTime(), status: log.status, log };
  }
  return M.dosesOn(M.parseDay(key.split("_")[1]), p.meds, p.doses, opts()).find(x => x.key === key);
}
// Copy the form into S.editing. Fields that aren't shown for the current type/frequency keep their last value.
function readForm() {
  const f = document.getElementById("medform"); if (!f) return;
  const fd = new FormData(f), m = S.editing, has = k => fd.has(k) || !!f.querySelector(`[name="${k}"]`);
  const num = (k, fallback) => has(k) ? (fd.get(k) === "" ? null : Number(fd.get(k))) : fallback;
  const type = fd.get("type") || m.type, T = M.TYPES[type];
  const pick = (v, list) => list.includes(v) ? v : list[0];
  const kind = fd.get("freq") || m.schedule.kind, wasPrn = m.schedule.kind === "prn";
  const sc = { ...m.schedule, kind };
  if (has("days")) sc.days = fd.getAll("days").map(Number);
  if (kind === "weekdays" && !sc.days) sc.days = [(fd.get("start") ? M.parseDay(fd.get("start")) : new Date()).getDay()];
  if (has("n")) sc.n = Number(fd.get("n")) || 1;
  if (has("fixed")) sc.fixed = fd.has("fixed");
  if (has("addToCalendar")) m.addToCalendar = fd.has("addToCalendar");
  if (has("dayOfMonth")) sc.dayOfMonth = Number(fd.get("dayOfMonth")) || 1;
  const refillAt = Number(fd.get("refillAt") || 0), defaultAt = t => t === "pill" ? 5 : 1;
  Object.assign(m, {
    // switching type resets the "warn at" count if it was still the old type's default
    refillAt: type !== m.type && refillAt === defaultAt(m.type) ? defaultAt(type) : refillAt,
    name: fd.get("name"), strength: fd.get("strength"), notes: fd.get("notes"), type,
    doseAmount: Number(fd.get("doseAmount")) || m.doseAmount,
    doseUnit: pick(fd.get("doseUnit") || m.doseUnit, T.doseUnits),
    supplyUnit: pick(fd.get("supplyUnit") || m.supplyUnit, T.supplyUnits),
    perContainer: num("perContainer", m.perContainer),
    schedule: sc,
    slot: has("slot") && fd.get("slot") ? Number(fd.get("slot")) : has("slot") ? null : m.slot ?? null,
    start: fd.get("start") || null, end: fd.get("end") || null,
    refillDays: Number(fd.get("refillDays") || 0),
    fullCount: num("fullCount", null),
    prescribedBy: (fd.get("prescribedBy") || "").trim(),
    ...(has("stock") ? { stock: num("stock", null) } : {}),
  });
  // a new medicine's suggested 30 pills makes no sense as 30 vials or bags
  if (m.isNew && type !== "pill" && m.stock === 30) m.stock = null;
  if (f.querySelector("#f-times")) m.times = [...f.querySelectorAll("#f-times input[type=time]")].map(i => i.value).filter(Boolean);
  if (wasPrn && kind !== "prn" && !m.times.length) m.times = ["08:00"];
}
// Only the settings that matter for the chosen frequency are saved.
function cleanSchedule(sc) {
  const out = { kind: sc.kind };
  if (sc.kind === "weekdays") out.days = [...new Set(sc.days || [])].sort();
  if (sc.kind === "everyNDays" || sc.kind === "everyNWeeks") out.n = Math.max(1, Math.floor(sc.n || 1));
  if (sc.kind === "monthly") out.dayOfMonth = Math.min(31, Math.max(1, Math.floor(sc.dayOfMonth || 1)));
  if (["everyNDays", "everyNWeeks", "monthly"].includes(sc.kind) && sc.fixed) out.fixed = true;
  return out;
}
// Remember the picked time so a background redraw (new data, 30 s tick) doesn't reset the picker.
document.addEventListener("input", e => { if (e.target.id === "t-at" && S.sheet) S.sheet.value = e.target.value; });
// Type, frequency and supply-unit pickers redraw the form so only the relevant fields show.
document.addEventListener("change", e => {
  if (!e.target.matches("#medform [data-live]")) return;
  readForm(); render();
  const again = document.querySelector(`#medform [name="${e.target.name}"]${e.target.type === "radio" ? `[value="${e.target.value}"]` : ""}`);
  if (again) again.focus();
});

document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act, pid = el.dataset.pid || S.pid;
  if (act === "close-sheet" && el.classList.contains("overlay") && e.target !== el) return;
  try {
    switch (act) {
      case "well": {
        const d = findDose(pid, el.dataset.key);
        if (d && !d.log) { if (await takeDose(pid, d)) toast(d.med.name + " marked taken", d.key); }
        else S.sheet = { pid, key: el.dataset.key };
        break;
      }
      case "take-group": {
        const list = M.dosesOn(new Date(), snap(pid).meds, snap(pid).doses, opts()).filter(d => d.time === el.dataset.time && !d.log);
        for (const d of list) await takeDose(pid, d);
        toast(list.length + (list.length === 1 ? " dose" : " doses") + " marked taken");
        break;
      }
      case "take-key": { const d = findDose(pid, el.dataset.key); if (d) await takeDose(pid, d); S.sheet = null; break; }
      case "skip": { const d = findDose(pid, el.dataset.key); if (d) await skipDose(pid, d); S.sheet = null; toast("Dose skipped"); break; }
      case "undo": await undoDose(pid, el.dataset.key); S.sheet = null; document.getElementById("toast").hidden = true; toast("Undone"); break;
      case "take-prn": await takeExtra(pid, snap(pid).meds.find(m => m.id === el.dataset.med)); break;
      case "force": await takeExtra(S.pid, snap().meds.find(m => m.id === el.dataset.med), true); S.alert = null; break;
      case "dismiss": S.alert = null; break;
      case "close-sheet": S.sheet = null; break;
      case "open-sheet": S.sheet = { pid, key: el.dataset.key }; break;
      case "edit-time": S.sheet = { pid, key: el.dataset.key, edit: true }; document.getElementById("toast").hidden = true; break;
      case "edit-cancel": if (S.sheet) { S.sheet.edit = false; S.sheet.error = ""; if (S.sheet.group) S.sheet = null; } break;
      case "earlier-group": S.sheet = { pid, time: el.dataset.time, group: true }; break;
      case "clear-examples": S.store.clearExamples(); S.snaps = {}; if (!isCare()) S.pid = "me"; break;
      case "cal-prev": S.cal.m--; if (S.cal.m < 0) { S.cal.m = 11; S.cal.y--; } break;
      case "cal-next": S.cal.m++; if (S.cal.m > 11) { S.cal.m = 0; S.cal.y++; } break;
      case "cal-sel": S.cal.sel = el.dataset.day; render(); document.getElementById("day-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }); return;
      case "new": S.editing = { ...M.normalizeMed({ id: M.uid(), name: "", strength: "", type: "pill", doseAmount: 1, times: ["08:00"], schedule: { kind: "daily" }, start: dayKey(new Date()), stock: 30, refillAt: 5, slot: null, notes: "", color: M.COLORS[snap().meds.length % M.COLORS.length] }), isNew: true }; break;
      case "edit": S.editing = M.normalizeMed(structuredClone(snap().meds.find(m => m.id === el.dataset.med))); break;
      case "cancel": S.editing = null; break;
      case "med-open": S.medDetail = el.dataset.med; S.stockForm = null; window.scrollTo(0, 0); break;
      case "med-close": S.medDetail = null; S.stockForm = null; break;
      case "stock-refill": S.stockForm = { mode: "refill" }; break;
      case "stock-adjust": S.stockForm = { mode: "adjust" }; break;
      case "stock-cancel": S.stockForm = null; break;
      case "addtime": readForm(); S.editing.times.push(S.editing.times.length ? "20:00" : "08:00"); break;
      case "rmtime": readForm(); S.editing.times.splice(Number(el.dataset.i), 1); break;
      case "cal-toggle": {
        const was = snap().meds.find(x => x.id === el.dataset.med); if (!was) break;
        const next = { ...was, addToCalendar: !was.addToCalendar };
        const msg = await syncCalendar(was, next); await S.store.saveMed(S.pid, next); if (msg) toast(msg); break;
      }
      case "delete": readForm(); if (!S.editing.confirmDelete) { S.editing.confirmDelete = true; break; } if (!isCare()) await N.removeMedFromCalendar(S.editing.calendarEventIds || []); await S.store.deleteMed(S.pid, S.editing.id); S.editing = null; S.medDetail = null; toast("Medicine deleted"); break;
      case "perm": S.perm = await N.askReminderPermission(); if (!isCare()) await N.scheduleReminders(snap().meds, snap().doses); break;
      case "mkcode": S.link = await S.store.createLinkCode(S.pid); break;
      case "unlink": await S.store.removeCaregiver(S.pid, el.dataset.uid); toast("Removed"); break;
      case "ble": N.connectPillbox(slot => lidOpened(slot, "pillbox").catch(err => toast(err.message || String(err))), s => { S.ble = s; render(); }); return;
      case "sim": await lidOpened(Number(el.dataset.slot), "simulated"); break;
      case "open": S.pid = el.dataset.pid; S.sub = "today"; window.scrollTo(0, 0); break;
      case "back": S.pid = null; break;
      case "sub": S.sub = el.dataset.sub; S.editing = null; S.medDetail = null; S.stockForm = null; break;
      case "go-link": location.hash = "link"; return;
      case "signout": await S.store.signOut(); S.user = null; S.snaps = {}; S.patients = []; break;
      case "auth-toggle": S.auth = { mode: S.auth.mode === "signup" ? "signin" : "signup", error: "" }; break;
      case "auth-reset": { const email = document.getElementById("a-email").value; if (!email) { S.auth.error = "Type your email first, then tap Forgot password."; break; } await S.store.resetPassword(email); S.auth.error = "Check your email for a reset link."; break; }
    }
  } catch (err) { toast(err.message || String(err)); }
  render();
});

document.addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  try {
    if (f.id === "medform") {
      readForm(); const m = S.editing; m.name = m.name.trim(); if (!m.name) return;
      m.schedule = cleanSchedule(m.schedule);
      m.times = m.schedule.kind === "prn" ? [] : [...new Set(m.times)].sort();
      if (m.schedule.kind !== "prn" && !m.times.length) { toast("Add at least one time of day, or choose As needed."); return; }
      if (m.schedule.kind === "weekdays" && !m.schedule.days.length) { toast("Pick at least one day of the week."); return; }
      if (!(m.doseAmount > 0)) { toast("Enter how much each dose is."); return; }
      if (m.type !== "pill" && m.type !== "other") m.slot = null;
      if (!M.CONTAINERS.includes(m.supplyUnit)) m.perContainer = null;
      const isNew = m.isNew; delete m.isNew; delete m.confirmDelete;
      for (const other of snap().meds) if (other.id !== m.id && m.slot && Number(other.slot) === m.slot) await S.store.saveMed(S.pid, { ...other, slot: null });
      if (!isNew) { const live = snap().meds.find(x => x.id === m.id); m.stock = live ? live.stock ?? null : m.stock ?? null; }
      Object.assign(m, { updatedByName: S.user?.name || "", updatedByRole: S.role, updatedAt: Date.now() });
      const calMsg = await syncCalendar(isNew ? null : snap().meds.find(x => x.id === m.id), m);
      const startCount = isNew && typeof m.stock === "number" ? m.stock : null;
      if (startCount != null) m.stock = 0;
      await S.store.saveMed(S.pid, m);
      if (startCount != null) await adjustStock(S.pid, m.id, startCount, stockEv("start"));
      S.editing = null; S.medDetail = m.id; toast((isNew ? "Medicine added" : "Saved") + (calMsg ? ". " + calMsg : ""));
    } else if (f.id === "timeform") {
      const sh = S.sheet, picked = new FormData(f).get("at"), p = snap(sh.pid);
      const list = sh.group ? M.dosesOn(new Date(), p.meds, p.doses, opts()).filter(d => d.time === sh.time && !d.log) : [findDose(sh.pid, sh.key)].filter(Boolean);
      if (!list.length) { S.sheet = null; render(); return; }
      // changing a logged time keeps the day it was taken (a Monday dose taken Tuesday stays on Tuesday)
      const when = list[0].log ? M.editedLogTime(list[0].log.at, picked) : M.logTimeFor(list[0].day, list[0].time, picked);
      if (!when) { sh.error = "That time hasn't happened yet."; render(); return; }
      let label = M.fmtLogged({ status: "taken", at: when.toISOString() }, list[0].day); label = label[0].toLowerCase() + label.slice(1);
      if (list[0].log) { await setDoseTime(sh.pid, list[0].key, when); toast("Changed to " + label); }
      else { for (const d of list) await takeDose(sh.pid, d, "app", when); toast((list.length === 1 ? list[0].med.name : list.length + " doses") + " " + label); }
      S.sheet = null;
    } else if (f.id === "stockform") {
      const fd = new FormData(f), n = Number(fd.get("n")), note = (fd.get("note") || "").trim();
      const m = snap().meds.find(x => x.id === S.medDetail); if (!m || !(n >= 0)) return;
      if (S.stockForm.mode === "refill") { await adjustStock(S.pid, m.id, n, stockEv("refill", note)); toast(M.qty(n, M.normalizeMed(m).supplyUnit) + " added"); }
      else { if (typeof m.stock !== "number") await S.store.saveMed(S.pid, { ...m, stock: 0 }); await adjustStock(S.pid, m.id, n - (m.stock || 0), stockEv("adjust", note)); toast("Count saved"); }
      S.stockForm = null;
    } else if (f.id === "joinform") {
      const code = new FormData(f).get("code").replace(/\D/g, "");
      const pid = await S.store.joinWithCode(code); S.joinError = ""; location.hash = "patients"; S.pid = pid; toast("Patient linked");
    } else if (f.id === "authform") {
      const fd = Object.fromEntries(new FormData(f));
      S.auth.error = "";
      S.user = S.auth.mode === "signup" ? await S.store.signUp(fd) : await S.store.signIn(fd);
      await afterLogin();
    }
  } catch (err) {
    const msg = friendly(err);
    if (f.id === "joinform") S.joinError = msg; else if (f.id === "authform") S.auth.error = msg; else toast(msg);
  }
  render();
});
function friendly(err) {
  const c = err && err.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "That email and password don't match. Try again or reset your password.";
  if (c.includes("email-already-in-use")) return "There's already an account with that email. Sign in instead.";
  if (c.includes("weak-password")) return "Use a password with at least 6 characters.";
  if (c.includes("network")) return "No internet connection. Try again when you're online.";
  if (c.includes("permission-denied")) return "That code isn't valid or has expired. Ask for a new one.";
  return err.message || String(err);
}

// ---------------- data wiring ----------------
const watchers = new Map();
let listUnsub = null;
const alertedMissed = new Set(JSON.parse(localStorage.getItem("pillbox.alerted") || "[]"));
function onSnap(pid, data) {
  S.snaps[pid] = data;
  if (!isCare()) { N.scheduleReminders(data.meds, data.doses).catch(() => {}); runQueuedReminderActions(); }
  else {
    N.scheduleCaregiverChecks(Object.values(S.snaps), S.settings.dueWindowMin).catch(() => {});
    checkMissed();
  }
  if (!S.editing) render();
}
function checkMissed() {
  if (!isCare()) return;
  for (const p of Object.values(S.snaps)) {
    for (const d of M.patientStatus(p.meds, p.doses, Date.now()).missed) {
      if (alertedMissed.has(d.key) || S.store.example) continue;
      alertedMissed.add(d.key);
      N.alertNow(p.name + " missed a dose", d.med.name + " at " + fmtTime(d.time) + " isn't marked taken.");
    }
  }
  try { localStorage.setItem("pillbox.alerted", JSON.stringify([...alertedMissed].slice(-300))); } catch (e) {}
}
// A reminder's "Taken" button can be pressed before the patient's data has loaded (it cold-starts the app),
// so hold it until the data is there, then record it.
const queuedActions = [];
async function onReminderAction(a) {
  const { action, extra, title, body } = a;
  if (action === "snooze") { await N.snooze(title, body, extra).catch(() => {}); return; }
  if (action !== "take") return;
  const pid = S.pid;
  if (!pid || !S.snaps[pid]) { queuedActions.push(a); return; }
  const p = snap(pid), list = M.dosesForReminder(extra, p.meds, p.doses);
  try {
    for (const d of list) await takeDose(pid, d, "reminder");
    if (list.length) toast("Marked taken from the reminder");
  } catch (err) { toast(err.message || String(err)); }
  if (!S.editing) render();
}
let actionRun = Promise.resolve();
function runQueuedReminderActions() {
  if (!S.pid || !S.snaps[S.pid]) return;
  for (const a of queuedActions.splice(0)) actionRun = actionRun.then(() => onReminderAction(a));
}
function wirePatients() {
  listUnsub && listUnsub();
  listUnsub = S.store.listPatients(list => {
    S.patients = list;
    for (const p of list) if (!watchers.has(p.id)) watchers.set(p.id, S.store.watchPatient(p.id, d => onSnap(p.id, d)));
    for (const [id, un] of watchers) if (!list.find(p => p.id === id)) { un(); watchers.delete(id); delete S.snaps[id]; }
    if (!isCare()) { S.pid = list[0]?.id || null; runQueuedReminderActions(); }
    render();
  });
}
async function afterLogin() {
  wirePatients();
  // Permission check must never block the first paint (native plugin awaits can hang).
  try { S.perm = await N.reminderPermission(); } catch (e) { S.perm = "unsupported"; }
  if (!S.editing) render();
}

async function boot() {
  try { S.role = await N.detectRole(); } catch (e) { S.role = "patient"; }
  document.title = isCare() ? "Pillbox Care" : "Pillbox";
  document.documentElement.dataset.role = S.role;
  S.store = makeStore(S.role);
  window.addEventListener("hashchange", route);
  $app.innerHTML = `<p class="muted" style="padding-top:40px">Loading…</p>`;
  try { S.user = await S.store.init(); } catch (e) { $app.innerHTML = `<div class="banner dup">Couldn't start: ${esc(e.message)}</div>`; return; }
  // Paint the UI before any alarm/permission/native work. A hung Capacitor call must not
  // leave the app stuck on "Loading…".
  if (S.user) wirePatients();
  else render();
  route();
  N.setupNotifications(onReminderAction).catch(() => {});
  if (S.user) {
    N.reminderPermission().then(p => { S.perm = p; if (!S.editing) render(); }).catch(() => { S.perm = "unsupported"; if (!S.editing) render(); });
  }
  setInterval(() => { checkMissed(); if (!S.editing && !document.querySelector("input:focus")) render(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !S.editing) render(); });
  window.Pillbox = { lidOpened, state: S };
}
boot();
