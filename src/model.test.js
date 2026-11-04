import { describe, it, expect } from "vitest";
import { pillsTaken, reminderPlan, dosesForReminder, doseKey, dayKey } from "./model.js";

const med = (o = {}) => ({ id: "a", name: "A", perDose: "2 tablets", times: ["08:00", "20:00"], ...o });
const NOW = new Date(2026, 10, 4, 12, 0).getTime(); // Wed 4 Nov 2026, noon
const today = dayKey(new Date(NOW)), tomorrow = dayKey(new Date(2026, 10, 5));

describe("pillsTaken", () => {
  it("is 0 for no record or a skipped dose", () => {
    expect(pillsTaken(undefined, med())).toBe(0);
    expect(pillsTaken({ status: "skipped" }, med())).toBe(0);
  });
  it("uses the pills saved on the record", () => {
    expect(pillsTaken({ status: "taken", pills: 3 }, med())).toBe(3);
  });
  it("falls back to the medicine for older records", () => {
    expect(pillsTaken({ status: "taken" }, med())).toBe(2);
    expect(pillsTaken({ status: "taken" }, undefined)).toBe(1);
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
