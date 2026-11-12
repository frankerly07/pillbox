import "./style.css";
import * as M from "./model.js";
import { makeStore, syncStatus } from "./store.js";
import { PERMISSIONS } from "./access.js";
import { CATALOG_NOTICE, applyCatalogChoice } from "./drug-catalog.js";
import { lookupPackageCode, searchDrugNames } from "./rxnav.js";
import * as N from "./native.js";
import { renderSVG } from "uqr";
import { areaAfterTap, bodyMapHtml } from "./body-map.js";

const { esc, fmtTime, fmtClock, dayKey } = M;
const $app = document.getElementById("app");
const $nav = document.getElementById("tabs");

const S = {
  role: "patient", store: null, user: null, profile: null, activeView: "patient", legacyCare: false,
  patients: [], snaps: {}, pid: null, // pid: patient being viewed
  view: "today", sub: "today", onboardStep: "role",
  cal: { y: new Date().getFullYear(), m: new Date().getMonth(), sel: dayKey(new Date()) },
  editing: null, sheet: null, drug: null, alert: null, ble: "Not connected", invite: null, invitePreview: null, auth: { mode: "signin", error: "" },
  settings: loadSettings(), perm: "default",
};
function loadSettings() { try { return { dueWindowMin: 60, ...JSON.parse(localStorage.getItem("pillbox.settings") || "{}") }; } catch (e) { return { dueWindowMin: 60 }; } }
function saveSettings() { try { localStorage.setItem("pillbox.settings", JSON.stringify(S.settings)); } catch (e) {} }
const opts = () => ({ now: Date.now(), dueWindowMin: S.settings.dueWindowMin });
const snap = (pid = S.pid) => S.snaps[pid] || { meds: [], doses: {}, events: {}, name: "" };
// Background redraws (new data, 30 s tick) wait while a form is open, so typing and focus aren't lost.
const busy = () => !!(S.editing || S.sheet);
const isCare = () => S.activeView === "caregiver";
const PKEY = "pillbox.profile";
function readProfile() { try { return JSON.parse(localStorage.getItem(PKEY) || "null"); } catch (e) { return null; } }
function writeProfile(p) { try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) {} }
function chooseView(profile) {
  if (!profile) return "patient";
  let saved = "";
  try { saved = localStorage.getItem("pillbox.activeView") || ""; } catch (e) {}
  if (profile.usePatient && profile.useCaregiver && (saved === "patient" || saved === "caregiver")) return saved;
  return profile.useCaregiver && !profile.usePatient ? "caregiver" : "patient";
}
function setActiveView(view) {
  S.activeView = view === "caregiver" ? "caregiver" : "patient";
  S.role = S.activeView;
  try { localStorage.setItem("pillbox.activeView", S.activeView); } catch (e) {}
  document.documentElement.dataset.role = S.role;
}
// uiRole is a label on the log. It is not sent to access checks.
const actor = () => ({ uid: S.user?.uid || "local", name: S.user?.name || "", uiRole: S.activeView });
function applyUse(usePatient, useCaregiver, recommended, view) {
  const profile = { usePatient: !!usePatient, useCaregiver: !!useCaregiver, recommended: recommended || null, onboarded: true };
  if (!profile.usePatient && !profile.useCaregiver) profile.usePatient = true;
  if (S.store.applyProfile) S.profile = S.store.applyProfile(profile);
  else S.profile = profile;
  writeProfile(S.profile);
  setActiveView(view || (profile.usePatient ? "patient" : "caregiver"));
}

// ---------------- actions ----------------
const stockEv = (reason, note = "") => ({ reason, note, by: S.activeView === "caregiver" ? "caregiver" : "patient", byName: S.user?.name || "", opId: M.uid() });
function doseResultMessage(res, med) {
  const when = res?.at || res?.dose?.at;
  const nm = med ? M.normalizeMed(med) : null;
  const same = nm && res?.dose && Number(res.dose.amount) === nm.doseAmount && res.dose.unit === nm.doseUnit;
  const what = same ? M.doseLabel(med) : (res?.dose?.amount && res?.dose?.unit ? M.qty(res.dose.amount, res.dose.unit) : (med ? M.doseLabel(med) : "treatment"));
  return "Logged " + what + (when ? " at " + fmtClock(when) : "");
}
async function commit(pid, cmd) {
  const res = await S.store.commitDose(pid, { ...cmd, actor: actor(), now: Date.now() });
  if (res.code === "already-logged") {
    const med = snap(pid).meds.find(m => m.id === cmd.medId);
    showAlert("dup", (med?.name || "This treatment") + " is already logged" + (res.at ? " at " + fmtClock(res.at) : "") + ".");
    return null;
  }
  if (!res.ok && res.code !== "replay" && res.code !== "unchanged") throw new Error(res.message || "Couldn't save that.");
  return res;
}
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
  const nm = M.normalizeMed(d.med);
  return commit(pid, {
    opId: M.uid(), kind: "log", medId: d.med.id, key: d.key, extra: false,
    slot: d.slot || d.time, day: d.day, time: d.time, at: when.toISOString(),
    amount: nm.doseAmount, unit: nm.doseUnit, source,
  });
}
async function skipDose(pid, d) {
  return commit(pid, { opId: M.uid(), kind: "skip", medId: d.med.id, key: d.key, day: d.day, time: d.time, slot: d.slot || d.time, at: new Date().toISOString() });
}
async function undoDose(pid, key) {
  const was = snap(pid).doses[key]; if (!was) return null;
  return commit(pid, { opId: M.uid(), kind: "remove", medId: was.medId, key });
}
// An additional log is not a scheduled dose. It does not move reminders.
async function logAdditional(pid, med, when = new Date(), amount, unit, force = false) {
  const last = M.lastTaken(med.id, snap(pid).doses);
  if (!force && last && Date.now() - new Date(last.at).getTime() < 2 * 3600000) {
    S.alert = { kind: "dup", text: "You logged " + med.name + " at " + fmtClock(last.at) + ", less than 2 hours ago. Logging another treatment does not change the prescription.", force: med.id };
    render(); return null;
  }
  const nm = M.normalizeMed(med);
  const res = await commit(pid, {
    opId: M.uid(), kind: "log", medId: med.id, extra: true,
    amount: amount != null && amount !== "" ? Number(amount) : nm.doseAmount, unit: unit || nm.doseUnit,
    at: when.toISOString(), day: dayKey(when), time: M.hm(when), source: "app",
  });
  if (res && res.code === "applied") toast(doseResultMessage(res, med), res.key);
  return res;
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
  await logAdditional(pid, med, new Date(), null, null, true);
}
function showAlert(kind, text) { S.alert = { kind, text }; render(); }
let toastT;
function toast(text, undo) {
  const el = document.getElementById("toast");
  el.innerHTML = esc(text) + (undo ? ` <button class="btn-sm btn-quiet toast-undo" data-act="undo" data-key="${undo}">Undo</button> <button class="btn-sm btn-quiet toast-undo" data-act="edit-time" data-key="${undo}">Edit log</button>` : "");
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
  return `<div class="banner ${S.alert.kind}" role="alert"><div>${esc(S.alert.text)}</div><div class="row">${S.alert.force ? `<button class="btn-sm btn-danger" data-act="force" data-med="${S.alert.force}">Log this treatment</button>` : ""}<button class="btn-sm" data-act="dismiss">OK</button></div></div>`;
}
function exampleBanner() {
  if (!S.store.example) return "";
  if (isCare()) {
    const people = (S.patients || []).some(p => p.id !== "me" && (p.example || String(p.name || "").startsWith("Example:")));
    if (!people) return "";
    return `<div class="banner info"><div><strong>These example people are saved on this phone.</strong> They are not real and not linked to anyone.</div><button class="btn-sm" data-act="clear-examples">Start empty</button></div>`;
  }
  return `<div class="banner info"><div><strong>These are example medicines on this phone.</strong> Replace them with your own.</div><button class="btn-sm" data-act="clear-examples">Start empty</button></div>`;
}
function legacyBanner() {
  if (!S.legacyCare) return "";
  return `<div class="banner info"><div><strong>This is the separate Pillbox Care app.</strong> Its records stay here. Android cannot move them into Pillbox (com.pillbox.patient). Nothing is deleted. Export a backup and import it in Pillbox. That file is not a live link.</div></div>`;
}
function viewSwitch() {
  const p = S.profile;
  if (!p?.usePatient || !p?.useCaregiver) return "";
  return `<div class="seg view-switch" role="tablist" aria-label="Which view"><button type="button" role="tab" aria-selected="${!isCare()}" data-act="switch-view" data-view="patient">My medicines</button><button type="button" role="tab" aria-selected="${isCare()}" data-act="switch-view" data-view="caregiver">People I help</button></div><p class="muted small">Switching views does not share medicines or grant access.</p>`;
}

