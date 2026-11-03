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
async function takeDose(pid, d, source = "app") {
  const p = snap(pid);
  const existing = p.doses[d.key];
  if (existing && existing.status === "taken") { showAlert("dup", "Already taken at " + fmtClock(existing.at) + "."); return false; }
  await S.store.setDose(pid, d.key, { medId: d.med.id, day: d.day, time: d.time, status: "taken", at: new Date().toISOString(), source, by: S.role, byName: S.user?.name || "" });
  if (!existing) await S.store.adjustStock(pid, d.med.id, -M.pillsPerDose(d.med), stockEv("taken"));
  return true;
}
async function skipDose(pid, d) {
  const was = snap(pid).doses[d.key];
  await S.store.setDose(pid, d.key, { medId: d.med.id, day: d.day, time: d.time, status: "skipped", at: new Date().toISOString(), source: "app", by: S.role, byName: S.user?.name || "" });
  if (was && was.status === "taken") await S.store.adjustStock(pid, d.med.id, M.pillsPerDose(d.med), stockEv("undo"));
}
async function undoDose(pid, key) {
  const was = snap(pid).doses[key]; if (!was) return;
  await S.store.clearDose(pid, key);
  if (was.status === "taken") { const med = snap(pid).meds.find(m => m.id === was.medId); if (med) await S.store.adjustStock(pid, med.id, M.pillsPerDose(med), stockEv("undo")); }
}
async function takeExtra(pid, med, force = false) {
  const last = M.lastTaken(med.id, snap(pid).doses);
  if (!force && last && Date.now() - new Date(last.at).getTime() < 2 * 3600000) {
    S.alert = { kind: "dup", text: "You took " + med.name + " at " + fmtClock(last.at) + ", less than 2 hours ago.", force: med.id }; render(); return;
  }
  const now = new Date();
  await S.store.setDose(pid, "extra_" + med.id + "_" + now.getTime(), { medId: med.id, day: dayKey(now), time: M.hm(now), status: "taken", at: now.toISOString(), source: "app", by: S.role, byName: S.user?.name || "", extra: true });
  await S.store.adjustStock(pid, med.id, -M.pillsPerDose(med), stockEv("taken", "extra dose"));
  toast(med.name + " logged");
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
  el.innerHTML = esc(text) + (undo ? ` <button class="btn-sm btn-quiet toast-undo" data-act="undo" data-key="${undo}">Undo</button>` : "");
  el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), undo ? 6000 : 3200);
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
  return `<div class="pack">` + list.map(d => `<button class="well ${d.status}" data-act="well" data-pid="${pid}" data-key="${d.key}" aria-label="${esc(d.med.name)} at ${fmtTime(d.time)}, ${d.status}">
    <span class="pill" aria-hidden="true"></span>
    <span class="time">${fmtTime(d.time)}</span><span class="name">${esc(d.med.name)}</span><span class="dose">${esc(d.med.strength)} · ${esc(d.med.perDose)}</span>
    <span class="chip ${d.status}">${d.log && d.status === "taken" ? "Taken " + fmtClock(d.log.at) : d.status === "upcoming" || d.status === "due" || d.status === "missed" ? (isCare() ? d.status : "Tap when taken") : d.status}</span>
    ${d.log && d.log.by === "caregiver" && !isCare() ? `<span class="muted small">by ${esc(d.log.byName || "caregiver")}</span>` : ""}
    ${d.log && d.log.by === "patient" && isCare() && d.log.source === "pillbox" ? `<span class="muted small">from pillbox</span>` : ""}</button>`).join("") + `</div>`;
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
      <span class="take-meds">${group.map(d => esc(d.med.name) + " " + esc(d.med.strength)).join(" · ")}</span></button>`;
  } else {
    h += `<section class="next"><div class="row spread"><div><div class="eyebrow">Next dose</div>${upcoming ? `<div class="big time">${fmtTime(upcoming.time)}</div><div><strong>${esc(upcoming.med.name)}</strong> ${esc(upcoming.med.strength)}</div><div class="muted">in ${M.rel(upcoming.when - now)}</div>` : `<div class="big">All done</div><div class="muted">${list.length ? "No more doses today." : "No scheduled doses."}</div>`}</div>
      <div style="text-align:right"><div class="eyebrow">Taken</div><div class="big mono">${taken}/${list.length}</div></div></div></section>`;
  }
  h += `<section class="stack"><h2>Today's doses</h2>`;
  h += list.length ? wells(pid, list) : `<p class="muted">${isCare() ? "No scheduled doses today." : "Add a medicine with times and it shows up here."}</p>`;
  h += `</section>`;
  const prn = p.meds.filter(m => !(m.times || []).length);
  if (prn.length) h += `<section class="stack"><h2>As needed</h2><div class="list">` + prn.map(m => { const l = M.lastTaken(m.id, p.doses); return `<div class="item"><div><strong>${esc(m.name)}</strong> ${esc(m.strength)}<div class="muted">${l ? "Last taken " + fmtClock(l.at) + (l.day === dayKey(now) ? " today" : " on " + M.parseDay(l.day).toLocaleDateString()) : "Not taken yet"}</div></div><button class="btn-sm" data-act="take-prn" data-pid="${pid}" data-med="${m.id}">Log dose</button></div>`; }).join("") + `</div></section>`;
  const low = M.lowStock(p.meds);
  if (low.length) h += `<div class="banner dup"><div><strong>Refill soon:</strong> ${low.map(m => esc(m.name) + " (" + m.stock + " left)").join(", ")}</div></div>`;
  return h;
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
    <h2>${selDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</h2>
    ${sum.list.length || extras.length ? `<div class="list">` + sum.list.map(d => `<div class="item"><div><strong>${fmtTime(d.time)}</strong> ${esc(d.med.name)} <span class="chip ${d.status}">${d.status}</span><div class="muted">${d.log ? (d.log.status === "taken" ? "Taken" : "Skipped") + " at " + fmtClock(d.log.at) + (d.log.by === "caregiver" ? " by " + esc(d.log.byName || "caregiver") : "") + (d.log.source === "pillbox" ? " · pillbox" : "") : ""}</div></div>
      ${d.log ? `<button class="btn-sm" data-act="undo" data-pid="${pid}" data-key="${d.key}">Undo</button>` : d.status !== "upcoming" ? `<button class="btn-sm btn-primary" data-act="take-key" data-pid="${pid}" data-key="${d.key}" data-day="${d.day}">Mark taken</button>` : ""}</div>`).join("")
      + extras.map(([, v]) => { const med = p.meds.find(x => x.id === v.medId); return `<div class="item"><div><strong>${fmtClock(v.at)}</strong> ${esc(med ? med.name : "Medicine")} <span class="chip taken">extra</span></div></div>`; }).join("") + `</div>` : `<p class="muted">Nothing scheduled.</p>`}
  </section>`;
}

const REASON = { taken: "Dose taken", undo: "Dose undone", refill: "Refill", adjust: "Count corrected", start: "Starting count" };
const fmtDate = d => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
function supplyLine(m) {
  const s = M.supply(m);
  if (s.left == null) return `<span class="muted">Pill count not set</span>`;
  const days = s.daysLeft != null ? ` · about ${s.daysLeft} ${s.daysLeft === 1 ? "day" : "days"}, runs out ${fmtDate(s.runOut)}` : "";
  return `<span class="${s.low ? "stock-low" : "muted"}">${s.out ? "Out of pills" : s.left + " left"}${days}${s.low && !s.out ? " · refill soon" : ""}</span>`;
}
function supplyBar(m) {
  const s = M.supply(m); if (s.left == null) return "";
  const full = Math.max(m.fullCount || 0, s.left, 1), pct = Math.round(s.left / full * 100);
  return `<div class="meter ${s.low ? "low" : ""}" role="img" aria-label="${s.left} of ${full} pills left"><i style="width:${pct}%"></i></div>`;
}
function medsBlock(pid) {
  const p = snap(pid);
  if (S.editing) return medForm();
  if (S.medDetail) { const m = p.meds.find(x => x.id === S.medDetail); if (m) return medDetail(pid, m); S.medDetail = null; }
  const low = M.lowStock(p.meds);
  return (low.length ? `<div class="banner dup"><div><strong>Refill soon:</strong> ${low.map(m => esc(m.name)).join(", ")}</div></div>` : "") +
    `<div class="list">` + (p.meds.length ? p.meds.map(m => `<button class="item item-btn" data-act="med-open" data-med="${m.id}"><div class="row" style="flex-wrap:nowrap;min-width:0;width:100%"><span class="swatch" style="background:${esc(m.color)}"></span><div class="stack-tight" style="min-width:0;flex:1"><div><strong>${esc(m.name)}</strong> ${esc(m.strength)}</div>
     <div class="muted">${esc(m.perDose)} · ${(m.times || []).length ? m.times.map(fmtTime).join(", ") : "as needed"}</div>
     ${supplyBar(m)}<div>${supplyLine(m)}</div></div><span class="chev" aria-hidden="true">›</span></div></button>`).join("") : `<div class="item muted">No medicines yet.</div>`) + `</div>
    <div class="row"><button class="btn-primary" data-act="new">Add medicine</button></div>`;
}
function medDetail(pid, m) {
  const p = snap(pid), s = M.supply(m);
  const log = (p.stockLog || []).filter(e => e.medId === m.id).slice().reverse().slice(0, 40);
  const st = S.stockForm;
  return `<div class="row spread"><button class="btn-sm" data-act="med-close">‹ All medicines</button><button class="btn-sm" data-act="edit" data-med="${m.id}">Edit</button></div>
   <section class="sheet stack"><div><div class="eyebrow">${esc(m.strength)} · ${esc(m.perDose)}</div><h2>${esc(m.name)}</h2>
     ${m.prescribedBy ? `<div class="muted">Prescribed by ${esc(m.prescribedBy)}</div>` : ""}
     ${m.updatedByName ? `<div class="muted small">Last changed by ${esc(m.updatedByName)}${m.updatedByRole === "caregiver" ? " (care team)" : ""}${m.updatedAt ? " on " + fmtDate(new Date(m.updatedAt)) : ""}</div>` : ""}</div>
     <div class="supply-grid">
       <div><div class="eyebrow">Pills left</div><div class="big mono">${s.left ?? "–"}</div></div>
       <div><div class="eyebrow">Per day</div><div class="big mono">${s.daily || "–"}</div></div>
       <div><div class="eyebrow">Days left</div><div class="big mono ${s.low ? "stock-low" : ""}">${s.daysLeft ?? "–"}</div></div>
     </div>
     ${supplyBar(m)}
     <div>${s.runOut ? `Runs out around <strong>${fmtDate(s.runOut)}</strong>.` : s.left == null ? "Set a pill count to start tracking." : "As-needed medicine, so there's no run-out date."} ${s.low ? `<span class="stock-low">Time to refill.</span>` : ""}</div>
     ${st ? `<form class="stack" id="stockform"><div class="field"><label for="s-n">${st.mode === "refill" ? "Pills added" : "Pills you have now"}</label><input id="s-n" name="n" type="number" min="0" inputmode="numeric" required value="${st.mode === "refill" ? (m.fullCount || 30) : (s.left ?? "")}"></div>
         <div class="field"><label for="s-note">Note (optional)</label><input id="s-note" name="note" placeholder="${st.mode === "refill" ? "e.g. CVS pickup, Rx #1234" : "e.g. Dropped two"}"></div>
         <div class="row"><button class="btn-primary" type="submit">${st.mode === "refill" ? "Add refill" : "Save count"}</button><button type="button" data-act="stock-cancel">Cancel</button></div></form>`
       : `<div class="row"><button class="btn-primary" data-act="stock-refill">Add refill</button><button data-act="stock-adjust">Correct count</button></div>`}
   </section>
   <section class="stack"><h2>Pill history</h2>
     ${log.length ? `<div class="list">` + log.map(e => `<div class="item"><div style="min-width:0"><strong>${esc(REASON[e.reason] || "Change")}</strong>${e.note ? ` <span class="muted">· ${esc(e.note)}</span>` : ""}
       <div class="muted small">${fmtDate(new Date(e.at))} at ${fmtClock(e.at)}${e.byName ? " · " + esc(e.byName) : ""}${e.by === "caregiver" ? " (care team)" : ""}</div></div>
       <div class="mono delta ${e.delta > 0 ? "plus" : ""}">${e.delta > 0 ? "+" : ""}${e.delta}${e.after != null ? `<div class="muted small">${e.after} left</div>` : ""}</div></div>`).join("") + `</div>`
       : `<p class="muted">Every dose, refill and correction will be listed here.</p>`}
   </section>`;
}
function medForm() {
  const m = S.editing;
  return `<form class="sheet stack" id="medform"><h2>${m.isNew ? "Add medicine" : "Edit medicine"}</h2>
   <div class="field"><label for="f-name">Name</label><input id="f-name" name="name" required value="${esc(m.name)}" placeholder="e.g. Amoxicillin"></div>
   <div class="grid2"><div class="field"><label for="f-strength">Strength</label><input id="f-strength" name="strength" value="${esc(m.strength)}" placeholder="e.g. 250 mg"></div>
   <div class="field"><label for="f-per">Each dose</label><input id="f-per" name="perDose" value="${esc(m.perDose)}" placeholder="e.g. 2 capsules"></div></div>
   <div class="field"><label>Times each day</label><div class="times" id="f-times">${(m.times || []).map((t, i) => `<span class="t"><input type="time" id="f-time-${i}" value="${t}" aria-label="Dose time ${i + 1}"><button type="button" class="btn-quiet btn-sm" data-act="rmtime" data-i="${i}" aria-label="Remove time">✕</button></span>`).join("")}
     <button type="button" class="btn-sm" data-act="addtime">Add time</button></div><div class="muted">Leave empty for as-needed medicine.</div></div>
   <div class="grid2"><div class="field"><label for="f-start">Start date</label><input id="f-start" name="start" type="date" value="${esc(m.start || "")}"></div>
   <div class="field"><label for="f-end">End date (optional)</label><input id="f-end" name="end" type="date" value="${esc(m.end || "")}"></div></div>
   <div class="grid2"><div class="field"><label for="f-ppd">Pills per dose</label><input id="f-ppd" name="pillsPerDose" type="number" min="0.5" step="0.5" inputmode="decimal" value="${m.pillsPerDose ?? M.pillsPerDose(m)}"></div>
   <div class="field"><label for="f-full">Pills in a full bottle</label><input id="f-full" name="fullCount" type="number" min="0" inputmode="numeric" value="${m.fullCount ?? ""}" placeholder="e.g. 30"></div></div>
   ${m.isNew ? `<div class="field"><label for="f-stock">Pills you have now</label><input id="f-stock" name="stock" type="number" min="0" inputmode="numeric" value="${m.stock ?? ""}"></div>` : `<div class="muted">To change the pill count, use Add refill or Correct count on the medicine's page, so the history stays right.</div>`}
   <div class="grid2"><div class="field"><label for="f-refilld">Warn when this many days are left</label><input id="f-refilld" name="refillDays" type="number" min="0" inputmode="numeric" value="${m.refillDays ?? 7}"></div>
   <div class="field"><label for="f-refill">Or this many pills</label><input id="f-refill" name="refillAt" type="number" min="0" inputmode="numeric" value="${m.refillAt ?? 5}"></div></div>
   <div class="field"><label for="f-rx">Prescribed by (optional)</label><input id="f-rx" name="prescribedBy" value="${esc(m.prescribedBy || "")}" placeholder="e.g. Dr. Patel"></div>
   <div class="field"><label for="f-slot">Pillbox compartment</label><select id="f-slot" name="slot"><option value="">None</option>${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<option value="${n}" ${Number(m.slot) === n ? "selected" : ""}>${n}</option>`).join("")}</select></div>
   <div class="field"><label for="f-notes">Notes</label><input id="f-notes" name="notes" value="${esc(m.notes)}" placeholder="e.g. Take with food"></div>
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
function sheetView() {
  if (!S.sheet) return "";
  const { pid, key } = S.sheet, p = snap(pid);
  const d = M.dosesOn(M.parseDay(key.split("_")[1]), p.meds, p.doses, opts()).find(x => x.key === key);
  if (!d) { S.sheet = null; return ""; }
  return `<div class="overlay" data-act="close-sheet"><div class="panel" role="dialog" aria-label="Dose details">
    <div class="eyebrow">${fmtTime(d.time)} dose</div><h2>${esc(d.med.name)} ${esc(d.med.strength)}</h2><div class="muted">${esc(d.med.perDose)}${d.med.notes ? " · " + esc(d.med.notes) : ""}</div>
    ${d.log ? `<p>${d.log.status === "taken" ? "Taken" : "Skipped"} at ${fmtClock(d.log.at)}${d.log.byName && d.log.by === "caregiver" ? " by " + esc(d.log.byName) : ""}${d.log.source === "pillbox" ? " (pillbox)" : ""}.</p><button data-act="undo" data-pid="${pid}" data-key="${d.key}">Undo</button>`
      : `<button class="btn-primary" data-act="take-key" data-pid="${pid}" data-key="${d.key}" data-day="${d.day}">Mark taken</button><button data-act="skip" data-pid="${pid}" data-key="${d.key}">Skip this dose</button>`}
    <button class="btn-quiet" data-act="close-sheet">Close</button></div></div>`;
}
function route() {
  const h = location.hash.slice(1), valid = NAV[S.role].map(x => x[0]);
  S.view = valid.includes(h) ? h : valid[0];
  if (isCare() && S.view !== "patients") S.pid = null;
  S.editing = null; S.sheet = null; S.joinError = ""; S.medDetail = null; S.stockForm = null;
  render(); window.scrollTo(0, 0);
}

function findDose(pid, key) {
  const p = snap(pid);
  return M.dosesOn(M.parseDay(key.split("_")[1]), p.meds, p.doses, opts()).find(x => x.key === key);
}
function readForm() {
  const f = document.getElementById("medform"); if (!f) return;
  const fd = new FormData(f);
  Object.assign(S.editing, {
    name: fd.get("name"), strength: fd.get("strength"), perDose: fd.get("perDose"), notes: fd.get("notes"),
    slot: fd.get("slot") ? Number(fd.get("slot")) : null, start: fd.get("start") || null, end: fd.get("end") || null,
    refillAt: Number(fd.get("refillAt") || 0), refillDays: Number(fd.get("refillDays") || 0),
    pillsPerDose: Number(fd.get("pillsPerDose")) || 1, fullCount: fd.get("fullCount") === "" ? null : Number(fd.get("fullCount")),
    prescribedBy: (fd.get("prescribedBy") || "").trim(),
    ...(fd.has("stock") ? { stock: fd.get("stock") === "" ? null : Number(fd.get("stock")) } : {}),
    times: [...f.querySelectorAll("#f-times input[type=time]")].map(i => i.value).filter(Boolean),
  });
}

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
      case "clear-examples": S.store.clearExamples(); S.snaps = {}; if (!isCare()) S.pid = "me"; break;
      case "cal-prev": S.cal.m--; if (S.cal.m < 0) { S.cal.m = 11; S.cal.y--; } break;
      case "cal-next": S.cal.m++; if (S.cal.m > 11) { S.cal.m = 0; S.cal.y++; } break;
      case "cal-sel": S.cal.sel = el.dataset.day; break;
      case "new": S.editing = { isNew: true, id: M.uid(), name: "", strength: "", perDose: "1 tablet", times: ["08:00"], start: dayKey(new Date()), stock: 30, refillAt: 5, slot: null, notes: "", color: M.COLORS[snap().meds.length % M.COLORS.length] }; break;
      case "edit": S.editing = structuredClone(snap().meds.find(m => m.id === el.dataset.med)); break;
      case "cancel": S.editing = null; break;
      case "med-open": S.medDetail = el.dataset.med; S.stockForm = null; window.scrollTo(0, 0); break;
      case "med-close": S.medDetail = null; S.stockForm = null; break;
      case "stock-refill": S.stockForm = { mode: "refill" }; break;
      case "stock-adjust": S.stockForm = { mode: "adjust" }; break;
      case "stock-cancel": S.stockForm = null; break;
      case "addtime": readForm(); S.editing.times.push(S.editing.times.length ? "20:00" : "08:00"); break;
      case "rmtime": readForm(); S.editing.times.splice(Number(el.dataset.i), 1); break;
      case "delete": readForm(); if (!S.editing.confirmDelete) { S.editing.confirmDelete = true; break; } await S.store.deleteMed(S.pid, S.editing.id); S.editing = null; S.medDetail = null; toast("Medicine deleted"); break;
      case "perm": S.perm = await N.askReminderPermission(); if (!isCare()) await N.scheduleReminders(snap().meds); break;
      case "mkcode": S.link = await S.store.createLinkCode(S.pid); break;
      case "unlink": await S.store.removeCaregiver(S.pid, el.dataset.uid); toast("Removed"); break;
      case "ble": N.connectPillbox(slot => lidOpened(slot, "pillbox"), s => { S.ble = s; render(); }); return;
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
      m.times = [...new Set(m.times)].sort();
      const isNew = m.isNew; delete m.isNew; delete m.confirmDelete;
      for (const other of snap().meds) if (other.id !== m.id && m.slot && Number(other.slot) === m.slot) await S.store.saveMed(S.pid, { ...other, slot: null });
      if (!isNew) { const live = snap().meds.find(x => x.id === m.id); m.stock = live ? live.stock ?? null : m.stock ?? null; }
      Object.assign(m, { updatedByName: S.user?.name || "", updatedByRole: S.role, updatedAt: Date.now() });
      const startCount = isNew && typeof m.stock === "number" ? m.stock : null;
      if (startCount != null) m.stock = 0;
      await S.store.saveMed(S.pid, m);
      if (startCount != null) await S.store.adjustStock(S.pid, m.id, startCount, stockEv("start"));
      S.editing = null; S.medDetail = m.id; toast(isNew ? "Medicine added" : "Saved");
    } else if (f.id === "stockform") {
      const fd = new FormData(f), n = Number(fd.get("n")), note = (fd.get("note") || "").trim();
      const m = snap().meds.find(x => x.id === S.medDetail); if (!m || !(n >= 0)) return;
      if (S.stockForm.mode === "refill") { await S.store.adjustStock(S.pid, m.id, n, stockEv("refill", note)); toast(n + " pills added"); }
      else { if (typeof m.stock !== "number") await S.store.saveMed(S.pid, { ...m, stock: 0 }); await S.store.adjustStock(S.pid, m.id, n - (m.stock || 0), stockEv("adjust", note)); toast("Count saved"); }
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
  if (!isCare()) N.scheduleReminders(data.meds).catch(() => {});
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
async function afterLogin() {
  listUnsub && listUnsub();
  listUnsub = S.store.listPatients(list => {
    S.patients = list;
    for (const p of list) if (!watchers.has(p.id)) watchers.set(p.id, S.store.watchPatient(p.id, d => onSnap(p.id, d)));
    for (const [id, un] of watchers) if (!list.find(p => p.id === id)) { un(); watchers.delete(id); delete S.snaps[id]; }
    if (!isCare()) S.pid = list[0]?.id || null;
    render();
  });
  S.perm = await N.reminderPermission().catch(() => "unsupported");
}

async function boot() {
  S.role = await N.detectRole();
  document.title = isCare() ? "Pillbox Care" : "Pillbox";
  document.documentElement.dataset.role = S.role;
  S.store = makeStore(S.role);
  window.addEventListener("hashchange", route);
  $app.innerHTML = `<p class="muted" style="padding-top:40px">Loading…</p>`;
  try { S.user = await S.store.init(); } catch (e) { $app.innerHTML = `<div class="banner dup">Couldn't start: ${esc(e.message)}</div>`; return; }
  await N.setupNotifications(async ({ action, extra, title, body }) => {
    if (!S.pid) return;
    if (action === "take" && extra.medIds) {
      const p = snap(); const list = M.dosesOn(new Date(), p.meds, p.doses, opts()).filter(d => d.time === extra.time && extra.medIds.includes(d.med.id) && !d.log);
      for (const d of list) await takeDose(S.pid, d, "reminder");
      toast("Marked taken from the reminder");
    } else if (action === "snooze") await N.snooze(title, body, extra);
    render();
  }).catch(() => {});
  if (S.user) await afterLogin();
  route();
  setInterval(() => { checkMissed(); if (!S.editing && !document.querySelector("input:focus")) render(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !S.editing) render(); });
  window.Pillbox = { lidOpened, state: S };
}
boot();
