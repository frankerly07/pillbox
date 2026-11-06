import { describe, it, expect } from "vitest";
import { supplyTaken, reminderPlan, dosesForReminder, doseKey, dayKey, isDueOn, normalizeMed, supplyPerDose, supply, dosesOn, adherence, patientStatus, medSummary, doseLabel, parseDay } from "./model.js";
import { fmtLogged, fmtDoseTimes, defaultLogTime, logTimeFor } from "./model.js";
import { scheduledOn, doseAnchors, editedLogTime, lowStock } from "./model.js";

const med = (o = {}) => ({ id: "a", name: "A", perDose: "2 tablets", times: ["08:00", "20:00"], ...o });
const NOW = new Date(2026, 10, 4, 12, 0).getTime(); // Wed 4 Nov 2026, noon
const today = dayKey(new Date(NOW)), tomorrow = dayKey(new Date(2026, 10, 5));

describe("supplyTaken", () => {
  it("is 0 for no record or a skipped dose", () => {
    expect(supplyTaken(undefined, med())).toBe(0);
    expect(supplyTaken({ status: "skipped" }, med())).toBe(0);
  });
  it("uses the pills saved on the record", () => {
    expect(supplyTaken({ status: "taken", pills: 3 }, med())).toBe(3);
    expect(supplyTaken({ status: "taken", used: 0.25 }, med())).toBe(0.25);
  });
  it("falls back to the medicine for older records", () => {
    expect(supplyTaken({ status: "taken" }, med())).toBe(2);
    expect(supplyTaken({ status: "taken" }, undefined)).toBe(1);
  });
});

describe("reminderPlan", () => {
  it("only schedules future doses, one alarm per day and time", () => {
    const plan = reminderPlan([med()], {}, { now: NOW, days: 2 });
    expect(plan.map(r => r.day + " " + r.time)).toEqual([today + " 20:00", tomorrow + " 08:00", tomorrow + " 20:00"]);
    expect(new Set(plan.map(r => r.id)).size).toBe(plan.length);
    expect(plan.every(r => r.id >= 1000 && r.id < 4000)).toBe(true);
  });
  it("skips doses already taken or skipped", () => {
    const doses = { [doseKey("a", today, "20:00")]: { status: "taken" }, [doseKey("a", tomorrow, "08:00")]: { status: "skipped" } };
    const plan = reminderPlan([med()], doses, { now: NOW, days: 2 });
    expect(plan.map(r => r.day + " " + r.time)).toEqual([tomorrow + " 20:00"]);
  });
  it("respects start and end dates", () => {
    expect(reminderPlan([med({ start: tomorrow })], {}, { now: NOW, days: 3 }).every(r => r.day >= tomorrow)).toBe(true);
    expect(reminderPlan([med({ end: today })], {}, { now: NOW, days: 3 }).map(r => r.day)).toEqual([today]);
    expect(reminderPlan([med({ end: "2026-11-01" })], {}, { now: NOW, days: 3 })).toEqual([]);
  });
  it("groups medicines due at the same time and leaves out ones already taken", () => {
    const b = med({ id: "b", name: "B", times: ["20:00"] });
    const plan = reminderPlan([med(), b], { [doseKey("a", today, "20:00")]: { status: "taken" } }, { now: NOW, days: 1 });
    expect(plan).toHaveLength(1);
    expect(plan[0].meds.map(m => m.id)).toEqual(["b"]);
  });
});

describe("dosesForReminder", () => {
  const meds = [med(), med({ id: "b", name: "B", times: ["08:00"] })];
  it("finds the doses for that day, time and medicines", () => {
    const list = dosesForReminder({ day: tomorrow, time: "08:00", medIds: ["a"] }, meds, {}, NOW);
    expect(list.map(d => d.key)).toEqual([doseKey("a", tomorrow, "08:00")]);
  });
  it("defaults to today for alarms without a day", () => {
    expect(dosesForReminder({ time: "08:00", medIds: ["a", "b"] }, meds, {}, NOW).map(d => d.day)).toEqual([today, today]);
  });
  it("leaves out taken doses but keeps skipped ones", () => {
    const doses = { [doseKey("a", today, "08:00")]: { status: "taken" }, [doseKey("b", today, "08:00")]: { status: "skipped" } };
    expect(dosesForReminder({ day: today, time: "08:00", medIds: ["a", "b"] }, meds, doses, NOW).map(d => d.med.id)).toEqual(["b"]);
  });
  it("returns nothing for a notification without dose info", () => {
    expect(dosesForReminder({}, meds, {}, NOW)).toEqual([]);
  });
});

const D = (y, m, d) => new Date(y, m - 1, d, 12);
const sched = (schedule, o = {}) => med({ start: "2026-11-04", schedule, ...o });