function wells(pid, list) {
  return `<div class="pack">` + list.map(d => `<button class="well ${d.status}" data-act="well" data-pid="${pid}" data-key="${d.key}" aria-label="${esc(d.med.name)}, ${esc(M.fmtDoseTimes(d))}${d.log ? "" : ", " + d.status}">
    <span class="pill" aria-hidden="true"></span>
    <span class="time">${d.log ? `<span class="sched">Scheduled</span> ` : ""}${fmtTime(d.time)}</span><span class="name"><span aria-hidden="true">${M.typeIcon(d.med)}</span> ${esc(d.med.name)}</span><span class="dose">${d.med.strength ? esc(d.med.strength) + " · " : ""}${esc(M.administrationLabel(d.log, d.med))}</span>
    <span class="chip ${d.status}">${d.log ? M.fmtLogged(d.log, d.day) : d.status === "upcoming" || d.status === "due" || d.status === "missed" ? (isCare() ? d.status : "Log now") : d.status}</span>
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

// ---------------- health events ----------------
// S.sheet = { pid, ev: draft, evId? (editing), confirmDelete?, error? }. The draft keeps the time as a datetime-local
// string (atLocal) and is copied from the form on every input, so redraws don't lose what was typed.
const localInput = d => dayKey(d) + "T" + M.hm(d);
const newEventSheet = pid => ({ pid, ev: { type: null, area: "", severity: null, cause: null, durationMin: "", treatedWith: "", notes: "", atLocal: localInput(new Date()) } });
function editEventSheet(pid, id) {
  const e = (snap(pid).events || {})[id]; if (!e) return null;
  return { pid, evId: id, ev: { ...e, area: e.area || "", durationMin: e.durationMin ?? "", treatedWith: e.treatedWith || "", atLocal: localInput(new Date(e.at)) } };
}
function readEventForm() {
  const f = document.getElementById("evform"); if (!f || !S.sheet?.ev) return;
  const fd = new FormData(f);
  for (const k of ["area", "durationMin", "treatedWith", "notes", "atLocal"]) if (fd.has(k)) S.sheet.ev[k] = fd.get(k);
}
document.addEventListener("input", e => { if (e.target.closest("#evform")) readEventForm(); });
function eventItem(pid, e) {
  const p = snap(pid), t = M.EVENT_TYPES[e.type] || M.EVENT_TYPES.other, dose = e.treatedWith && p.doses[e.treatedWith];
  const who = [e.by === "caregiver" ? "Logged by " + (e.byName || "caregiver") : "", e.editedBy && e.editedByName && e.editedByName !== e.byName ? "edited by " + e.editedByName : ""].filter(Boolean).join(", ");
  return `<button class="item item-btn ev-item ev-${esc(e.type)}" data-act="ev-open" data-pid="${pid}" data-id="${esc(e.id)}"><div class="stack-tight" style="min-width:0;flex:1">
    <div><span aria-hidden="true">${t.icon}</span> <strong>${esc(M.eventLabel(e))}</strong></div>
    <div class="muted small"><span class="mono">${fmtClock(e.at)}</span>${dose ? " · Treated with " + esc(M.doseLinkLabel(dose, p.meds)) : ""}</div>
    ${e.notes ? `<div class="ev-notes">${esc(e.notes)}</div>` : ""}${who ? `<div class="muted small">${esc(who)}</div>` : ""}</div><span class="chev" aria-hidden="true">›</span></button>`;
}
const eventList = (pid, list) => `<div class="list">${list.map(e => eventItem(pid, e)).join("")}</div>`;
function eventSheet() {
  const sh = S.sheet, ev = sh.ev, p = snap(sh.pid), now = new Date();
  if (!ev.type) return `<div class="eyebrow">Log event</div><h2>What happened?</h2>
    <div class="ev-types">${Object.entries(M.EVENT_TYPES).map(([k, t]) => `<button class="ev-type" data-act="ev-type" data-type="${k}"><span aria-hidden="true">${t.icon}</span> ${esc(t.label)}</button>`).join("")}</div>
    <button data-act="close-sheet">Cancel</button>`;
  const toggles = (act, map, sel) => Object.entries(map).map(([k, l]) => `<button type="button" class="tog" data-act="${act}" data-v="${k}" aria-pressed="${String(sel) === k}">${esc(l)}</button>`).join("");
  const links = M.recentDosesForLink(p.meds, p.doses);
  if (ev.treatedWith && !links.some(x => x.key === ev.treatedWith))
    links.push({ key: ev.treatedWith, label: p.doses[ev.treatedWith] ? M.doseLinkLabel(p.doses[ev.treatedWith], p.meds) : "Earlier dose (no longer logged)" });
  return `<form class="stack" id="evform"><div class="eyebrow">${sh.evId ? "Edit event" : "Log event"}</div>
    <div class="opts" role="group" aria-label="Type of event">${Object.entries(M.EVENT_TYPES).map(([k, t]) => `<button type="button" class="tog" data-act="ev-type" data-type="${k}" aria-pressed="${ev.type === k}"><span aria-hidden="true">${t.icon}</span> ${esc(t.label)}</button>`).join("")}</div>
    <div class="field"><div class="lbl" id="ev-where">Where (optional)</div>${bodyMapHtml(ev.area, ev.type === "bleed" ? "bad" : "accent")}
      <label for="ev-area">Or choose from the list</label><select id="ev-area" name="area"><option value="">Not set</option>${Object.entries(M.BODY_AREAS).map(([k, l]) => opt(k, l, ev.area)).join("")}</select></div>
    <div class="field"><div class="lbl" id="ev-sev-l">How bad (optional)</div><div class="opts" role="group" aria-labelledby="ev-sev-l">${toggles("ev-sev", M.SEVERITIES, ev.severity)}</div></div>
    ${ev.type === "bleed" ? `<div class="field"><div class="lbl" id="ev-cause-l">Cause (optional)</div><div class="opts" role="group" aria-labelledby="ev-cause-l">${toggles("ev-cause", M.BLEED_CAUSES, ev.cause)}</div></div>` : ""}
    ${ev.type === "activity" ? `<div class="field"><label for="ev-dur">How long (optional)</label><div class="amount"><input id="ev-dur" name="durationMin" type="number" min="1" max="1440" inputmode="numeric" value="${esc(ev.durationMin)}"><span>minutes</span></div></div>` : ""}
    <div class="field"><label for="ev-tx">Treated with (optional)</label><select id="ev-tx" name="treatedWith"><option value="">Nothing / not yet</option>${links.map(x => opt(x.key, x.label, ev.treatedWith)).join("")}</select>
      ${links.length ? "" : `<div class="muted small">No doses taken in the last 48 hours.</div>`}</div>
    <div class="field"><label for="ev-notes">Notes (optional)</label><textarea id="ev-notes" name="notes" rows="2" placeholder="e.g. Swelling after football">${esc(ev.notes)}</textarea></div>
    <div class="field"><label for="ev-at">When</label><input id="ev-at" name="atLocal" type="datetime-local" required max="${localInput(now)}" value="${esc(ev.atLocal)}"></div>
    ${sh.error ? `<div class="banner dup">${esc(sh.error)}</div>` : ""}
    <div class="row spread"><div class="row"><button class="btn-primary" type="submit">Save</button><button type="button" data-act="close-sheet">Cancel</button></div>
      ${sh.evId ? `<button type="button" class="btn-danger btn-sm" data-act="ev-delete">${sh.confirmDelete ? "Tap again to delete" : "Delete"}</button>` : ""}</div></form>`;
}

function todayBlock(pid) {
  const p = snap(pid), now = new Date(), list = M.dosesOn(now, p.meds, p.doses, opts());
  const dueNow = list.filter(d => (d.status === "due" || d.status === "missed") && !d.log);
  const rest = list.filter(d => !dueNow.includes(d));
  const upcoming = list.find(d => d.status === "upcoming");
  const taken = list.filter(d => d.status === "taken").length;
  let h = "";
  if (dueNow.length) {
    h += `<section class="stack"><h2>${dueNow.some(d => d.status === "missed") ? "Late" : "Due now"}</h2>` + dueNow.map(d => `<div class="due-row"><button class="log-one" data-act="well" data-pid="${pid}" data-key="${d.key}">
      <span class="eyebrow">${d.status === "missed" ? "Late" : "Due now"} · ${fmtTime(d.time)}</span>
      <span class="take-label"><span aria-hidden="true">${M.typeIcon(d.med)}</span> ${esc(d.med.name)}</span>
      <span class="take-meds">Log ${esc(M.doseLabel(d.med))} now</span></button>
      <button class="btn-sm" data-act="open-sheet" data-pid="${pid}" data-key="${d.key}">Other time</button></div>`).join("") + `</section>`;
  } else {
    h += `<section class="next"><div class="row spread"><div><div class="eyebrow">Next dose</div>${upcoming ? `<div class="big time">${fmtTime(upcoming.time)}</div><div><strong>${esc(upcoming.med.name)}</strong> ${esc(upcoming.med.strength)}</div><div class="muted">in ${M.rel(upcoming.when - now)}</div>` : `<div class="big">All done</div><div class="muted">${list.length ? "No more doses today." : "No scheduled doses."}</div>`}</div>
      <div style="text-align:right"><div class="eyebrow">Taken</div><div class="big mono">${taken}/${list.length}</div></div></div></section>`;
  }
  if (!isCare()) h += progressCard(pid);
  const evs = M.eventsOn(now, p.events);
  h += `<section class="stack"><button class="log-event" data-act="ev-new" data-pid="${pid}"><span aria-hidden="true">＋</span> Log event</button>
    ${evs.length ? `<h2>Today's events</h2>${eventList(pid, evs)}` : ""}</section>`;
  h += `<section class="stack"><h2>Today's doses</h2>`;
  h += rest.length ? wells(pid, rest) : (dueNow.length ? "" : `<p class="muted">${isCare() ? "No scheduled doses today." : "Add a medicine with times and it shows up here."}</p>`);
  h += `</section>`;
  const prn = p.meds.filter(M.isPrn);
  if (prn.length) h += `<section class="stack"><h2>As needed</h2><div class="list">` + prn.map(m => { const l = M.lastTaken(m.id, p.doses); return `<div class="item"><div><span aria-hidden="true">${M.typeIcon(m)}</span> <strong>${esc(m.name)}</strong> ${esc(m.strength)} <span class="muted">· ${esc(M.doseLabel(m))}</span><div class="muted">${l ? "Last logged " + fmtClock(l.at) + (l.day === dayKey(now) ? " today" : " on " + M.parseDay(l.day).toLocaleDateString()) : "Nothing logged yet"}</div></div><button class="btn-sm" data-act="take-prn" data-pid="${pid}" data-med="${m.id}">Log treatment</button></div>`; }).join("") + `</div></section>`;
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
    const date = new Date(y, m, d), k = dayKey(date), s = M.daySummary(date, p.meds, p.doses, opts()), ne = M.eventsOn(date, p.events).length;
    cells += `<button class="cal-day ${s.state}${k === sel ? " sel" : ""}${k === todayK ? " today" : ""}" data-act="cal-sel" data-day="${k}" aria-label="${date.toDateString()}: ${s.taken} of ${s.total} taken${ne ? ", " + ne + (ne === 1 ? " event" : " events") : ""}"><span>${d}</span>${s.total && date <= new Date() ? `<i>${s.taken}/${s.total}</i>` : ""}${ne ? `<b class="ev-dot" aria-hidden="true"></b>` : ""}</button>`;
  }
  const selDate = M.parseDay(sel), sum = M.daySummary(selDate, p.meds, p.doses, opts());
  const extras = Object.entries(p.doses).filter(([, v]) => v.extra && v.day === sel), dayEvents = M.eventsOn(selDate, p.events);
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
        <div class="dd-amt">${esc(M.administrationLabel(d.log, d.med))}</div>
        <div class="dd-times"><span>Scheduled <strong class="mono">${fmtTime(d.time)}</strong></span><span>${actualText(d)}</span></div>
        ${d.log && (d.log.by === "caregiver" || d.log.source === "pillbox") ? `<div class="muted small">${d.log.by === "caregiver" ? "Logged by " + esc(d.log.byName || "caregiver") : ""}${d.log.by === "caregiver" && d.log.source === "pillbox" ? " · " : ""}${d.log.source === "pillbox" ? "From pillbox" : ""}</div>` : ""}</div>
      ${d.log ? `<button class="btn-sm" data-act="undo" data-pid="${pid}" data-key="${d.key}">Undo</button>` : d.status !== "upcoming" ? `<button class="btn-sm btn-primary" data-act="open-sheet" data-pid="${pid}" data-key="${d.key}">Log…</button>` : ""}</div>`).join("")
      + extras.map(([k, v]) => { const med = p.meds.find(x => x.id === v.medId); return `<div class="item dd taken"><div class="stack-tight"><div>${med ? `<span aria-hidden="true">${M.typeIcon(med)}</span> ` : ""}<strong>${esc(med ? med.name : "Medicine")}</strong> ${esc(med?.strength || "")} <span class="chip taken">additional</span></div>${med ? `<div class="dd-amt">${esc(M.administrationLabel(v, med))}</div>` : ""}<div class="dd-times"><span>Not a scheduled dose</span><span>Logged <strong class="mono">${fmtClock(v.at)}</strong></span></div></div><button class="btn-sm" data-act="open-sheet" data-pid="${pid}" data-key="${k}">Details</button></div>`; }).join("") + `</div>` : `<p class="muted">Nothing scheduled.</p>`}
    ${dayEvents.length ? `<h3>Events</h3>${eventList(pid, dayEvents)}` : ""}
  </section>`;
}

