import { describe, it, expect } from "vitest";
import { commitAdministration, supplyUsed, doseHistory, historyNoun, historyCount } from "./dose-log.js";
import { doseAnchors, dosesOn, normalizeMed, scheduledOn, supplyPerDose, doseKey, dayKey } from "./model.js";

const NOW = new Date(2026, 10, 4, 12, 0).getTime(); // Wed 4 Nov 2026 noon
const actor = { uid: "me", name: "Me", uiRole: "patient" };

function pills(stock = 10) {
  return {
    id: "p", ownerUid: "me", name: "Me",
    meds: [normalizeMed({ id: "a", name: "A", perDose: "2 tablets", times: ["08:00", "20:00"], stock, schedule: { kind: "daily" }, doseAmount: 2, doseUnit: "pills", supplyUnit: "pills", type: "pill" })],
    doses: {}, stockLog: [], doseAudit: [], appliedOps: [], events: { e1: { id: "e1" } },
  };
}
const key = doseKey("a", "2026-11-04", "08:00");
const logCmd = (opId, extra = {}) => ({ opId, kind: "log", medId: "a", key, extra: false, slot: "08:00", day: "2026-11-04", time: "08:00", at: new Date(2026, 10, 4, 8, 14).toISOString(), actor, ...extra });

describe("supplyUsed matches a normal dose and scales an actual amount", () => {
  it("matches supplyPerDose for the configured dose", () => {
    const samples = [
      { type: "pill", doseAmount: 2, doseUnit: "pills", supplyUnit: "pills" },
      { type: "injection", doseAmount: 40, doseUnit: "units", supplyUnit: "pens", perContainer: 4 },
      { type: "injection", doseAmount: 2, doseUnit: "doses", supplyUnit: "vials", perContainer: 10 },
      { type: "infusion", doseAmount: 250, doseUnit: "mL", supplyUnit: "doses" },
      { type: "liquid", doseAmount: 5, doseUnit: "mL", supplyUnit: "mL" },
      { type: "liquid", doseAmount: 5, doseUnit: "mg", supplyUnit: "mL" },
    ];
    for (const med of samples) {
      const m = normalizeMed(med);
      expect(supplyUsed(m, m.doseAmount, m.doseUnit)).toBeCloseTo(supplyPerDose(m));
    }
  });
  it("scales a pen when the actual amount differs, and refuses a unit it can't convert", () => {
    const pen = normalizeMed({ type: "injection", doseAmount: 40, doseUnit: "units", supplyUnit: "pens", perContainer: 4 });
    expect(supplyUsed(pen, 80, "units")).toBeCloseTo(0.5);
    expect(supplyUsed(pen, 40, "mg")).toBeNull();
  });
});