describe("isDueOn", () => {
  it("daily respects start and end dates", () => {
    const m = med({ start: "2026-11-04", end: "2026-11-06" });
    expect([3, 4, 5, 6, 7].map(d => isDueOn(m, D(2026, 11, d)))).toEqual([false, true, true, true, false]);
  });
  it("specific weekdays", () => {
    const m = sched({ kind: "weekdays", days: [1, 3, 5] }); // Mon, Wed, Fri
    expect([4, 5, 6, 7, 8, 9].map(d => isDueOn(m, D(2026, 11, d)))).toEqual([true, false, true, false, false, true]);
  });
  it("every N days counts from the start date", () => {
    const m = sched({ kind: "everyNDays", n: 3 });
    expect([3, 4, 5, 6, 7, 10, 13].map(d => isDueOn(m, D(2026, 11, d)))).toEqual([false, true, false, false, true, true, true]);
    expect(isDueOn(m, D(2026, 12, 1))).toBe(true); // 27 days later, across a month end
    expect(isDueOn(m, D(2026, 12, 2))).toBe(false);
  });
  it("every N weeks is anchored to the start date's weekday", () => {
    const m = sched({ kind: "everyNWeeks", n: 2 }); // starts Wed 4 Nov
    expect(isDueOn(m, D(2026, 11, 4))).toBe(true);
    expect(isDueOn(m, D(2026, 11, 11))).toBe(false);
    expect(isDueOn(m, D(2026, 11, 18))).toBe(true);
    expect(isDueOn(m, D(2026, 11, 19))).toBe(false);
    expect(isDueOn(m, D(2027, 3, 24))).toBe(true); // 140 days, across the March DST change
    expect(isDueOn(m, D(2027, 3, 31))).toBe(false); // 147 days: an off week
    expect(isDueOn(m, D(2026, 10, 21))).toBe(false); // before start
  });
  it("monthly on day 31 falls on the last day of shorter months", () => {
    const m = sched({ kind: "monthly", dayOfMonth: 31 }, { start: "2026-01-01" });
    expect(isDueOn(m, D(2026, 1, 31))).toBe(true);
    expect(isDueOn(m, D(2026, 2, 28))).toBe(true);
    expect(isDueOn(m, D(2026, 2, 27))).toBe(false);
    expect(isDueOn(m, D(2028, 2, 29))).toBe(true); // leap year
    expect(isDueOn(m, D(2028, 2, 28))).toBe(false);
    expect(isDueOn(m, D(2026, 4, 30))).toBe(true);
    expect(isDueOn(m, D(2026, 5, 30))).toBe(false);
  });
  it("monthly on an ordinary day", () => {
    const m = sched({ kind: "monthly", dayOfMonth: 15 });
    expect(isDueOn(m, D(2026, 11, 15))).toBe(true);
    expect(isDueOn(m, D(2026, 12, 15))).toBe(true);
    expect(isDueOn(m, D(2026, 12, 14))).toBe(false);
  });
  it("as needed is never due, so no reminders, missed doses or adherence", () => {
    const m = sched({ kind: "prn" });
    expect(isDueOn(m, D(2026, 11, 4))).toBe(false);
    expect(dosesOn(D(2026, 11, 4), [m], {}, { now: NOW })).toEqual([]);
    expect(reminderPlan([m], {}, { now: NOW, days: 3 })).toEqual([]);
    expect(adherence([m], {}, 14, NOW).total).toBe(0);
    expect(patientStatus([m], {}, NOW + 12 * 3600000).missed).toEqual([]);
  });
});

describe("schedules in the dose lists", () => {
  const biweekly = start => sched({ kind: "everyNWeeks", n: 2 }, { start, times: ["09:00"] });
  it("reminders only fall on scheduled days", () => {
    expect(reminderPlan([biweekly("2026-10-28")], {}, { now: NOW, days: 14 }).map(r => r.day)).toEqual(["2026-11-11"]);
  });
  it("missed doses only count on scheduled days", () => {
    expect(patientStatus([biweekly("2026-10-28")], {}, NOW).missed).toEqual([]); // off week
    expect(patientStatus([biweekly("2026-10-21")], {}, NOW).missed.map(d => d.key)).toEqual([doseKey("a", today, "09:00")]);
  });
  it("adherence counts only scheduled doses", () => {
    const m = sched({ kind: "weekdays", days: [1] }, { start: "2026-10-01", times: ["08:00"] }); // Mondays
    expect(adherence([m], {}, 14, NOW).total).toBe(2); // Mon 26 Oct, Mon 2 Nov
  });
});

describe("supply", () => {
  it("pills: a dose takes its pill count", () => {
    expect(supplyPerDose(normalizeMed(med()))).toBe(2);
    expect(supplyPerDose({ type: "pill", doseAmount: 1.5 })).toBe(1.5);
  });
  it("vials with doses per vial take a share; without it one vial per dose", () => {
    expect(supplyPerDose({ type: "injection", doseAmount: 40, doseUnit: "units", supplyUnit: "pens", perContainer: 4 })).toBe(0.25);
    expect(supplyPerDose({ type: "injection", doseAmount: 40, doseUnit: "units", supplyUnit: "vials" })).toBe(1);
    expect(supplyPerDose({ type: "injection", doseAmount: 2, doseUnit: "doses", supplyUnit: "vials", perContainer: 10 })).toBe(0.2);
    expect(supplyPerDose({ type: "injection", doseAmount: 2, doseUnit: "doses", supplyUnit: "vials" })).toBe(2);
  });
  it("same unit takes the dose amount, 'doses' takes one", () => {
    expect(supplyPerDose({ type: "liquid", doseAmount: 5, doseUnit: "mL", supplyUnit: "mL" })).toBe(5);
    expect(supplyPerDose({ type: "infusion", doseAmount: 250, doseUnit: "mL", supplyUnit: "doses" })).toBe(1);
  });
  it("run-out date follows the schedule", () => {
    // 2 pens, 2 doses each, every 2 weeks from today 09:00 (after noon, so today's dose has passed)
    const m = { id: "i", name: "I", type: "injection", doseAmount: 40, doseUnit: "units", supplyUnit: "pens", perContainer: 2, stock: 2, times: ["09:00"], start: "2026-11-04", schedule: { kind: "everyNWeeks", n: 2 }, refillDays: 7, refillAt: 0 };
    const s = supply(m, NOW);
    // 4 doses cover 18 Nov, 2 Dec, 16 Dec, 30 Dec; the 13 Jan dose is the first it can't cover
    expect(dayKey(s.runOut)).toBe("2027-01-13");
    expect(s.daysLeft).toBe(70);
    expect(s.low).toBe(false);
    expect(supply({ ...m, stock: 0.5 }, NOW)).toMatchObject({ daysLeft: 28, low: false }); // covers 18 Nov only
    expect(supply({ ...m, stock: 0.5, refillDays: 28 }, NOW).low).toBe(true);
  });
  it("warns when low by count or days, for any type", () => {
    const pills = { ...med({ stock: 6, times: ["08:00", "20:00"] }), refillDays: 3, refillAt: 0 }; // 2 per dose, 4 a day
    const s = supply(pills, NOW); // tonight 2, tomorrow 4, nothing for the day after
    expect(s.daysLeft).toBe(2);
    expect(s.low).toBe(true);
    const vial = { type: "infusion", doseAmount: 100, doseUnit: "mL", supplyUnit: "bags", stock: 1, refillAt: 1, times: [], schedule: { kind: "prn" } };
    expect(supply(vial, NOW)).toMatchObject({ low: true, runOut: null, daysLeft: null });
    expect(supply({ ...vial, stock: 5 }, NOW).low).toBe(false);
  });
});

