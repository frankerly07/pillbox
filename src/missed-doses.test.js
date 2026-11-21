import { describe, it, expect } from "vitest";
import { commitAdministration, doseHistory } from "./dose-log.js";
import { findMissedDoses, intervalDays, logMoment, defaultLogMoment, daySummary, dosesOn, normalizeMed, dayKey, parseDay, doseKey } from "./model.js";

const NOW = new Date(2026, 10, 21, 12, 0).getTime(); // Sat 21 Nov 2026 noon
const actor = { uid: "me", name: "Me", uiRole: "patient" };
const daysAgo = (n, from = NOW) => { const d = new Date(from); d.setDate(d.getDate() - n); return dayKey(d); };

const daily = (extra = {}) => normalizeMed({ id: "d", name: "Daily", type: "pill", doseAmount: 1, times: ["20:30"], schedule: { kind: "daily" }, start: daysAgo(60), stock: 10, ...extra });
const himlibra = (extra = {}) => normalizeMed({ id: "h", name: "Himlibra 6000iu", type: "injection", doseAmount: 1, doseUnit: "units", supplyUnit: "doses", times: ["20:30"], schedule: { kind: "everyNWeeks", n: 2 }, stock: 5, ...extra });
const prn = () => normalizeMed({ id: "p", name: "Pain relief", type: "pill", doseAmount: 1, times: [], schedule: { kind: "prn" }, stock: 20 });
const patient = (meds, doses = {}) => ({ id: "me", meds, doses, stockLog: [], doseAudit: [], appliedOps: [] });
const days = list => list.map(d => d.day);

describe("findMissedDoses", () => {
  it("lists a daily dose missed yesterday with its scheduled date and time", () => {
    const list = findMissedDoses([daily()], {}, { now: NOW });
    expect(list[0].day).toBe(daysAgo(1));
    expect(list[0].time).toBe("20:30");
    expect(list[0].key).toBe(doseKey("d", daysAgo(1), "20:30"));
    expect(list[0].med.id).toBe("d");
  });

  it("counts today's dose only once its time (plus the due window) has passed", () => {
    const med = daily({ times: ["08:00"] });
    const at = (h, m = 0) => new Date(2026, 10, 21, h, m).getTime();
    expect(days(findMissedDoses([med], {}, { now: at(7, 0) }))).not.toContain("2026-11-21");
    expect(days(findMissedDoses([med], {}, { now: at(8, 30) }))).not.toContain("2026-11-21"); // still inside the 60 min window
    expect(days(findMissedDoses([med], {}, { now: at(9, 5) }))[0]).toBe("2026-11-21");
    expect(days(findMissedDoses([med], {}, { now: at(8, 1), dueWindowMin: 0 }))[0]).toBe("2026-11-21");
  });

  it("leaves out doses logged as taken or skipped", () => {
    let p = patient([daily()]);
    const k1 = doseKey("d", daysAgo(1), "20:30"), k2 = doseKey("d", daysAgo(2), "20:30");
    p = commitAdministration(p, { opId: "o1", kind: "log", medId: "d", key: k1, day: daysAgo(1), time: "20:30", slot: "20:30", at: new Date(NOW - 86400000).toISOString(), actor }, NOW).patient;
    p = commitAdministration(p, { opId: "o2", kind: "skip", medId: "d", key: k2, day: daysAgo(2), time: "20:30", slot: "20:30", at: new Date(NOW).toISOString(), actor }, NOW).patient;
    const got = days(findMissedDoses(p.meds, p.doses, { now: NOW }));
    expect(got).not.toContain(daysAgo(1));
    expect(got).not.toContain(daysAgo(2));
    expect(got).toContain(daysAgo(3));
  });

  it("looks back 7 days for a daily medicine, newest first", () => {
    const list = findMissedDoses([daily({ times: ["08:00"] })], {}, { now: NOW });
    expect(days(list)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(n => daysAgo(n)));
    for (let i = 1; i < list.length; i++) expect(list[i - 1].when).toBeGreaterThan(list[i].when);
  });

  it("keeps an every-2-weeks injection missed 10 days ago, but not one 20 days ago", () => {
    expect(days(findMissedDoses([himlibra({ start: daysAgo(10) })], {}, { now: NOW }))).toEqual([daysAgo(10)]);
    const old = days(findMissedDoses([himlibra({ start: daysAgo(20) })], {}, { now: NOW }));
    expect(old).not.toContain(daysAgo(20));
    expect(old).toEqual([daysAgo(6)]); // the next one in the series is listed
    expect(intervalDays(himlibra())).toBe(14);
    expect(intervalDays(daily())).toBe(1);
  });

  it("never lists as-needed medicines", () => {
    expect(findMissedDoses([prn()], {}, { now: NOW })).toEqual([]);
  });

  it("respects the start date, end date and when the medicine was added", () => {
    expect(days(findMissedDoses([daily({ start: daysAgo(2) })], {}, { now: NOW }))).toEqual([daysAgo(1), daysAgo(2)]);
    expect(days(findMissedDoses([daily({ end: daysAgo(5) })], {}, { now: NOW }))).toEqual([daysAgo(5), daysAgo(6), daysAgo(7)]);
    const added = new Date(NOW); added.setDate(added.getDate() - 2); added.setHours(21, 0, 0, 0); // added after that evening's dose
    expect(days(findMissedDoses([daily({ createdAt: added.getTime() })], {}, { now: NOW }))).toEqual([daysAgo(1)]);
  });
});