describe("inventory changes exactly once", () => {
  it("a tap deducts the saved amount, a second tap does not", () => {
    const first = commitAdministration(pills(), logCmd("op-1"), NOW);
    expect(first.code).toBe("applied");
    expect(first.delta).toBe(-2);
    expect(first.patient.meds[0].stock).toBe(8);
    expect(first.patient.doses[key]).toMatchObject({ amount: 2, unit: "pills", used: 2, extra: false, status: "taken" });
    const again = commitAdministration(first.patient, logCmd("op-2"), NOW);
    expect(again.code).toBe("already-logged");
    expect(again.delta).toBe(0);
    const retry = commitAdministration(first.patient, logCmd("op-1"), NOW);
    expect(retry.code).toBe("replay");
    expect(retry.delta).toBe(0);
    expect(retry.patient.meds[0].stock).toBe(8);
  });
  it("two plans from the same snapshot would both deduct; applying the second after the first does not", () => {
    const start = pills();
    const a = commitAdministration(start, logCmd("op-a"), NOW);
    const b = commitAdministration(start, logCmd("op-b"), NOW);
    expect(a.delta).toBe(-2);
    expect(b.delta).toBe(-2);
    const after = commitAdministration(a.patient, logCmd("op-b"), NOW);
    expect(after.code).toBe("already-logged");
    expect(a.patient.meds[0].stock).toBe(8);
  });
  it("edits the logged amount from its snapshot and puts the difference back once", () => {
    const logged = commitAdministration(pills(), logCmd("op-1"), NOW).patient;
    const edited = commitAdministration(logged, { opId: "op-e", kind: "edit", medId: "a", key, amount: 3, unit: "pills", at: logged.doses[key].at, actor }, NOW);
    expect(edited.code).toBe("applied");
    expect(edited.delta).toBe(-1);
    expect(edited.patient.meds[0].stock).toBe(7);
    expect(edited.patient.doses[key]).toMatchObject({ amount: 3, used: 3, prescribedAmount: 2 });
    const again = commitAdministration(edited.patient, { opId: "op-e", kind: "edit", medId: "a", key, amount: 5, unit: "pills", at: logged.doses[key].at, actor }, NOW);
    expect(again.code).toBe("replay");
    expect(again.patient.meds[0].stock).toBe(7);
  });
  it("keeps the historical cost if the medicine's dose is edited later", () => {
    const logged = commitAdministration(pills(), logCmd("op-1"), NOW).patient;
    logged.meds[0].doseAmount = 9;
    logged.meds[0].perDose = "9 tablets";
    const timed = commitAdministration(logged, { opId: "op-t", kind: "edit", medId: "a", key, amount: 2, unit: "pills", at: new Date(2026, 10, 4, 8, 40).toISOString(), actor }, NOW);
    expect(timed.delta).toBe(0);
    expect(timed.patient.meds[0].stock).toBe(8);
    expect(timed.patient.meds[0].doseAmount).toBe(9);
    expect(timed.patient.doses[key]).toMatchObject({ amount: 2, used: 2, prescribedAmount: 2, at: new Date(2026, 10, 4, 8, 40).toISOString() });
    const scaled = commitAdministration(timed.patient, { opId: "op-s", kind: "edit", medId: "a", key, amount: 4, unit: "pills", at: timed.patient.doses[key].at, actor }, NOW);
    expect(scaled.patient.doses[key].used).toBe(4);
    expect(scaled.patient.meds[0].stock).toBe(6);
    expect(scaled.patient.meds[0].doseAmount).toBe(9);
    expect(scaled.patient.meds[0].schedule).toEqual(logged.meds[0].schedule);
    expect(scaled.patient.meds[0].times).toEqual(logged.meds[0].times);
  });
  it("removes a log once and restores supply, with an audit snapshot", () => {
    const logged = commitAdministration(pills(), logCmd("op-1"), NOW).patient;
    const removed = commitAdministration(logged, { opId: "op-r", kind: "remove", medId: "a", key, actor }, NOW);
    expect(removed.delta).toBe(2);
    expect(removed.patient.meds[0].stock).toBe(10);
    expect(removed.patient.doses[key]).toBeUndefined();
    expect(removed.patient.doseAudit.at(-1)).toMatchObject({ action: "remove", snapshot: { amount: 2, used: 2 } });
    const again = commitAdministration(removed.patient, { opId: "op-r2", kind: "remove", medId: "a", key, actor }, NOW);
    expect(again.code).toBe("missing");
    expect(again.delta).toBe(0);
    const replayLog = commitAdministration(removed.patient, logCmd("op-1"), NOW);
    expect(replayLog.code).toBe("replay");
    expect(replayLog.patient.meds[0].stock).toBe(10);
    expect(replayLog.patient.doses[key]).toBeUndefined();
  });
  it("does not invent stock when supply isn't tracked", () => {
    const start = pills(null);
    start.meds[0].stock = null;
    const logged = commitAdministration(start, logCmd("op-1"), NOW);
    expect(logged.delta).toBe(0);
    expect(logged.patient.meds[0].stock).toBeNull();
    expect(logged.patient.doses[key].used).toBe(2);
    expect(logged.patient.events.e1).toEqual({ id: "e1" });
  });
});