describe("old medicine migration", () => {
  it("defaults to a daily pill with its old pills per dose, keeping every field", () => {
    const old = { id: "x", name: "Metformin", strength: "500 mg", perDose: "2 tablets", times: ["08:00", "20:00"], stock: 9, fullCount: 60, refillAt: 10, slot: 2, color: "#000", notes: "With food", start: "2026-01-01" };
    const m = normalizeMed(old);
    expect(m).toMatchObject({ ...old, type: "pill", doseAmount: 2, doseUnit: "pills", supplyUnit: "pills", schedule: { kind: "daily" } });
    expect(normalizeMed(m)).toEqual(m);
    expect(doseLabel(old)).toBe("2 tablets");
    expect(medSummary(old)).toBe("Pill · 2 tablets · daily");
  });
  it("uses an explicit pillsPerDose and treats no times as as-needed", () => {
    expect(normalizeMed({ pillsPerDose: 3, perDose: "1 tablet", times: ["08:00"] }).doseAmount).toBe(3);
    expect(normalizeMed({ times: [] }).schedule).toEqual({ kind: "prn" });
    expect(normalizeMed({}).times).toEqual([]);
  });
  it("old meds keep behaving: due daily, stock math unchanged", () => {
    const old = { id: "x", name: "A", perDose: "1 tablet", times: ["08:00"], stock: 10 };
    expect(isDueOn(old, D(2026, 11, 4))).toBe(true);
    expect(supplyPerDose(old)).toBe(1);
    expect(dayKey(supply(old, NOW).runOut)).toBe("2026-11-15"); // 5–14 Nov covered (today's dose has passed)
  });
  it("summary for new types", () => {
    expect(medSummary({ type: "injection", doseAmount: 40, doseUnit: "units", times: ["09:00"], schedule: { kind: "everyNWeeks", n: 2 } })).toBe("Injection · 40 units · every 2 weeks");
    expect(medSummary({ type: "liquid", doseAmount: 1, doseUnit: "mL", times: [] })).toBe("Liquid · 1 mL · as needed");
  });
});

describe("logged dose times", () => {
  const T = (d, h, m) => new Date(2026, 10, d, h, m).toISOString();
  const day = "2026-11-04", now = new Date(2026, 10, 4, 12, 0).getTime();
  it("formats taken and skipped times, with the weekday when logged on another day", () => {
    expect(fmtLogged({ status: "taken", at: T(4, 8, 14) }, day)).toBe("Taken 8:14 AM");
    expect(fmtLogged({ status: "skipped", at: T(4, 8, 5) }, day)).toBe("Skipped 8:05 AM");
    expect(fmtLogged({ status: "taken", at: T(5, 0, 30) }, day)).toBe("Taken Thu 12:30 AM");
    expect(fmtLogged(undefined, day)).toBe("");
  });
  it("shows scheduled and logged time side by side", () => {
    expect(fmtDoseTimes({ day, time: "08:00", log: { status: "taken", at: T(4, 8, 14) } })).toBe("Scheduled 8:00 AM · Taken 8:14 AM");
    expect(fmtDoseTimes({ day, time: "08:00" })).toBe("Scheduled 8:00 AM");
  });
  it("starts the picker at now for today, the scheduled time for other days", () => {
    expect(defaultLogTime(day, "08:00", now)).toBe("12:00");
    expect(defaultLogTime("2026-11-03", "20:00", now)).toBe("20:00");
  });
  it("turns a picked time into the moment taken", () => {
    expect(logTimeFor(day, "08:00", "08:40", now).toISOString()).toBe(T(4, 8, 40));
    expect(logTimeFor(day, "20:00", "11:00", now).toISOString()).toBe(T(4, 11, 0)); // early dose, still in the past
    expect(logTimeFor(day, "08:00", "13:00", now)).toBeNull(); // future
    expect(logTimeFor(day, "08:00", "", now)).toBeNull();
  });
  it("changing a logged time keeps the day it was actually taken", () => {
    const later = new Date(2026, 10, 5, 7, 0).getTime();
    expect(editedLogTime(T(3, 9, 30), "09:45", later).toISOString()).toBe(T(3, 9, 45)); // Monday's dose taken Tuesday
    expect(editedLogTime(T(5, 0, 30), "23:50", later).toISOString()).toBe(T(4, 23, 50)); // back over midnight
    expect(editedLogTime(T(4, 23, 50), "00:20", later).toISOString()).toBe(T(5, 0, 20));
    expect(editedLogTime(T(4, 11, 0), "12:30", now)).toBeNull(); // future
    expect(editedLogTime(T(4, 11, 0), "", now)).toBeNull();
  });
  it("labels extra doses without a scheduled time", () => {
    expect(fmtDoseTimes({ day, time: "08:14", log: { status: "taken", extra: true, at: T(4, 8, 14) } })).toBe("Additional treatment · Taken 8:14 AM");
  });
  it("reads a time just after midnight as the next day for a late-evening dose", () => {
    const later = new Date(2026, 10, 5, 7, 0).getTime();
    expect(logTimeFor(day, "23:00", "00:30", later).toISOString()).toBe(T(5, 0, 30));
    expect(logTimeFor(day, "23:00", "22:50", later).toISOString()).toBe(T(4, 22, 50));
  });
});