describe("log sheet date + time", () => {
  it("defaults to the scheduled date and time, or now when that hasn't happened yet", () => {
    expect(defaultLogMoment(daysAgo(3), "20:30", NOW)).toEqual({ day: daysAgo(3), time: "20:30" });
    expect(defaultLogMoment(daysAgo(0), "20:30", NOW)).toEqual({ day: daysAgo(0), time: "12:00" });
  });
  it("builds the local moment and refuses the future or a bad value", () => {
    const m = logMoment(daysAgo(3), "20:30", NOW);
    expect(dayKey(m.at)).toBe(daysAgo(3));
    expect(m.at.getHours()).toBe(20);
    expect(logMoment(daysAgo(0), "12:30", NOW)).toEqual({ error: "future" });
    expect(logMoment(daysAgo(-1), "08:00", NOW)).toEqual({ error: "future" });
    expect(logMoment("", "08:00", NOW)).toEqual({ error: "invalid" });
    expect(logMoment(daysAgo(1), "", NOW)).toEqual({ error: "invalid" });
    expect(logMoment("2026-02-31", "08:00", NOW)).toEqual({ error: "invalid" });
  });
});

describe("logging a dose for an earlier day", () => {
  it("attaches to that day's dose, marks the day taken, and counts the supply once", () => {
    let p = patient([daily()]);
    const day = daysAgo(3);
    const missed = findMissedDoses(p.meds, p.doses, { now: NOW }).find(d => d.day === day);
    expect(missed).toBeTruthy();
    expect(daySummary(parseDay(day), p.meds, p.doses, { now: NOW })).toMatchObject({ taken: 0, total: 1 });

    const when = logMoment(day, "20:45", NOW).at;
    const cmd = { opId: "late1", kind: "log", medId: "d", key: missed.key, extra: false, slot: missed.slot, day: missed.day, time: missed.time, at: when.toISOString(), actor };
    const res = commitAdministration(p, cmd, NOW);
    expect(res.code).toBe("applied");
    expect(res.key).toBe(doseKey("d", day, "20:30"));
    expect(res.dose.day).toBe(day);
    p = res.patient;
    expect(p.meds[0].stock).toBe(9);

    const sum = daySummary(parseDay(day), p.meds, p.doses, { now: NOW });
    expect(sum).toMatchObject({ state: "all", taken: 1, total: 1 });
    expect(dosesOn(parseDay(day), p.meds, p.doses, { now: NOW })[0].status).toBe("taken");
    expect(days(findMissedDoses(p.meds, p.doses, { now: NOW }))).not.toContain(day);
    expect(doseHistory(p.meds[0], p.doses).days[0].day).toBe(day);

    // the same save arriving twice, or a second log for that dose, doesn't move the count again
    expect(commitAdministration(p, cmd, NOW).patient.meds[0].stock).toBe(9);
    const again = commitAdministration(p, { ...cmd, opId: "late2" }, NOW);
    expect(again.code).toBe("already-logged");
    // undo puts the supply back and the dose is missed again
    const undone = commitAdministration(p, { opId: "rm1", kind: "remove", medId: "d", key: res.key, actor }, NOW).patient;
    expect(undone.meds[0].stock).toBe(10);
    expect(days(findMissedDoses(undone.meds, undone.doses, { now: NOW }))).toContain(day);
  });

  it("rejects a date and time in the future", () => {
    const p = patient([daily()]);
    const key = doseKey("d", daysAgo(0), "20:30");
    const res = commitAdministration(p, { opId: "f1", kind: "log", medId: "d", key, day: daysAgo(0), time: "20:30", slot: "20:30", at: new Date(2026, 10, 21, 20, 30).toISOString(), actor }, NOW);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("future");
    expect(logMoment(daysAgo(0), "20:30", NOW).error).toBe("future");
  });

  it("a late every-2-weeks injection clears the missed dose and restarts the interval", () => {
    let p = patient([himlibra({ start: daysAgo(10) })]);
    const [missed] = findMissedDoses(p.meds, p.doses, { now: NOW });
    const when = logMoment(missed.day, "21:00", NOW).at;
    p = commitAdministration(p, { opId: "h1", kind: "log", medId: "h", key: missed.key, slot: missed.slot, day: missed.day, time: missed.time, at: when.toISOString(), actor }, NOW).patient;
    expect(p.meds[0].stock).toBe(4);
    expect(findMissedDoses(p.meds, p.doses, { now: NOW })).toEqual([]);
    expect(daySummary(parseDay(missed.day), p.meds, p.doses, { now: NOW })).toMatchObject({ taken: 1, total: 1 });
  });
});