describe("scheduled corrections vs additional logs", () => {
  const weekly = () => ({
    id: "p", ownerUid: "me",
    meds: [normalizeMed({
      id: "a", name: "Injection", type: "injection", doseAmount: 40, doseUnit: "units", supplyUnit: "pens", perContainer: 4,
      times: ["09:00"], start: "2026-11-02", stock: 2, schedule: { kind: "everyNWeeks", n: 1 },
    })],
    doses: {}, stockLog: [], doseAudit: [], appliedOps: [],
  });
  const mondayKey = doseKey("a", "2026-11-02", "09:00");

  it("a backdated scheduled log re-anchors; an additional log does not", () => {
    const scheduled = commitAdministration(weekly(), {
      opId: "sched", kind: "log", medId: "a", key: mondayKey, extra: false, slot: "09:00",
      day: "2026-11-02", time: "09:00", at: new Date(2026, 10, 3, 9, 30).toISOString(), actor,
    }, NOW);
    expect(scheduled.patient.meds[0].stock).toBeCloseTo(1.75);
    expect(doseAnchors(scheduled.patient.meds[0], scheduled.patient.doses)).toHaveLength(1);
    const tue = new Date(2026, 10, 10, 12);
    expect(scheduledOn(scheduled.patient.meds[0], tue, scheduled.patient.doses).map(s => s.time)).toEqual(["09:30"]);

    const extra = commitAdministration(scheduled.patient, {
      opId: "add", kind: "log", medId: "a", extra: true, amount: 40, unit: "units",
      at: new Date(2026, 10, 4, 10, 0).toISOString(), actor,
    }, NOW);
    expect(extra.patient.meds[0].stock).toBeCloseTo(1.5);
    expect(doseAnchors(extra.patient.meds[0], extra.patient.doses)).toHaveLength(1);
    expect(scheduledOn(extra.patient.meds[0], tue, extra.patient.doses).map(s => s.time)).toEqual(["09:30"]);
    const extraKey = extra.key;
    expect(extra.patient.doses[extraKey].extra).toBe(true);

    const movedExtra = commitAdministration(extra.patient, {
      opId: "add-time", kind: "edit", medId: "a", key: extraKey, amount: 40, unit: "units",
      at: new Date(2026, 10, 5, 8, 0).toISOString(), actor,
    }, new Date(2026, 10, 5, 18).getTime());
    expect(doseAnchors(movedExtra.patient.meds[0], movedExtra.patient.doses)).toHaveLength(1);
    expect(scheduledOn(movedExtra.patient.meds[0], tue, movedExtra.patient.doses).map(s => s.time)).toEqual(["09:30"]);

    const movedSched = commitAdministration(movedExtra.patient, {
      opId: "sched-time", kind: "edit", medId: "a", key: mondayKey, amount: 40, unit: "units",
      at: new Date(2026, 10, 3, 10, 0).toISOString(), actor,
    }, new Date(2026, 10, 5, 18).getTime());
    expect(scheduledOn(movedSched.patient.meds[0], new Date(2026, 10, 10, 12), movedSched.patient.doses).map(s => s.time)).toEqual(["10:00"]);
    expect(movedSched.patient.meds[0].schedule.fixed).toBeUndefined();
    expect(movedSched.patient.doses[mondayKey].extra).toBe(false);
  });

  it("Keep fixed schedule ignores both the scheduled log and an additional log", () => {
    const start = weekly();
    start.meds[0].schedule = { kind: "everyNWeeks", n: 1, fixed: true };
    const scheduled = commitAdministration(start, {
      opId: "sched", kind: "log", medId: "a", key: mondayKey, extra: false, slot: "09:00",
      day: "2026-11-02", time: "09:00", at: new Date(2026, 10, 3, 9, 30).toISOString(), actor,
    }, NOW);
    const extra = commitAdministration(scheduled.patient, {
      opId: "add", kind: "log", medId: "a", extra: true, at: new Date(2026, 10, 4, 9, 30).toISOString(), actor,
    }, NOW);
    expect(doseAnchors(extra.patient.meds[0], extra.patient.doses)).toEqual([]);
    expect(scheduledOn(extra.patient.meds[0], new Date(2026, 10, 9, 12), extra.patient.doses).map(s => s.time)).toEqual(["09:00"]);
    expect(scheduledOn(extra.patient.meds[0], new Date(2026, 10, 10, 12), extra.patient.doses)).toEqual([]);
  });

  it("skip keeps the slot on the schedule; removing a log does not delete the schedule", () => {
    const start = pills();
    const skipped = commitAdministration(start, { opId: "sk", kind: "skip", medId: "a", key, day: "2026-11-04", time: "08:00", slot: "08:00", actor }, NOW);
    expect(skipped.patient.meds[0].stock).toBe(10);
    expect(skipped.patient.meds[0].times).toEqual(["08:00", "20:00"]);
    const shown = dosesOn(new Date(2026, 10, 4, 12), skipped.patient.meds, skipped.patient.doses, { now: NOW });
    expect(shown.find(d => d.key === key).status).toBe("skipped");
    const logged = commitAdministration(pills(), logCmd("op-1"), NOW).patient;
    const removed = commitAdministration(logged, { opId: "rm", kind: "remove", medId: "a", key, actor }, NOW);
    expect(removed.patient.meds[0].times).toEqual(["08:00", "20:00"]);
    const again = dosesOn(new Date(2026, 10, 4, 12), removed.patient.meds, removed.patient.doses, { now: NOW });
    expect(again.find(d => d.time === "08:00").status).toBe("missed");
  });

  it("refuses a future time and leaves inventory unchanged", () => {
    const res = commitAdministration(pills(), logCmd("op-f", { at: new Date(NOW + 2 * 3600000).toISOString() }), NOW);
    expect(res.code).toBe("future");
    expect(res.delta).toBe(0);
  });
});