describe("interval schedules count from the last dose taken", () => {
  const D = (d, h = 12, mi = 0, s = 0) => new Date(2026, 10, d, h, mi, s); // November 2026
  // Weekly on Mondays at 9:00, starting Mon 2 Nov
  const weekly = (o = {}) => sched({ kind: "everyNWeeks", n: 1, ...o }, { start: "2026-11-02", times: ["09:00"] });
  const taken = (day, time, at, o = {}) => ({ [doseKey("a", day, time)]: { medId: "a", day, time, slot: o.slot || time, status: "taken", at: at.toISOString(), ...o } });
  const lateTue = taken("2026-11-02", "09:00", D(3, 9, 30)); // Monday's dose taken late, Tuesday 9:30 AM
  const times = (m, date, doses) => dosesOn(date, [m], doses, { now: NOW }).map(d => d.time);

  it("weekly dose taken late Tuesday 9:30 AM is next due the next Tuesday 9:30 AM", () => {
    const m = weekly();
    expect(times(m, D(10), lateTue)).toEqual(["09:30"]);
    expect(times(m, D(9), lateTue)).toEqual([]); // not the fixed Monday any more
    expect(dosesOn(D(10), [m], lateTue, { now: NOW })[0].when).toBe(D(10, 9, 30).getTime());
    expect(times(m, D(17), lateTue)).toEqual(["09:30"]); // and every week after
    expect(isDueOn(m, D(10), lateTue)).toBe(true);
    expect(isDueOn(m, D(9), lateTue)).toBe(false);
  });
  it("the logged day keeps its time, so history doesn't move", () => {
    const [d] = dosesOn(D(2), [weekly()], lateTue, { now: NOW });
    expect([d.time, d.status]).toEqual(["09:00", "taken"]);
  });
  it("falls back to the start date and set times with no dose taken", () => {
    expect(times(weekly(), D(9), {})).toEqual(["09:00"]);
    expect(times(weekly(), D(10), {})).toEqual([]);
  });
  it("Keep fixed schedule ignores the log", () => {
    const m = weekly({ fixed: true });
    expect(times(m, D(9), lateTue)).toEqual(["09:00"]);
    expect(times(m, D(10), lateTue)).toEqual([]);
    expect(doseAnchors(m, lateTue)).toEqual([]);
    expect(reminderPlan([m], lateTue, { now: NOW, days: 14 }).map(r => [r.day, r.time])).toEqual([["2026-11-09", "09:00"], ["2026-11-16", "09:00"]]);
  });
  it("rounds the taken time to the minute", () => {
    expect(times(weekly(), D(10), taken("2026-11-02", "09:00", D(3, 9, 29, 40)))).toEqual(["09:30"]);
  });
  it("alarms follow the new time", () => {
    const plan = reminderPlan([weekly()], lateTue, { now: NOW, days: 14 });
    expect(plan.map(r => [r.day, r.time, r.at.getTime()])).toEqual([["2026-11-10", "09:30", D(10, 9, 30).getTime()], ["2026-11-17", "09:30", D(17, 9, 30).getTime()]]);
    expect(new Set(plan.map(r => r.id)).size).toBe(2);
    const extra = { day: "2026-11-10", time: "09:30", medIds: ["a"] };
    expect(dosesForReminder(extra, [weekly()], lateTue, NOW).map(d => d.key)).toEqual([doseKey("a", "2026-11-10", "09:30")]);
  });
  it("missed-dose logic uses the new due time", () => {
    const m = weekly();
    expect(patientStatus([m], lateTue, D(9, 11).getTime()).missed).toEqual([]); // fixed Monday isn't missed
    expect(patientStatus([m], lateTue, D(10, 10).getTime()).level).toBe("due"); // 9:30 + 30 min
    expect(patientStatus([m], lateTue, D(10, 11).getTime()).missed.map(d => d.key)).toEqual([doseKey("a", "2026-11-10", "09:30")]);
  });
  it("each dose taken moves the next one; earlier days stay put", () => {
    const doses = { ...lateTue, ...taken("2026-11-10", "09:30", D(11, 8, 15), { slot: "09:00" }) }; // taken the next morning
    const m = weekly();
    expect(dosesOn(D(10), [m], doses, { now: NOW }).map(d => [d.time, d.status])).toEqual([["09:30", "taken"]]);
    expect(times(m, D(11), doses)).toEqual([]);
    expect(times(m, D(17), doses)).toEqual([]);
    expect(times(m, D(18), doses)).toEqual(["08:15"]);
  });
  it("a missed dose keeps the cadence from the last one taken", () => {
    expect(times(weekly(), D(24), lateTue)).toEqual(["09:30"]); // 10th and 17th missed
  });
  it("skipped and extra doses don't move the schedule", () => {
    const m = weekly();
    expect(times(m, D(9), taken("2026-11-02", "09:00", D(3, 9, 30), { status: "skipped" }))).toEqual(["09:00"]);
    expect(times(m, D(9), { x: { medId: "a", day: "2026-11-03", time: "09:30", status: "taken", extra: true, at: D(3, 9, 30).toISOString() } })).toEqual(["09:00"]);
  });
  it("every N days and monthly", () => {
    const every3 = sched({ kind: "everyNDays", n: 3 }, { start: "2026-11-01", times: ["08:00"] });
    expect(times(every3, D(7), taken("2026-11-04", "08:00", D(4, 14, 5)))).toEqual(["14:05"]);
    const monthly = med({ start: "2026-01-01", times: ["10:00"], schedule: { kind: "monthly", dayOfMonth: 31 } });
    const jan = taken("2026-01-31", "10:00", new Date(2026, 0, 31, 18, 45));
    expect(scheduledOn(monthly, new Date(2026, 1, 28), jan).map(s => s.time)).toEqual(["18:45"]); // last day of Feb
    expect(scheduledOn(monthly, new Date(2026, 2, 31), jan).map(s => s.time)).toEqual(["18:45"]);
    expect(scheduledOn(monthly, new Date(2026, 2, 30), jan)).toEqual([]);
  });
  it("other times of day keep their distance from the dose taken", () => {
    const m = sched({ kind: "everyNDays", n: 2 }, { start: "2026-11-02", times: ["08:00", "20:00"] });
    const doses = taken("2026-11-04", "08:00", D(4, 9, 0));
    expect(times(m, D(6), doses)).toEqual(["09:00", "21:00"]);
    expect(dosesOn(D(6), [m], doses, { now: NOW }).map(d => d.slot)).toEqual(["08:00", "20:00"]);
  });
  it("daily and weekday schedules aren't affected", () => {
    const m = sched({ kind: "daily" }, { times: ["09:00"] });
    expect(times(m, D(5), taken("2026-11-04", "09:00", D(4, 11, 0)))).toEqual(["09:00"]);
  });
  it("correcting an earlier dose's time doesn't orphan later doses logged at the old time", () => {
    const m = weekly();
    const doses = { ...taken("2026-11-02", "09:00", D(2, 9, 30)), ...taken("2026-11-09", "09:30", D(9, 9, 31), { slot: "09:00" }) };
    expect(times(m, D(9), doses)).toEqual(["09:30"]);
    doses[doseKey("a", "2026-11-02", "09:00")].at = D(2, 10, 0).toISOString(); // Nov 2 corrected to 10:00
    expect(dosesOn(D(9), [m], doses, { now: NOW }).map(d => [d.time, d.status, d.key])).toEqual([["09:30", "taken", doseKey("a", "2026-11-09", "09:30")]]);
    expect(reminderPlan([m], doses, { now: D(9, 8).getTime(), days: 14 }).map(r => [r.day, r.time])).toEqual([["2026-11-16", "09:31"]]);
    expect(adherence([m], doses, 14, D(10).getTime()).pct).toBe(100);
  });
  it("run-out date follows the new timing", () => {
    const m = { ...weekly(), stock: 2 }; // 2 pills a dose: covers one
    // now Wed 4 Nov: next fixed dose would be Mon 9 Nov; counted from Tuesday's dose it's Tue 10 Nov, then the 17th
    expect(dayKey(supply(m, NOW, lateTue).runOut)).toBe("2026-11-17");
    expect(dayKey(supply(m, NOW).runOut)).toBe("2026-11-16");
    expect([supply(m, NOW, lateTue).daysLeft, supply(m, NOW).daysLeft]).toEqual([13, 12]);
  });
});

