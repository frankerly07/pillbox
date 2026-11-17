// Settings on this phone, and the one-tap "alarms and calendar for all my medicines" action.
// No DOM and no plugins here: main.js passes in the phone functions, so tests can use fakes.
import { isPrn } from "./model.js";
import { t, tn } from "./i18n.js";

export const SETTINGS_KEY = "pillbox.settings";
/** "Add new medicines to my calendar" starts off. */
export const DEFAULT_SETTINGS = Object.freeze({ dueWindowMin: 60, bodyFigure: "male", calendarForNewMeds: false });

/** Saved settings merged over the defaults. Bad or missing storage gives the defaults. */
export function loadSettings(storage = globalThis.localStorage) {
  let saved = {};
  try { saved = JSON.parse(storage?.getItem(SETTINGS_KEY) || "{}") || {}; } catch (e) { saved = {}; }
  const s = { ...DEFAULT_SETTINGS, ...(typeof saved === "object" && !Array.isArray(saved) ? saved : {}) };
  s.calendarForNewMeds = s.calendarForNewMeds === true;
  return s;
}
export function saveSettings(settings, storage = globalThis.localStorage) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
}

/** Should a new medicine start with "Add to my calendar" checked? */
export const calendarOnForNewMed = settings => !!settings?.calendarForNewMeds;

/** Scheduled medicines that are not on the calendar yet. As-needed medicines have no times to add. */
export const calendarCandidates = meds => (meds || []).filter(m => !isPrn(m) && !m.addToCalendar);

/**
 * Turn on dose alarms and calendar events for every scheduled medicine.
 *   askPermission()            → "granted" | "denied" | "default" | "unsupported" …
 *   scheduleReminders(meds, doses)
 *   addToCalendar(med, doses)  → { ok, ids, denied? } without any file fallback
 *   saveMed(med)
 *   onPhone                    → false in a browser; the calendar part is skipped there
 * Stops adding calendar events after the first denial so the person is asked only once.
 * Returns { perm, added, failed, skipped, calendar: "added" | "denied" | "notPhone" | "nothing" | "noScheduled" }.
 */
export async function turnOnAllReminders({ meds = [], doses = {}, onPhone, askPermission, scheduleReminders, addToCalendar, saveMed }) {
  let perm = "unsupported";
  try { perm = await askPermission(); } catch (e) {}
  try { await scheduleReminders(meds, doses); } catch (e) {}
  const todo = calendarCandidates(meds);
  const out = { perm, added: 0, failed: 0, skipped: 0, calendar: "added" };
  if (!todo.length) { out.calendar = (meds || []).some(m => !isPrn(m)) ? "nothing" : "noScheduled"; return out; }
  if (!onPhone) { out.calendar = "notPhone"; out.skipped = todo.length; return out; }
  for (let i = 0; i < todo.length; i++) {
    const m = todo[i];
    let r;
    try { r = await addToCalendar(m, doses); } catch (e) { r = { ok: false }; }
    if (r?.denied) { out.calendar = "denied"; out.skipped = todo.length - i; break; }
    if (r?.ok) {
      out.added++;
      try { await saveMed({ ...m, addToCalendar: true, calendarEventIds: r.ids || [] }); } catch (e) {}
    } else out.failed++;
  }
  return out;
}

/** Short message for the result of turnOnAllReminders, in the current language. */
export function allRemindersMessage(res) {
  const alarms = t(res.perm === "granted" ? "rem.alarmsOn" : res.perm === "denied" ? "rem.alarmsBlocked" : res.perm === "unsupported" ? "rem.alarmsUnsupported" : "rem.alarmsNotOn");
  const parts = [alarms];
  if (res.calendar === "nothing") parts.push(t("rem.calNothing"));
  else if (res.calendar === "noScheduled") parts.push(t("rem.calNoScheduled"));
  else if (res.calendar === "notPhone") parts.push(t("rem.calNotPhone"));
  else {
    if (res.added || res.calendar !== "denied") parts.push(tn("rem.calAdded", res.added));
    if (res.calendar === "denied") parts.push(t("rem.calDenied"));
  }
  if (res.failed) parts.push(tn("rem.calFailed", res.failed));
  return parts.join(" ");
}