describe("backdated additional treatment", () => {
  it("records the earlier time without moving a daily schedule", () => {
    const start = pills();
    const res = commitAdministration(start, {
      opId: "back", kind: "log", medId: "a", extra: true, amount: 2, unit: "pills",
      at: new Date(2026, 10, 1, 21, 5).toISOString(), actor,
    }, NOW);
    expect(res.patient.doses[res.key]).toMatchObject({ extra: true, day: "2026-11-01", time: "21:05", amount: 2 });
    expect(dayKey(new Date(2026, 10, 4))).toBe("2026-11-04");
    const today = dosesOn(new Date(NOW), res.patient.meds, res.patient.doses, { now: NOW });
    expect(today.map(d => d.time)).toEqual(["08:00", "20:00"]);
    expect(res.patient.meds[0].stock).toBe(8);
  });
});

describe("doseHistory counts and groups taken treatments", () => {
  const shot = () => {
    const p = {
      id: "p", ownerUid: "me", name: "Me",
      meds: [normalizeMed({ id: "s", name: "Shot", type: "injection", doseAmount: 40, doseUnit: "units", supplyUnit: "pens", perContainer: 4, stock: 5, times: ["08:00"], schedule: { kind: "daily" } })],
      doses: {}, stockLog: [], doseAudit: [], appliedOps: [],
    };
    return p;
  };
  const sKey = day => doseKey("s", day, "08:00");
  const take = (p, opId, day, h, m, extra = {}) => {
    const [y, mo, d] = day.split("-").map(Number);
    const res = commitAdministration(p, { opId, kind: "log", medId: "s", key: sKey(day), slot: "08:00", day, time: "08:00", at: new Date(y, mo - 1, d, h, m).toISOString(), actor, ...extra }, NOW);
    expect(res.code).toBe("applied");
    return res.patient;
  };

  it("is empty with no logs", () => {
    const p = shot();
    expect(doseHistory(p.meds[0], p.doses)).toEqual({ total: 0, days: [] });
    expect(doseHistory(p.meds[0], undefined)).toEqual({ total: 0, days: [] });
  });

  it("groups by day, newest first, and skips skipped and removed logs", () => {
    let p = shot();
    p = take(p, "o1", "2026-11-02", 8, 5);
    p = take(p, "o2", "2026-11-03", 8, 10);
    p = take(p, "o3", "2026-11-03", 21, 30, { extra: true, amount: 10, unit: "units" });
    p = take(p, "o4", "2026-11-04", 8, 0);
    p = commitAdministration(p, { opId: "o5", kind: "skip", medId: "s", key: sKey("2026-11-01"), day: "2026-11-01", time: "08:00", actor }, NOW).patient;
    p = commitAdministration(p, { opId: "o6", kind: "remove", medId: "s", key: sKey("2026-11-04"), actor }, NOW).patient;
    const h = doseHistory(p.meds[0], p.doses);
    expect(h.total).toBe(3);
    expect(h.days.map(d => d.day)).toEqual(["2026-11-03", "2026-11-02"]);
    expect(h.days[0].entries.map(e => [e.time, e.amount, e.extra])).toEqual([["21:30", "10 units", true], ["08:10", "40 units", false]]);
    expect(h.days[1].entries.map(e => e.time)).toEqual(["08:05"]);
  });

  it("shows the corrected amount after an edit and ignores other medicines", () => {
    let p = shot();
    p = take(p, "o1", "2026-11-03", 8, 0);
    p = commitAdministration(p, { opId: "o2", kind: "edit", medId: "s", key: sKey("2026-11-03"), amount: 36, unit: "units", at: new Date(2026, 10, 3, 8, 0).toISOString(), actor }, NOW).patient;
    p.doses.other = { medId: "zzz", status: "taken", at: new Date(2026, 10, 3, 9, 0).toISOString() };
    const h = doseHistory(p.meds[0], p.doses);
    expect(h.total).toBe(1);
    expect(h.days[0].entries[0]).toMatchObject({ amount: "36 units", edited: true });
  });

  it("labels injections as shots and everything else as doses", () => {
    expect(historyNoun({ type: "injection" }).title).toBe("Shot history");
    expect(historyCount({ type: "injection" }, 1)).toBe("1 shot");
    expect(historyCount({ type: "injection" }, 3)).toBe("3 shots");
    expect(historyCount({ type: "pill" }, 2)).toBe("2 doses");
    expect(historyNoun({ type: "infusion" }).title).toBe("Dose history");
    expect(historyCount({}, 0)).toBe("0 doses");
  });
});