describe("low supply uses the time passed in", () => {
  it("patientStatus and lowStock check supply at `now`, not the real clock", () => {
    const now2020 = new Date(2020, 0, 1, 7, 0).getTime();
    const m = { id: "a", name: "A", times: ["08:00"], start: "2020-01-01", end: "2020-03-01", stock: 3, refillAt: 0, refillDays: 7 };
    expect(lowStock([m], {}, now2020).map(x => x.id)).toEqual(["a"]);
    expect(patientStatus([m], {}, now2020).low.map(x => x.id)).toEqual(["a"]);
    expect(lowStock([m], {}, new Date(2026, 10, 4).getTime())).toEqual([]); // after its end date
  });
});

// ---- adherence progress ----
import { ON_TIME_WINDOW_MIN, isOnTime, dayOnTime, onTimeRate, onTimeStreak, badgesFor, encouragement, adherenceProgress, BADGES } from "./model.js";
import { medToIcs, rruleOf, calendarStarts } from "./model.js";

describe("adherence progress", () => {
  const daily = (o = {}) => ({ id: "d", name: "D", times: ["08:00"], schedule: { kind: "daily" }, start: "2026-01-01", ...o });
  const dayOff = i => { const d = new Date(NOW); d.setDate(d.getDate() - i); return dayKey(d); };
  // a taken log for the 08:00 dose `i` days before NOW, taken at hh:mm that day
  const took = (i, hhmm, id = "d", time = "08:00") => { const day = dayOff(i), [h, m] = hhmm.split(":").map(Number), at = parseDay(day); at.setHours(h, m); return [doseKey(id, day, time), { medId: id, day, time, slot: time, status: "taken", at: at.toISOString() }]; };
  const logs = (...entries) => Object.fromEntries(entries);

  it("uses a 60 minute window, inclusive at both edges", () => {
    expect(ON_TIME_WINDOW_MIN).toBe(60);
    const when = new Date(2026, 10, 4, 8, 0).getTime(), d = at => ({ when, log: { status: "taken", at: new Date(at).toISOString() } });
    expect(isOnTime(d(when + 60 * 60000))).toBe(true);
    expect(isOnTime(d(when - 60 * 60000))).toBe(true);
    expect(isOnTime(d(when + 61 * 60000))).toBe(false);
    expect(isOnTime(d(when - 61 * 60000))).toBe(false);
    expect(isOnTime({ when, log: { status: "skipped", at: new Date(when).toISOString() } })).toBe(false);
    expect(isOnTime({ when })).toBe(false);
  });

  it("counts on-time, late and missed doses in a day", () => {
    const yest = parseDay(dayOff(1));
    expect(dayOnTime(yest, [daily()], logs(took(1, "09:00")), NOW)).toEqual({ total: 1, onTime: 1, open: 0, failed: 0 });
    expect(dayOnTime(yest, [daily()], logs(took(1, "09:01")), NOW)).toMatchObject({ onTime: 0, failed: 1 });
    expect(dayOnTime(yest, [daily()], {}, NOW)).toMatchObject({ onTime: 0, failed: 1 });
  });

  it("leaves as-needed medicines and extra doses out", () => {
    const prn = { id: "p", name: "P", times: [], schedule: { kind: "prn" } };
    const extra = { ["extra_p_1"]: { medId: "p", day: today, time: "10:00", status: "taken", at: new Date(NOW).toISOString(), extra: true } };
    expect(dayOnTime(new Date(NOW), [prn], extra, NOW).total).toBe(0);
    expect(onTimeRate([prn], extra, 7, NOW)).toEqual({ onTime: 0, total: 0, pct: null });
    expect(onTimeStreak([prn], extra, NOW)).toBe(0);
    // a prn medicine next to a daily one doesn't change the daily one's numbers
    const d = logs(took(1, "08:00"));
    expect(onTimeRate([daily(), prn], d, 7, NOW)).toEqual(onTimeRate([daily()], d, 7, NOW));
  });

  it("computes 7- and 30-day rates, not counting doses still open", () => {
    const med = daily({ times: ["08:00", "20:00"] });
    // 6 past days fully on time for 08:00, 20:00 never taken; today 08:00 on time, 20:00 still to come
    const d = logs(...[0, 1, 2, 3, 4, 5, 6].map(i => took(i, "08:10")));
    expect(onTimeRate([med], d, 7, NOW)).toEqual({ onTime: 7, total: 13, pct: 54 });
    const r30 = onTimeRate([med], d, 30, NOW);
    expect(r30).toEqual({ onTime: 7, total: 59, pct: 12 });
  });

  it("respects the start date in rates", () => {
    const med = daily({ start: dayOff(2) });
    expect(onTimeRate([med], logs(took(0, "08:00"), took(1, "08:00"), took(2, "08:00")), 30, NOW)).toEqual({ onTime: 3, total: 3, pct: 100 });
  });

  it("counts a streak of fully on-time days", () => {
    const d = logs(took(0, "08:30"), took(1, "08:00"), took(2, "07:15"), took(3, "10:00"), took(4, "08:00"));
    expect(onTimeStreak([daily()], d, NOW)).toBe(3); // day 3 was 2 h late
  });

  it("doesn't break the streak for today while it's still open, but counts it once complete", () => {
    const med = daily({ times: ["08:00", "20:00"] });
    const past = [1, 2].flatMap(i => [took(i, "08:00"), took(i, "20:00", "d", "20:00")]);
    const withMorning = logs(...past, took(0, "08:00"));
    expect(onTimeStreak([med], withMorning, NOW)).toBe(2); // 20:00 still to come
    const late = new Date(2026, 10, 4, 20, 30).getTime();
    expect(onTimeStreak([med], logs(...past, took(0, "08:00"), took(0, "20:05", "d", "20:00")), late)).toBe(3);
  });

  it("an already-missed dose today breaks the streak", () => {
    const d = logs(took(1, "08:00"), took(2, "08:00"));
    expect(onTimeStreak([daily()], d, NOW)).toBe(0); // 08:00 today not taken, now noon
    expect(onTimeStreak([daily()], d, new Date(2026, 10, 4, 8, 30).getTime())).toBe(2); // still within the window
  });

  it("skips days with nothing scheduled", () => {
    // Mon, Wed, Fri only; NOW is Wed 4 Nov → Mon 2, Fri 30 Oct, Wed 28 Oct
    const med = daily({ schedule: { kind: "weekdays", days: [1, 3, 5] } });
    const d = logs(took(0, "08:00"), took(2, "08:00"), took(5, "08:00"), took(7, "08:00"));
    expect(onTimeStreak([med], d, NOW)).toBe(4);
  });

  it("awards badges at 3, 7, 14 and 30 days", () => {
    expect(BADGES.map(b => b.days)).toEqual([3, 7, 14, 30]);
    expect(badgesFor(2)).toEqual([]);
    expect(badgesFor(3).map(b => b.days)).toEqual([3]);
    expect(badgesFor(13).map(b => b.days)).toEqual([3, 7]);
    expect(badgesFor(30).map(b => b.days)).toEqual([3, 7, 14, 30]);
    expect(BADGES.every(b => b.emoji && b.label)).toBe(true);
  });

  it("writes an encouraging message", () => {
    expect(encouragement(0, null)).toMatch(/3 more days/);
    expect(encouragement(5, 100)).toMatch(/5 days in a row.*2 more days to/);
    expect(encouragement(6, 100)).toMatch(/1 more day to/);
    expect(encouragement(45, 100)).toMatch(/month/);
  });

  it("puts it together for the Today card", () => {
    const d = logs(...Array.from({ length: 8 }, (_, i) => took(i, "08:00")));
    const a = adherenceProgress([daily()], d, NOW);
    expect(a.streak).toBe(8);
    expect(a.rate7).toEqual({ onTime: 7, total: 7, pct: 100 });
    expect(a.badges.map(b => b.days)).toEqual([3, 7]);
    expect(a.message).toMatch(/8 days in a row/);
  });
});