const REASON = { taken: "Treatment logged", undo: "Supply restored", refill: "Refill", adjust: "Count corrected", start: "Starting count", removed: "Log removed", edit: "Log corrected", additional: "Additional treatment", skip: "Scheduled dose skipped" };
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
     ${m.catalog?.rxcui ? `<div class="muted small">Package name from NIH RxNorm ${esc(m.catalog.rxcui)}${m.catalog.ndc ? " · NDC " + esc(m.catalog.ndc) : ""}. This is not your dose.</div>` : ""}
     ${m.updatedByName ? `<div class="muted small">Last changed by ${esc(m.updatedByName)}${m.updatedByRole === "caregiver" ? " (care team)" : ""}${m.updatedAt ? " on " + fmtDate(new Date(m.updatedAt)) : ""}</div>` : ""}</div>
     <div class="row spread" style="flex-wrap:nowrap"><div><strong>Log actual treatment</strong><div class="muted small">Records what was given. An additional log does not move reminders or change the saved dose. To correct a scheduled dose, open that dose.</div></div><button class="btn-sm" data-act="log-additional" data-pid="${pid}" data-med="${m.id}">Log</button></div>
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
function drugMessage(code) {
  return {
    ambiguous: "More than one medicine matched. Choose the name, strength, and form on your package.",
    "not-found": "Nothing in the NIH list matched. Try another spelling, or type the name and strength yourself.",
    offline: "Couldn't reach the NIH drug list. Check your connection, or type the name and strength yourself.",
    limited: "The drug list is busy. Wait a moment, or type the name yourself.",
    short: "Type at least two letters.",
    unavailable: "The drug list didn't answer. Type the name yourself.",
    invite: "That is a Pillbox connection code, not a medicine package. Connection codes are used under Care team.",
    unmapped: "This barcode is not an NDC package code. A store UPC is not a drug code. Type the medicine name, or the NDC printed on the package.",
    invalid: "Those digits aren't a package code this app can read. Type the name or the NDC.",
    denied: "Camera access is off. Type the numbers under the barcode, or search by name.",
    module: "Android is downloading the on-device scanner. The photo is not uploaded. Try again in a moment, or type the numbers.",
    browser: "Point the camera at the package barcode.",
  }[code] || "";
}
function drugChoices(list) {
  return `<div class="list">${list.map((c, i) => `<button type="button" class="item item-btn" data-act="drug-pick" data-i="${i}"><div class="stack-tight"><strong>${esc(c.name)}</strong><span class="muted small">${esc(c.strength || "Strength not stated")} · ${c.tty === "SBD" ? "Brand" : "Generic"} · RxNorm ${esc(c.rxcui)}</span></div></button>`).join("")}</div>`;
}
function drugPanel() {
  const d = S.drug;
  if (!d) return "";
  if (d.step === "camera") return `<div class="sheet stack"><video id="pkg-video" playsinline autoplay muted style="width:100%;max-height:240px;border-radius:12px;background:#000"></video><p class="muted">Point at the package barcode. This does not scan a connection code. The picture stays on this phone.</p><button type="button" data-act="drug-close">Cancel</button></div>`;
  if (d.step === "review" && d.choice) {
    const c = d.choice;
    return `<div class="sheet stack"><h3>Check this package</h3><p><strong>${esc(c.name)}</strong></p><p>Strength printed for this product: <strong>${esc(c.strength || "not stated")}</strong></p><p class="muted small">${c.tty === "SBD" ? "Brand" : "Generic"} · RxNorm ${esc(c.rxcui)}${c.ndc ? " · NDC " + esc(c.ndc) : ""}</p><p class="muted">Using this fills the name and that strength text only. It does not set how much you take, how often, or convert mg, mL, and units.</p><div class="row"><button type="button" class="btn-primary" data-act="drug-use">Use this name</button><button type="button" data-act="drug-back">Back</button></div></div>`;
  }
  if (d.step === "code" || d.step === "results") return `<div class="sheet stack"><div class="field"><label for="drug-code">Numbers under the barcode</label><input id="drug-code" value="${esc(d.code || "")}" autocomplete="off"></div>${d.message ? `<p>${esc(d.message)}</p>` : ""}${d.choices?.length ? drugChoices(d.choices) : ""}<div class="row"><button type="button" class="btn-primary" data-act="drug-code-go">Look up</button><button type="button" data-act="drug-open">Search by name</button><button type="button" data-act="drug-close">Close</button></div></div>`;
  return `<div class="sheet stack"><div class="field"><label for="drug-q">Drug name</label><input id="drug-q" value="${esc(d.query || "")}" placeholder="e.g. lisinopril"></div><p class="muted small">${esc(CATALOG_NOTICE)}</p>${d.message ? `<p>${esc(d.message)}</p>` : ""}${d.choices?.length ? drugChoices(d.choices) : ""}<div class="row"><button type="button" class="btn-primary" data-act="drug-search">Search</button><button type="button" data-act="drug-close">Close</button></div></div>`;
}
async function lookupCode(text) {
  S.drug = { step: "code", code: text, message: "Looking up…", choices: [] };
  render();
  const res = await lookupPackageCode(text);
  if (!S.drug) return;
  const choices = res.choices || [];
  S.drug = { step: choices.length ? "results" : "code", code: text, choices, message: choices.length ? drugMessage(res.code) : drugMessage(res.code) };
}
async function beginPackageScan() {
  readForm();
  const support = N.packageScanSupport();
  if (support === "manual") { S.drug = { step: "code", message: "This browser can't open a camera scanner. Type the numbers under the barcode, or search by name.", choices: [] }; return; }
  if (support === "browser") {
    S.drug = { step: "camera", message: "" };
    render();
    const video = document.getElementById("pkg-video");
    const res = video ? await N.startBrowserScan(video) : { ok: false, code: "unavailable" };
    if (!S.drug || S.drug.step !== "camera") return;
    if (!res.ok) { if (res.code !== "cancelled") S.drug = { step: "code", message: drugMessage(res.code) || "Couldn't scan. Type the numbers instead.", choices: [] }; else S.drug = null; return; }
    await lookupCode(res.text);
    return;
  }
  const res = await N.scanPackageBarcode();
  if (!S.editing) return;
  if (!res.ok) { if (res.code !== "cancelled") S.drug = { step: "code", message: drugMessage(res.code) || "Couldn't scan. Type the numbers instead.", choices: [] }; return; }
  await lookupCode(res.text);
}
function medForm() {
  const m = S.editing, T = M.TYPES[m.type], sc = m.schedule, pill = m.type === "pill", u = m.supplyUnit;
  const container = M.CONTAINERS.includes(u), everyN = sc.kind === "everyNDays" || sc.kind === "everyNWeeks";
  const fixedToggle = `<label class="opt"><input type="checkbox" name="fixed" ${sc.fixed ? "checked" : ""}><span>Keep fixed schedule</span></label><div class="muted">${sc.fixed ? "Always on the set days and times, however late a dose is taken." : "The next dose is due one interval after the last one was actually taken (taken Tuesday 9:30 AM → next due a week later at 9:30 AM). Until the first dose, the set days and times are used."}</div>`;
  let freq = "";
  if (sc.kind === "weekdays") freq = `<div class="opts" role="group" aria-label="Days of the week">${WEEKDAYS.map((d, i) => `<label class="opt"><input type="checkbox" name="days" value="${i}" ${(sc.days || []).map(Number).includes(i) ? "checked" : ""}><span>${d}</span></label>`).join("")}</div>`;
  else if (everyN) freq = `<div class="amount"><span>Every</span><input name="n" type="number" min="1" max="365" inputmode="numeric" required value="${sc.n || 2}" aria-label="Repeat every"><span>${sc.kind === "everyNDays" ? "days" : "weeks"}</span></div><div class="muted">Counts from the start date.</div>${fixedToggle}`;
  else if (sc.kind === "monthly") freq = `<div class="amount"><span>On day</span><input name="dayOfMonth" type="number" min="1" max="31" inputmode="numeric" required value="${sc.dayOfMonth || (m.start ? M.parseDay(m.start).getDate() : new Date().getDate())}" aria-label="Day of the month"><span>of each month</span></div><div class="muted">In shorter months, the last day.</div>${fixedToggle}`;
  else if (sc.kind === "prn") freq = `<div class="muted">No reminders or missed-dose alerts. Log a treatment on the Today screen when it happens.</div>`;
  return `<form class="sheet stack" id="medform"><h2>${m.isNew ? "Add medicine" : "Edit medicine"}</h2>
   ${drugPanel()}
   <div class="row"><button type="button" data-act="drug-open">Search drug list</button><button type="button" data-act="drug-scan">Scan package</button></div>
   <p class="muted small">${esc(CATALOG_NOTICE)}</p>
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
    case "calendar": return header("Calendar", "Your doses by day") + `<div class="stack">${viewSwitch()}${calendarBlock(pid)}</div>`;
    case "meds": return header("Medicines", p.meds.length + " on your list") + `<div class="stack">${viewSwitch()}${exampleBanner()}${medsBlock(pid)}</div>`;
    case "more": return header("More", "Pillbox, care team and settings") + `<div class="stack">${viewSwitch()}${legacyBanner()}
      ${careTeamBlock(pid, p)}
      <section class="sheet stack"><h2>Pillbox</h2>
        <div class="row spread"><div><strong>Bluetooth pillbox</strong><div class="muted">${esc(S.ble)}</div></div><button class="btn-sm btn-primary" data-act="ble">Connect</button></div>
        <p class="muted">No pillbox yet? Tap a compartment to test what happens when its lid opens.</p>
        ${p.meds.filter(m => m.slot).length ? `<div class="pack">` + p.meds.filter(m => m.slot).sort((a, b) => a.slot - b.slot).map(m => `<button class="well" data-act="sim" data-slot="${m.slot}"><span class="time">Compartment ${esc(m.slot)}</span><span class="name">${esc(m.name)}</span><span class="dose">Open lid</span></button>`).join("") + `</div>` : `<p class="muted">Assign a compartment to a medicine first.</p>`}
      </section>
      <section class="sheet stack"><h2>Settings</h2>${settingsExtras()}${remindersCard()}${accountCard()}</section></div>`;
    default: return header("Today", now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })) + `<div class="stack">${viewSwitch()}${legacyBanner()}${alertBanner()}${exampleBanner()}${todayBlock(pid)}</div>`;
  }
}

function accessRows(p) {
  const ids = [...new Set([...(p.caregiverUids || []), ...(p.caregivers || []), ...Object.keys(p.access || {})])];
  if (!ids.length) return "";
  return `<div class="list">${ids.map(c => {
    const entry = (p.access || {})[c];
    const name = entry?.name || (p.caregiverNames || {})[c] || "Caregiver";
    const perm = PERMISSIONS[entry?.permission] || (entry ? entry.permission : "Linked");
    return `<div class="item"><div><strong>${esc(name)}</strong><div class="muted small">${esc(perm)}</div></div><button class="btn-sm btn-danger" data-act="unlink" data-uid="${c}">Remove</button></div>`;
  }).join("")}</div>`;
}
function qrBlock(payload) {
  if (!payload || !String(payload).startsWith("pillbox:invite:v1:")) return "";
  try {
    const svg = renderSVG(payload, { pixelSize: 6, border: 2, ecc: "M" });
    return svg.includes("<svg") ? `<div class="qr" aria-hidden="true">${svg}</div>` : "";
  } catch (e) { return ""; }
}
function careTeamBlock(pid, p) {
  const status = syncStatus(S.store);
  const linked = accessRows(p);
  let invite = "";
  if (S.store.mode === "cloud" && S.invite?.inviteCode) {
    const exp = new Date(S.invite.expiresAt);
    invite = `${qrBlock(S.invite.payload)}<div class="code">${esc(S.invite.inviteCode)}</div>
      <p>This connects someone to <strong>${esc(S.invite.patientName || p.name || "you")}</strong> as <strong>${esc(S.invite.permissionLabel || "")}</strong>. It expires ${esc(exp.toLocaleString())}. The code has no medicines or health details. It works once.</p>
      <button class="btn-sm" data-act="invite-clear">Done</button>`;
  } else if (S.store.mode === "cloud") {
    invite = `<p>Choose what they can do, then share the code. They will see your name before it connects. You can remove them later.</p>
      <div class="row"><button class="btn-primary" data-act="invite-perm" data-perm="read">View only</button><button data-act="invite-perm" data-perm="logEdit">Can log and edit</button></div>`;
  }
  return `<section class="sheet stack"><h2>Care team</h2><div class="banner info"><div><strong>${esc(status.title)}</strong> ${esc(status.detail)}</div></div>
    ${linked}${invite}</section>`;
}
function settingsExtras() {
  const p = S.profile || {};
  const rec = p.recommended === "yes" ? "Yes" : p.recommended === "no" ? "No" : p.recommended === "skip" ? "Skipped" : "Not answered";
  return `<div class="stack-tight"><strong>How you use Pillbox</strong>
    <div class="muted small">This only changes the screens on this phone. It does not grant access to anyone's medicines.</div>
    <div class="row"><button class="btn-sm ${p.usePatient ? "btn-primary" : ""}" data-act="role-toggle" data-mode="patient" aria-pressed="${!!p.usePatient}">I take medicines</button>
    <button class="btn-sm ${p.useCaregiver ? "btn-primary" : ""}" data-act="role-toggle" data-mode="caregiver" aria-pressed="${!!p.useCaregiver}">I help someone</button></div>
    <div class="muted small">Healthcare professional recommended this app? ${esc(rec)}. That answer is not used for access and is not a medical recommendation.</div>
    <div class="row"><button class="btn-sm" data-act="export-backup">Export backup</button><button class="btn-sm" data-act="import-backup">Import backup</button></div>
    <div class="muted small">A backup is a file you keep. Importing it on this phone does not link another person.</div></div>`;
}

// ---------------- caregiver app ----------------
function caregiverView() {
  if (S.view === "settings") return header("Settings", "People you help") + `<div class="stack">${viewSwitch()}${legacyBanner()}<section class="sheet stack">${settingsExtras()}${remindersCard()}${accountCard()}</section></div>`;
  if (S.view === "link") return header("Connect", "With a code they give you") + `<div class="stack">${viewSwitch()}${legacyBanner()}${joinBlock()}</div>`;
  if (S.pid && S.snaps[S.pid]) {
    const p = snap(), tabs = [["today", "Today"], ["calendar", "Calendar"], ["meds", "Medicines"]];
    let body = S.sub === "calendar" ? calendarBlock(S.pid) : S.sub === "meds" ? medsBlock(S.pid) : todayBlock(S.pid);
    return header(p.name, "Patient", `<button class="btn-sm" data-act="back">All patients</button>`) + `<div class="stack">${alertBanner()}
      <div class="seg" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${S.sub === k}" data-act="sub" data-sub="${k}">${l}</button>`).join("")}</div>${body}</div>`;
  }
  // Own medicines stay in My medicines. This list is only people connected, or records imported onto this phone.
  const people = S.patients.filter(pt => pt.id !== "me");
  const cards = people.map(pt => {
    const p = S.snaps[pt.id]; if (!p) return `<div class="pcard"><strong>${esc(pt.name)}</strong><div class="muted">Loading…</div></div>`;
    const st = M.patientStatus(p.meds, p.doses, Date.now()), ad = M.adherence(p.meds, p.doses, 7), ne = M.eventsOn(new Date(), p.events).length;
    const msg = st.missed.length ? st.missed.map(d => d.med.name + " " + fmtTime(d.time)).join(", ") + " not taken" : st.due.length ? st.due.map(d => d.med.name).join(", ") + " due now" : st.total ? "On track today" : "Nothing scheduled today";
    const local = S.store.mode !== "cloud" || pt.localOnly ? `<div class="muted small">On this phone only. Not a synced link.</div>` : "";
    return `<button class="pcard ${st.level}" data-act="open" data-pid="${pt.id}">
      <div class="row spread" style="flex-wrap:nowrap"><strong class="pname">${esc(p.name)}</strong><span class="chip ${st.level === "ok" ? "taken" : st.level}">${st.level === "ok" ? "OK" : st.level}</span></div>
      <div>${esc(msg)}</div>${local}
      <div class="row muted small"><span>Today ${st.taken}/${st.total}</span><span>7-day ${ad.pct ?? "–"}${ad.pct != null ? "%" : ""}</span>${ne ? `<span>${ne} ${ne === 1 ? "event" : "events"} today</span>` : ""}${st.low.length ? `<span class="stock-low">Refill: ${st.low.map(m => esc(m.name)).join(", ")}</span>` : ""}</div></button>`;
  }).join("");
  const cardsForPeople = cards;
  return header("People", new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })) + `<div class="stack">${viewSwitch()}${legacyBanner()}${alertBanner()}${exampleBanner()}
    ${people.length ? `<div class="stack">${cardsForPeople}</div>` : `<div class="sheet"><h2>No one connected</h2><p class="muted">${S.store.mode === "cloud" ? "When someone creates a code, you can enter it here. You'll see their name before it connects." : "People you help show up here only after a real link. Sync isn't set up, so this phone can't connect to another phone."}</p></div>`}
    <div class="row"><button class="btn-primary" data-act="go-link">Enter a code</button></div></div>`;
}
function joinBlock() {
  const status = syncStatus(S.store);
  if (S.store.mode !== "cloud") {
    return `<section class="sheet stack"><div class="banner info"><div><strong>${esc(status.title)}</strong> ${esc(status.detail)}</div></div>
      <p>Ask them to open Pillbox, go to <strong>More › Care team</strong>, and create a code after sync is set up. Typing a code here would not connect you, so there is no box for one.</p></section>`;
  }
  const preview = S.invitePreview;
  return `<form class="sheet stack" id="joinform"><div class="banner info"><div><strong>${esc(status.title)}</strong> ${esc(status.detail)}</div></div>
    <p>Enter their code, or the text from the QR. You'll see who it is before anything connects.</p>
    <div class="field"><label for="j-code">Code</label><input id="j-code" name="code" autocomplete="off" required placeholder="ABCD-EFGH-JKLM-NPQR" value="${esc(preview?.codeText || "")}"></div>
    ${preview ? `<div class="banner info"><div>This code connects you to <strong>${esc(preview.patientName)}</strong> as <strong>${esc(preview.permissionLabel || PERMISSIONS[preview.permission] || "")}</strong>. It does not include their medicines.</div></div>
      <button class="btn-primary" type="button" data-act="invite-accept">Connect</button>` : `<button class="btn-primary" type="submit">Show who this is</button>`}
    ${S.joinError ? `<div class="banner dup">${esc(S.joinError)}</div>` : ""}</form>`;
}