// ---- .ics export ----
describe("medToIcs", () => {
  const base = { id: "m1", name: "Metformin", strength: "500 mg", type: "pill", doseAmount: 2, times: ["08:00", "20:00"], start: "2026-10-01" };
  const lines = ics => ics.replace(/\r\n /g, "").split("\r\n");

  it("makes one repeating event per time of day, with CRLF line endings", () => {
    const ics = medToIcs({ ...base, schedule: { kind: "daily" } }, {}, NOW);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("\r\n").every(l => new TextEncoder().encode(l).length <= 75)).toBe(true);
    const l = lines(ics);
    expect(l.filter(x => x === "BEGIN:VEVENT")).toHaveLength(2);
    expect(l).toContain("DTSTART:20261104T080000");
    expect(l).toContain("DTEND:20261104T081500");
    expect(l).toContain("DTSTART:20261104T200000");
    expect(l.filter(x => x === "RRULE:FREQ=DAILY")).toHaveLength(2);
    expect(l).toContain("UID:m1-0800@pillbox");
    expect(l.find(x => x.startsWith("SUMMARY:"))).toBe("SUMMARY:💊 Metformin 500 mg (2 pills)");
  });

  it("writes RRULEs for each schedule", () => {
    expect(rruleOf({ ...base, schedule: { kind: "weekdays", days: [5, 1, 3] } })).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    expect(rruleOf({ ...base, schedule: { kind: "everyNDays", n: 3 } })).toBe("FREQ=DAILY;INTERVAL=3");
    expect(rruleOf({ ...base, schedule: { kind: "everyNWeeks", n: 2 } })).toBe("FREQ=WEEKLY;INTERVAL=2");
    expect(rruleOf({ ...base, schedule: { kind: "monthly", dayOfMonth: 15 } })).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
    expect(rruleOf({ ...base, schedule: { kind: "monthly", dayOfMonth: 31 } })).toBe("FREQ=MONTHLY;BYMONTHDAY=28,29,30,31;BYSETPOS=-1");
    expect(rruleOf({ ...base, end: "2026-12-31", schedule: { kind: "daily" } })).toBe("FREQ=DAILY;UNTIL=20261231T235959");
    expect(rruleOf({ ...base, times: [], schedule: { kind: "prn" } })).toBe(null);
  });

  it("starts on the next scheduled day", () => {
    // every 3 days from 2 Oct: ... 1 Nov, 4 Nov → today; from 1 Oct: ... 31 Oct, 3 Nov, 6 Nov
    expect(calendarStarts({ ...base, start: "2026-10-02", schedule: { kind: "everyNDays", n: 3, fixed: true } }, {}, NOW)[0].start).toEqual(new Date(2026, 10, 4, 8, 0));
    expect(calendarStarts({ ...base, schedule: { kind: "everyNDays", n: 3, fixed: true } }, {}, NOW)[0].start).toEqual(new Date(2026, 10, 6, 8, 0));
    expect(lines(medToIcs({ ...base, times: ["09:00"], schedule: { kind: "monthly", dayOfMonth: 20 } }, {}, NOW))).toContain("DTSTART:20261120T090000");
  });

  it("follows the last dose taken for interval schedules", () => {
    const m = { ...base, times: ["09:00"], schedule: { kind: "everyNWeeks", n: 1 } };
    // taken Tue 3 Nov at 10:30 → next Tue 10 Nov 10:30
    const doses = { [doseKey("m1", "2026-11-03", "09:00")]: { medId: "m1", day: "2026-11-03", time: "09:00", slot: "09:00", status: "taken", at: new Date(2026, 10, 3, 10, 30).toISOString() } };
    expect(lines(medToIcs(m, doses, NOW))).toContain("DTSTART:20261110T103000");
  });

  it("escapes text and is empty for as-needed or ended medicines", () => {
    const ics = medToIcs({ ...base, name: "A, B; C", notes: "With food\nno alcohol", schedule: { kind: "daily" } }, {}, NOW);
    expect(lines(ics).find(x => x.startsWith("SUMMARY:"))).toContain("A\\, B\; C");
    expect(lines(ics).find(x => x.startsWith("DESCRIPTION:"))).toContain("With food\\nno alcohol");
    expect(medToIcs({ ...base, times: [], schedule: { kind: "prn" } }, {}, NOW)).toBe("");
    expect(medToIcs({ ...base, end: "2026-11-01", schedule: { kind: "daily" } }, {}, NOW)).toBe("");
  });
});

import { EVENT_TYPES, BODY_AREAS, SEVERITIES, BLEED_CAUSES, normalizeEvent, eventsOn, eventLabel, recentDosesForLink, doseLinkLabel } from "./model.js";

describe("event constants", () => {
  it("has the five types with label and icon", () => {
    expect(Object.keys(EVENT_TYPES)).toEqual(["bleed", "sideEffect", "symptom", "activity", "other"]);
    for (const t of Object.values(EVENT_TYPES)) { expect(t.label).toBeTruthy(); expect(t.icon).toBeTruthy(); }
  });
  it("has body areas, severities and bleed causes", () => {
    expect(BODY_AREAS.leftKnee).toBe("Left knee");
    expect(BODY_AREAS.mouth).toBe("Mouth / gums");
    expect(BODY_AREAS.other).toBe("Other");
    expect(SEVERITIES).toEqual({ 1: "Mild", 2: "Moderate", 3: "Severe" });
    expect(Object.keys(BLEED_CAUSES)).toEqual(["spontaneous", "injury", "unknown"]);
  });
});

describe("normalizeEvent", () => {
  const at = new Date(2026, 10, 4, 9, 30);
  it("keeps valid bleed fields and trims notes", () => {
    const e = normalizeEvent({ id: "e1", type: "bleed", at: at.toISOString(), area: "leftKnee", severity: "2", cause: "injury", treatedWith: "k1", notes: "  swollen  ", by: "patient", byName: "Me" });
    expect(e).toEqual({ id: "e1", type: "bleed", at: at.toISOString(), day: "2026-11-04", area: "leftKnee", severity: 2, cause: "injury", durationMin: null, treatedWith: "k1", notes: "swollen", by: "patient", byName: "Me" });
  });
  it("only keeps a cause for bleeds and a duration for activity", () => {
    const s = normalizeEvent({ type: "symptom", at, cause: "injury", durationMin: 30 });
    expect(s.cause).toBeNull(); expect(s.durationMin).toBeNull();
    const a = normalizeEvent({ type: "activity", at, cause: "injury", durationMin: "44.6" });
    expect(a.cause).toBeNull(); expect(a.durationMin).toBe(45);
    expect(normalizeEvent({ type: "activity", at, durationMin: 0 }).durationMin).toBeNull();
    expect(normalizeEvent({ type: "activity", at, durationMin: "" }).durationMin).toBeNull();
    expect(normalizeEvent({ type: "activity", at, durationMin: -5 }).durationMin).toBeNull();
  });
  it("drops unknown values", () => {
    const e = normalizeEvent({ type: "nope", at, area: "tail", severity: 4, cause: "magic", notes: 5, treatedWith: "  " });
    expect(e.type).toBe("other"); expect(e.area).toBeNull(); expect(e.severity).toBeNull();
    expect(e.cause).toBeNull(); expect(e.notes).toBe(""); expect(e.treatedWith).toBeNull();
    expect(normalizeEvent({ type: "bleed", at, severity: 1.5 }).severity).toBeNull();
    expect(normalizeEvent({ type: "bleed", at, severity: 0 }).severity).toBeNull();
    expect(normalizeEvent({ type: "bleed", at, cause: "magic" }).cause).toBeNull();
  });
  it("makes `at` an ISO time (Date, ms or string), falling back to now", () => {
    expect(normalizeEvent({ at }).at).toBe(at.toISOString());
    expect(normalizeEvent({ at: at.getTime() }).at).toBe(at.toISOString());
    const e = normalizeEvent({ at: "garbage" }, NOW);
    expect(e.at).toBe(new Date(NOW).toISOString()); expect(e.day).toBe(today);
  });
  it("gives a new event an id and is idempotent", () => {
    const e = normalizeEvent({ type: "bleed", at, area: "rightAnkle", severity: 3, cause: "spontaneous", createdAt: 5 });
    expect(e.id).toMatch(/\w+/);
    expect(normalizeEvent(e)).toEqual(e);
  });
});