// ---------------- auth screen ----------------
function authView() {
  const a = S.auth, signup = a.mode === "signup";
  return `<div class="stack auth">${header("Pillbox", isCare() ? "Signed-in account" : "Your medicines")}
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
  caregiver: [["patients", "People"], ["link", "Connect"], ["settings", "Settings"]],
};
function onboardView() {
  const suggested = S.store.suggested || S.profile || { usePatient: !S.legacyCare, useCaregiver: !!S.legacyCare };
  const step = S.onboardStep || "role";
  const kept = S.store.mode === "local" && S.store.data && !S.store.data.fresh;
  const keptLine = kept ? `<div class="banner info"><div><strong>Medicines already on this phone stay here.</strong> Choosing a view does not delete them or grant access to anyone.</div></div>` : "";
  if (step === "recommend") {
    return `<div class="stack auth">${header("Pillbox", "One optional question")}${legacyBanner()}
      <section class="sheet stack"><h2>Did a healthcare professional recommend this app?</h2>
      <p class="muted">You can skip this. The answer does not change what you can open, and Pillbox does not treat it as a medical recommendation.</p>
      <div class="row"><button class="btn-primary" data-act="recommend" data-v="yes">Yes</button><button data-act="recommend" data-v="no">No</button><button data-act="recommend" data-v="skip">Skip</button></div></section></div>`;
  }
  const choices = [["patient", "I take medicines"], ["caregiver", "I help someone else"], ["both", "Both"]];
  return `<div class="stack auth">${header("Pillbox", "How will you use it?")}${legacyBanner()}${keptLine}
    <section class="sheet stack"><h2>Choose what you see</h2>
    <p class="muted">This is only the screens on this phone. It does not connect you to another person and does not let a view open someone else's medicines.</p>
    <div class="stack">${choices.map(([k, label]) => `<button class="role-choice" data-act="role-pick" data-mode="${k}">${label}</button>`).join("")}</div>
    <p class="muted small">Suggested from this install: ${suggested.usePatient && suggested.useCaregiver ? "both" : suggested.useCaregiver ? "helping someone" : "taking medicines"}.</p>
    </section></div>`;
}
function render() {
  document.documentElement.dataset.role = isCare() ? "caregiver" : "patient";
  if (!S.profile?.onboarded) { $app.innerHTML = onboardView(); $nav.hidden = true; return; }
  if (S.store.mode === "cloud" && !S.user) { $app.innerHTML = authView(); $nav.hidden = true; return; }
  if (!S.user) { $app.innerHTML = authView(); $nav.hidden = true; return; }
  $nav.hidden = false;
  const items = NAV[S.role];
  $nav.innerHTML = `<div class="in" style="grid-template-columns:repeat(${items.length},1fr)">` + items.map(([k, l]) => `<a href="#${k}" ${S.view === k || (k === "patients" && S.view === "today") ? 'aria-current="page"' : ""}>${l}</a>`).join("") + `</div>`;
  const scroll = document.querySelector(".overlay .panel")?.scrollTop;
  $app.innerHTML = (isCare() ? caregiverView() : patientView()) + sheetView();
  const panel = scroll && document.querySelector(".overlay .panel"); if (panel) panel.scrollTop = scroll;
}
// Dose sheet. S.sheet = { pid, key } for one dose, or { pid, time, group: true } for "Taken earlier?" on the
// take-all button. `edit` shows the time picker (late logging, or changing a taken dose's time).
function timeForm(day, scheduled, value, label) {
  return `<form class="stack" id="timeform"><div class="field"><label for="t-at">${label}</label>
    <input id="t-at" name="at" type="time" required value="${esc(S.sheet.value || value || M.defaultLogTime(day, scheduled))}"></div>
    ${S.sheet.error ? `<div class="banner dup">${esc(S.sheet.error)}</div>` : ""}
    <div class="row"><button class="btn-primary" type="submit">Save</button><button type="button" data-act="edit-cancel">Cancel</button></div></form>`;
}
function editLogForm(d) {
  const nm = M.normalizeMed(d.med);
  const units = M.TYPES[nm.type].doseUnits;
  const amount = S.sheet.amount ?? (d.log?.amount ?? nm.doseAmount);
  const unit = S.sheet.unit || d.log?.unit || nm.doseUnit;
  const timeVal = S.sheet.value || M.hm(new Date(d.log.at));
  return `<form class="stack" id="editform"><div class="field"><label for="e-amt">Amount logged</label>
    <div class="amount"><input id="e-amt" name="amount" type="number" min="0" step="any" required value="${esc(M.fmtNum(amount))}">
    <select name="unit" aria-label="Unit">${units.map(u => `<option value="${esc(u)}" ${u === unit ? "selected" : ""}>${esc(u === "units" ? "units (IU)" : u)}</option>`).join("")}</select></div>
    <div class="muted small">This is the amount that was logged. It does not change the dose saved on the medicine.</div></div>
    <div class="field"><label for="e-at">Time</label><input id="e-at" name="at" type="time" required value="${esc(timeVal)}"></div>
    ${S.sheet.error ? `<div class="banner dup">${esc(S.sheet.error)}</div>` : ""}
    <div class="row"><button class="btn-primary" type="submit">Save log</button><button type="button" data-act="edit-cancel">Cancel</button></div></form>`;
}
function additionalForm() {
  const med = snap(S.sheet.pid).meds.find(m => m.id === S.sheet.medId);
  if (!med) { S.sheet = null; return ""; }
  const nm = M.normalizeMed(med);
  const units = M.TYPES[nm.type].doseUnits;
  const amount = S.sheet.amount ?? nm.doseAmount;
  const unit = S.sheet.unit || nm.doseUnit;
  const atLocal = S.sheet.atLocal || (dayKey(new Date()) + "T" + M.hm(new Date()));
  return `<form class="stack" id="addform"><div class="eyebrow">Log actual treatment</div><h2>${esc(med.name)}</h2>
    <p class="muted">This adds a record of what was given. It does not change the prescription, and it does not move reminders.</p>
    <div class="field"><label for="a-amt">Amount</label><div class="amount"><input id="a-amt" name="amount" type="number" min="0" step="any" required value="${esc(M.fmtNum(amount))}">
    <select name="unit" aria-label="Unit">${units.map(u => `<option value="${esc(u)}" ${u === unit ? "selected" : ""}>${esc(u === "units" ? "units (IU)" : u)}</option>`).join("")}</select></div></div>
    <div class="field"><label for="a-at">When</label><input id="a-at" name="at" type="datetime-local" required max="${dayKey(new Date()) + "T" + M.hm(new Date())}" value="${esc(atLocal)}"></div>
    ${S.sheet.error ? `<div class="banner dup">${esc(S.sheet.error)}</div>` : ""}
    <div class="row"><button class="btn-primary" type="submit">Save log</button><button type="button" data-act="close-sheet">Cancel</button></div></form>`;
}
function sheetView() {
  if (!S.sheet) return "";
  const { pid, key } = S.sheet, p = snap(pid);
  const wrap = body => `<div class="overlay" data-act="close-sheet"><div class="panel" role="dialog" aria-label="Dose details">${body}<button class="btn-quiet" data-act="close-sheet">Close</button></div></div>`;
  if (S.sheet.ev) return `<div class="overlay" data-act="close-sheet"><div class="panel" role="dialog" aria-label="${S.sheet.evId ? "Edit event" : "Log event"}">${eventSheet()}</div></div>`;
  if (S.sheet.additional) return wrap(additionalForm());
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
  if (S.sheet.edit && d.log) actions = editLogForm(d);
  else if (S.sheet.edit) actions = timeForm(d.day, d.time, "", "When was it logged?");
  else if (d.log && d.log.status === "taken") actions = `<div class="row"><button data-act="edit-time" data-pid="${pid}" data-key="${d.key}">Correct this log</button><button data-act="undo" data-pid="${pid}" data-key="${d.key}">Undo</button><button class="btn-danger" data-act="remove-log" data-pid="${pid}" data-key="${d.key}">${S.sheet.confirmRemove ? "Remove log" : "Remove this log"}</button></div>
    <p class="muted small">Removing a log takes it out of history and puts the supply back. It does not change the schedule. Skip is different: that marks a scheduled dose which isn't logged as not taken, and leaves it on the schedule.</p>`;
  else if (d.log) actions = `<div class="row"><button data-act="undo" data-pid="${pid}" data-key="${d.key}">Undo skip</button></div><p class="muted small">This scheduled dose stays on the schedule as not taken.</p>`;
  else actions = `<button class="btn-primary" data-act="take-key" data-pid="${pid}" data-key="${d.key}">Log ${esc(M.doseLabel(d.med))} now</button>
      <button data-act="edit-time" data-pid="${pid}" data-key="${d.key}">Log at another time</button>
      <button class="btn-quiet" data-act="skip" data-pid="${pid}" data-key="${d.key}">Skip this scheduled dose</button>
      <p class="muted small">Skip marks this scheduled dose as not taken. The schedule stays. This does not delete later doses.</p>`;
  return wrap(`<div class="eyebrow">${esc(M.medSummary(d.med))}</div><h2>${esc(d.med.name)} ${esc(d.med.strength)}</h2>${d.med.notes ? `<div class="muted">${esc(d.med.notes)}</div>` : ""}
    <p class="dose-times"><strong>${esc(M.fmtDoseTimes(d))}</strong>${who}</p>${actions}`);
}
function route() {
  const h = location.hash.slice(1), valid = NAV[S.role].map(x => x[0]);
  S.view = valid.includes(h) ? h : valid[0];
  if (!isCare()) S.pid = S.patients.find(p => p.id === "me")?.id || S.patients.find(p => p.owner)?.id || S.pid;
  if (isCare() && (S.view !== "patients" || S.pid === "me")) S.pid = null;
  S.editing = null; S.sheet = null; S.drug = null; N.stopBrowserScan(); S.joinError = ""; S.medDetail = null; S.stockForm = null;
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
document.addEventListener("input", e => {
  if (e.target.id === "t-at" && S.sheet) S.sheet.value = e.target.value;
  if (e.target.id === "drug-q" && S.drug) S.drug.query = e.target.value;
  if (e.target.id === "drug-code" && S.drug) S.drug.code = e.target.value;
});
// Type, frequency and supply-unit pickers redraw the form so only the relevant fields show.
document.addEventListener("change", e => {
  if (e.target.id === "ev-area" && S.sheet?.ev) {
    readEventForm();
    render();
    document.getElementById("ev-area")?.focus({ preventScroll: true });
    return;
  }
  if (!e.target.matches("#medform [data-live]")) return;
  readForm(); render();
  const again = document.querySelector(`#medform [name="${e.target.name}"]${e.target.type === "radio" ? `[value="${e.target.value}"]` : ""}`);
  if (again) again.focus();
});

document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act, pid = el.dataset.pid || S.pid;
  if (act === "close-sheet" && el.classList.contains("overlay") && e.target !== el) return;
  let refocus = "";
  try {
    switch (act) {
      case "well": {
        const d = findDose(pid, el.dataset.key);
        if (d && !d.log) { const res = await takeDose(pid, d); if (res && res.code === "applied") toast(doseResultMessage(res, d.med), res.key); }
        else S.sheet = { pid, key: el.dataset.key };
        break;
      }
      case "take-key": { const d = findDose(pid, el.dataset.key); if (d) { const res = await takeDose(pid, d); if (res && res.code === "applied") toast(doseResultMessage(res, d.med), res.key); } S.sheet = null; break; }
      case "skip": { const d = findDose(pid, el.dataset.key); if (d) await skipDose(pid, d); S.sheet = null; toast("Dose skipped"); break; }
      case "undo": await undoDose(pid, el.dataset.key); S.sheet = null; document.getElementById("toast").hidden = true; toast("Undone"); break;
      case "take-prn": await logAdditional(pid, snap(pid).meds.find(m => m.id === el.dataset.med)); break;
      case "log-additional": S.sheet = { pid, additional: true, medId: el.dataset.med }; break;
      case "force": await logAdditional(S.pid, snap().meds.find(m => m.id === el.dataset.med), new Date(), null, null, true); S.alert = null; break;
      case "remove-log":
        if (!S.sheet?.confirmRemove) { S.sheet = { ...(S.sheet || { pid, key: el.dataset.key }), pid, key: el.dataset.key || S.sheet?.key, confirmRemove: true }; break; }
        await undoDose(pid, el.dataset.key || S.sheet.key); S.sheet = null; toast("Log removed"); break;
      case "dismiss": S.alert = null; break;
      case "close-sheet": S.sheet = null; break;
      case "open-sheet": S.sheet = { pid, key: el.dataset.key }; break;
      case "edit-time": S.sheet = { pid, key: el.dataset.key, edit: true }; document.getElementById("toast").hidden = true; break;
      case "edit-cancel": if (S.sheet) { S.sheet.edit = false; S.sheet.error = ""; if (S.sheet.group) S.sheet = null; } break;
      case "ev-new": S.sheet = newEventSheet(pid); break;
      case "ev-open": S.sheet = editEventSheet(pid, el.dataset.id); break;
      case "ev-type": readEventForm(); S.sheet.ev.type = el.dataset.type; break;
      case "ev-sev": readEventForm(); S.sheet.ev.severity = S.sheet.ev.severity === Number(el.dataset.v) ? null : Number(el.dataset.v); break;
      case "ev-cause": readEventForm(); S.sheet.ev.cause = S.sheet.ev.cause === el.dataset.v ? null : el.dataset.v; break;
      case "ev-area": {
        if (!S.sheet?.ev) break;
        readEventForm();
        const next = el.dataset.area;
        S.sheet.ev.area = areaAfterTap(S.sheet.ev.area, next);
        refocus = `.body-hit[data-area="${CSS.escape(next)}"][data-side="${CSS.escape(el.dataset.side || "")}"]`;
        break;
      }
      case "ev-delete":
        readEventForm(); if (!S.sheet.confirmDelete) { S.sheet.confirmDelete = true; break; }
        await S.store.deleteEvent(S.sheet.pid, S.sheet.evId); S.sheet = null; toast("Event deleted"); break;
      case "earlier-group": S.sheet = { pid, time: el.dataset.time, group: true }; break;
      case "clear-examples": S.store.clearExamples(); S.snaps = {}; if (!isCare()) S.pid = "me"; break;
      case "cal-prev": S.cal.m--; if (S.cal.m < 0) { S.cal.m = 11; S.cal.y--; } break;
      case "cal-next": S.cal.m++; if (S.cal.m > 11) { S.cal.m = 0; S.cal.y++; } break;
      case "cal-sel": S.cal.sel = el.dataset.day; render(); document.getElementById("day-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }); return;
      case "new": S.drug = null; S.editing = { ...M.normalizeMed({ id: M.uid(), name: "", strength: "", type: "pill", doseAmount: 1, times: ["08:00"], schedule: { kind: "daily" }, start: dayKey(new Date()), stock: 30, refillAt: 5, slot: null, notes: "", color: M.COLORS[snap().meds.length % M.COLORS.length] }), isNew: true }; break;
      case "drug-open": readForm(); S.drug = { step: "search", query: (document.getElementById("drug-q")?.value || S.editing?.name || ""), message: "", choices: S.drug?.choices || [] }; break;
      case "drug-close": S.drug = null; N.stopBrowserScan(); break;
      case "drug-back": if (S.drug) S.drug.step = S.drug.choices?.length ? "results" : "search"; break;
      case "drug-pick": {
        const choice = S.drug?.choices?.[Number(el.dataset.i)];
        if (choice) S.drug = { ...S.drug, step: "review", choice };
        break;
      }
      case "drug-use": {
        if (!S.drug?.choice || !S.editing) break;
        readForm();
        const doseAmount = S.editing.doseAmount, doseUnit = S.editing.doseUnit, times = S.editing.times, schedule = S.editing.schedule;
        Object.assign(S.editing, applyCatalogChoice(S.editing, S.drug.choice));
        S.editing.doseAmount = doseAmount; S.editing.doseUnit = doseUnit; S.editing.times = times; S.editing.schedule = schedule;
        S.drug = null;
        break;
      }
      case "drug-search": {
        readForm();
        const query = document.getElementById("drug-q")?.value ?? S.drug?.query ?? "";
        S.drug = { step: "search", query, message: "Searching…", choices: [] };
        render();
        const res = await searchDrugNames(query);
        if (!S.drug) break;
        S.drug.choices = (res.choices || []).slice(0, 20);
        S.drug.message = res.choices?.length > 20 ? "Showing the first 20. Type more of the name if yours isn't here." : drugMessage(res.code);
        break;
      }
      case "drug-code-go": {
        const code = document.getElementById("drug-code")?.value ?? S.drug?.code ?? "";
        await lookupCode(code);
        break;
      }
      case "drug-scan": await beginPackageScan(); break;
      case "edit": S.editing = M.normalizeMed(structuredClone(snap().meds.find(m => m.id === el.dataset.med))); break;
      case "cancel": S.drug = null; N.stopBrowserScan(); S.editing = null; break;
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
      case "invite-perm": S.invite = await S.store.createInvite(S.pid, el.dataset.perm); break;
      case "invite-clear": S.invite = null; break;
      case "invite-accept": {
        const res = await S.store.acceptInvite(S.invitePreview?.codeText || "");
        if (!res?.ok) { S.joinError = res?.message || "That code didn't connect."; break; }
        S.invitePreview = null; S.joinError = "";
        if (res.patientId) S.pid = res.patientId;
        toast("Connected to " + (res.patientName || "them"));
        location.hash = "patients";
        return;
      }
      case "role-pick":
        S.draftUse = el.dataset.mode === "both" ? { usePatient: true, useCaregiver: true } : el.dataset.mode === "caregiver" ? { usePatient: false, useCaregiver: true } : { usePatient: true, useCaregiver: false };
        S.onboardStep = "recommend";
        break;
      case "recommend":
        applyUse(S.draftUse?.usePatient !== false, !!S.draftUse?.useCaregiver, el.dataset.v, S.draftUse?.usePatient === false ? "caregiver" : "patient");
        break;
      case "role-toggle": {
        const nextPatient = el.dataset.mode === "patient" ? !S.profile?.usePatient : !!S.profile?.usePatient;
        const nextCare = el.dataset.mode === "caregiver" ? !S.profile?.useCaregiver : !!S.profile?.useCaregiver;
        if (!nextPatient && !nextCare) { toast("Keep at least one."); break; }
        const view = !nextCare && isCare() ? "patient" : !nextPatient && !isCare() ? "caregiver" : S.activeView;
        applyUse(nextPatient, nextCare, S.profile?.recommended || "skip", view);
        const hash = view === "caregiver" ? "#patients" : "#today";
        if (location.hash !== hash) { location.hash = hash; return; }
        break;
      }
      case "switch-view": {
        const view = el.dataset.view === "caregiver" ? "caregiver" : "patient";
        setActiveView(view);
        const hash = view === "caregiver" ? "#patients" : "#today";
        if (location.hash !== hash) { location.hash = hash; return; }
        S.view = view === "caregiver" ? "patients" : "today";
        if (view === "caregiver") S.pid = null;
        else S.pid = S.patients.find(p => p.id === "me")?.id || S.patients.find(p => p.owner)?.id || S.pid;
        break;
      }
      case "export-backup": {
        const data = S.store.exportBackup?.();
        if (!data) { toast("There's nothing to export from a signed-in account on this screen."); break; }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = "pillbox-backup.json";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 8000);
        toast("Backup downloaded. Moving the file does not link another phone.");
        break;
      }
      case "import-backup": {
        const input = document.createElement("input");
        input.type = "file"; input.accept = "application/json,.json";
        input.onchange = async () => {
          try {
            const plan = S.store.importBackup(JSON.parse(await input.files[0].text()));
            toast(plan.message || "Couldn't import that file.");
          } catch (err) { toast("Couldn't read that file."); }
          render();
        };
        input.click();
        return;
      }
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
  if (refocus) document.querySelector(refocus)?.focus({ preventScroll: true });
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
      if (list[0].log) {
        await commit(sh.pid, { opId: M.uid(), kind: "edit", medId: list[0].med.id, key: list[0].key, amount: list[0].log.amount, unit: list[0].log.unit, at: when.toISOString() });
        toast("Changed to " + label);
      } else {
        const saved = [];
        for (const d of list) { const res = await takeDose(sh.pid, d, "app", when); if (res && res.code === "applied") saved.push(res); }
        if (saved.length === 1) toast(doseResultMessage(saved[0], list[0].med), saved[0].key);
        else if (saved.length) toast(saved.length + " treatments logged");
      }
      S.sheet = null;
    } else if (f.id === "evform") {
      readEventForm(); const sh = S.sheet, ev = sh.ev, when = new Date(ev.atLocal); // datetime-local: local time
      if (isNaN(when.getTime())) { sh.error = "Pick when it happened."; render(); return; }
      if (when.getTime() > Date.now() + 60000) { sh.error = "That time hasn't happened yet."; render(); return; }
      const was = sh.evId ? (snap(sh.pid).events || {})[sh.evId] : null, name = S.user?.name || "";
      // the first person to log it stays its author; later changes say who edited
      const rec = { ...(was || {}), ...ev, id: sh.evId || M.uid(), at: when, updatedAt: Date.now(),
        ...(was ? { editedBy: S.role, editedByName: name } : { by: S.role, byName: name, createdAt: Date.now() }) };
      await S.store.saveEvent(sh.pid, rec);
      S.sheet = null; toast(was ? "Event saved" : M.EVENT_TYPES[rec.type].label + " logged");
    } else if (f.id === "editform") {
      const sh = S.sheet, d = findDose(sh.pid, sh.key);
      if (!d?.log) { S.sheet = null; render(); return; }
      const fd = new FormData(f);
      const when = M.editedLogTime(d.log.at, fd.get("at"));
      if (!when) { sh.error = "That time hasn't happened yet."; render(); return; }
      const amount = Number(fd.get("amount"));
      if (!(amount > 0)) { sh.error = "Enter the amount that was logged."; render(); return; }
      await commit(sh.pid, { opId: M.uid(), kind: "edit", medId: d.med.id, key: d.key, amount, unit: fd.get("unit"), at: when.toISOString() });
      toast("Log updated"); S.sheet = null;
    } else if (f.id === "addform") {
      const sh = S.sheet, med = snap(sh.pid).meds.find(m => m.id === sh.medId);
      const fd = new FormData(f), when = new Date(fd.get("at"));
      if (!med || isNaN(when.getTime())) { sh.error = "Pick when it happened."; render(); return; }
      if (when.getTime() > Date.now() + 60000) { sh.error = "That time hasn't happened yet."; render(); return; }
      const amount = Number(fd.get("amount"));
      if (!(amount > 0)) { sh.error = "Enter the amount that was logged."; render(); return; }
      const res = await logAdditional(sh.pid, med, when, amount, fd.get("unit"), true);
      if (res) S.sheet = null;
    } else if (f.id === "stockform") {
      const fd = new FormData(f), n = Number(fd.get("n")), note = (fd.get("note") || "").trim();
      const m = snap().meds.find(x => x.id === S.medDetail); if (!m || !(n >= 0)) return;
      if (S.stockForm.mode === "refill") { await adjustStock(S.pid, m.id, n, stockEv("refill", note)); toast(M.qty(n, M.normalizeMed(m).supplyUnit) + " added"); }
      else { if (typeof m.stock !== "number") await S.store.saveMed(S.pid, { ...m, stock: 0 }); await adjustStock(S.pid, m.id, n - (m.stock || 0), stockEv("adjust", note)); toast("Count saved"); }
      S.stockForm = null;
    } else if (f.id === "joinform") {
      const code = new FormData(f).get("code");
      const preview = await S.store.previewInvite(code);
      if (!preview?.ok) { S.joinError = preview?.message || "That code didn't work."; S.invitePreview = null; }
      else { S.joinError = ""; S.invitePreview = { ...preview, codeText: code }; }
    } else if (f.id === "authform") {
      const fd = Object.fromEntries(new FormData(f));
      S.auth.error = "";
      if (S.auth.mode === "signup") {
        fd.usePatient = !!S.profile?.usePatient;
        fd.useCaregiver = !!S.profile?.useCaregiver;
      }
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
  if (!busy()) render();
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
    let logged = 0;
    for (const d of list) { const res = await takeDose(pid, d, "reminder"); if (res && res.code === "applied") logged++; }
    if (logged) toast(logged === 1 ? "Logged from the reminder" : logged + " treatments logged from the reminder");
  } catch (err) { toast(err.message || String(err)); }
  if (!busy()) render();
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
    if (!isCare()) { S.pid = list.find(p => p.id === "me")?.id || list.find(p => p.owner)?.id || list[0]?.id || null; runQueuedReminderActions(); }
    render();
  });
}
async function afterLogin() {
  wirePatients();
  // Permission check must never block the first paint (native plugin awaits can hang).
  try { S.perm = await N.reminderPermission(); } catch (e) { S.perm = "unsupported"; }
  if (!busy()) render();
}

async function boot() {
  try { S.legacyCare = (await N.detectApp()).legacyCarePackage; } catch (e) { S.legacyCare = false; }
  document.title = "Pillbox";
  S.store = makeStore({ legacyCarePackage: S.legacyCare });
  S.profile = readProfile() || S.store.profile || null;
  if (S.profile?.onboarded) writeProfile(S.profile);
  setActiveView(chooseView(S.profile || S.store.suggested || { usePatient: !S.legacyCare, useCaregiver: !!S.legacyCare }));
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
    N.reminderPermission().then(p => { S.perm = p; if (!busy()) render(); }).catch(() => { S.perm = "unsupported"; if (!busy()) render(); });
  }
  setInterval(() => { checkMissed(); if (!busy() && !document.querySelector("input:focus")) render(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !busy()) render(); });
  window.Pillbox = { lidOpened, state: S };
}
boot();