describe("eventsOn", () => {
  const ev = (id, h, d = 4) => ({ id, type: "other", at: new Date(2026, 10, d, h).toISOString() });
  it("lists one day's events earliest first, from a map or an array", () => {
    const map = { a: ev("a", 18), b: ev("b", 7), c: ev("c", 12, 5) };
    expect(eventsOn(new Date(2026, 10, 4), map).map(e => e.id)).toEqual(["b", "a"]);
    expect(eventsOn(new Date(2026, 10, 5), Object.values(map)).map(e => e.id)).toEqual(["c"]);
    expect(eventsOn(new Date(2026, 10, 6), map)).toEqual([]);
    expect(eventsOn(new Date(), undefined)).toEqual([]);
  });
});

describe("eventLabel", () => {
  it("summarises type, place, duration, severity and cause", () => {
    expect(eventLabel({ type: "bleed", area: "leftKnee", severity: 2, cause: "injury" })).toBe("Bleed · Left knee · Moderate · Injury");
    expect(eventLabel({ type: "activity", durationMin: 90, severity: 1 })).toBe("Activity · 1 h 30 min · Mild");
    expect(eventLabel({ type: "sideEffect" })).toBe("Side effect");
    expect(eventLabel({ type: "symptom", cause: "injury", area: "head" })).toBe("Symptom · Head");
    expect(eventLabel({ type: "weird" })).toBe("Other");
  });
});

describe("recentDosesForLink", () => {
  const meds = [{ id: "f8", name: "Factor VIII", strength: "2000 IU" }, { id: "x", name: "Ibuprofen" }];
  const hoursAgo = h => new Date(NOW - h * 3600000).toISOString();
  const doses = {
    k1: { medId: "f8", status: "taken", at: hoursAgo(2) },
    k2: { medId: "x", status: "taken", at: hoursAgo(30) },
    k3: { medId: "f8", status: "skipped", at: hoursAgo(1) },
    k4: { medId: "f8", status: "taken", at: hoursAgo(50) },
    k5: { medId: "gone", status: "taken", at: hoursAgo(5) },
    k6: { medId: "f8", status: "taken", at: new Date(NOW + 3 * 3600000).toISOString() },
  };
  it("lists taken doses within the window, newest first", () => {
    const list = recentDosesForLink(meds, doses, NOW);
    expect(list.map(d => d.key)).toEqual(["k1", "k5", "k2"]);
    expect(list[0]).toEqual({ key: "k1", label: "Factor VIII 2000 IU · 10:00 AM", at: hoursAgo(2) });
    expect(list[1].label).toBe("Medicine · 7:00 AM");
    expect(list[2].label).toBe("Ibuprofen · Tue 6:00 AM");
  });
  it("respects the hours window", () => {
    expect(recentDosesForLink(meds, doses, NOW, 3).map(d => d.key)).toEqual(["k1"]);
    expect(recentDosesForLink(meds, doses, NOW, 72).map(d => d.key)).toEqual(["k1", "k5", "k2", "k4"]);
    expect(recentDosesForLink(meds, {}, NOW)).toEqual([]);
  });
  it("labels a single dose", () => {
    expect(doseLinkLabel(doses.k1, meds, NOW)).toBe("Factor VIII 2000 IU · 10:00 AM");
  });
});
