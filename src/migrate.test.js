import { describe, it, expect } from "vitest";
import { buildBackup, migrateLocalData, planImport } from "./migrate.js";

const savedMed = { id: "x", name: "Real med", perDose: "1 tablet", times: ["08:00"], stock: 12, slot: 1 };

describe("existing installs are kept", () => {
  it("keeps a patient record when the saved role would not match a caregiver launch", () => {
    const v2 = { role: "patient", example: false, patients: { me: { id: "me", name: "Me", meds: [savedMed], doses: { k: { medId: "x", status: "taken" } }, events: {} } } };
    const out = migrateLocalData(v2, { legacyCarePackage: true });
    expect(out.fresh).toBe(false);
    expect(out.patients.me.meds[0]).toMatchObject({ name: "Real med", type: "pill", doseAmount: 1, stock: 12 });
    expect(out.patients.me.doses.k.medId).toBe("x");
    expect(out.patients.me.doseAudit).toEqual([]);
    expect(out.profile).toBeNull();
    expect(out.suggested.useCaregiver).toBe(false);
    expect(out.suggested.usePatient).toBe(true);
  });

  it("keeps caregiver-package records and does not turn them into a patient reseed", () => {
    const v2 = { role: "caregiver", example: true, patients: { p1: { id: "p1", name: "Example: Maria", meds: [savedMed], doses: {} } } };
    const out = migrateLocalData(v2, { legacyCarePackage: true });
    expect(out.patients.p1.meds[0].name).toBe("Real med");
    expect(out.patients.me).toBeUndefined();
    expect(out.suggested).toMatchObject({ usePatient: false, useCaregiver: true, onboarded: false });
    expect(out.role).toBe("caregiver");
  });

  it("is idempotent once onboarded and does not drop medicines", () => {
    const once = migrateLocalData({ role: "patient", patients: { me: { id: "me", name: "Me", meds: [savedMed] } } });
    once.profile = { usePatient: true, useCaregiver: true, recommended: "skip", onboarded: true };
    const twice = migrateLocalData(once);
    expect(twice.profile).toMatchObject({ usePatient: true, useCaregiver: true, recommended: "skip", onboarded: true });
    expect(twice.patients.me.meds).toHaveLength(1);
    expect(migrateLocalData(null).fresh).toBe(true);
    expect(migrateLocalData(null).patients).toEqual({});
  });
});

describe("backup file", () => {
  it("drops access, codes, and account fields", () => {
    const file = buildBackup({
      me: {
        id: "me", name: "Me", meds: [savedMed], doses: { a: { medId: "x" } }, events: {},
        access: { c: { permission: "logEdit" } }, caregiverUids: ["c"], linkCode: "ABCDEFGHJKLMNPQR",
        apiKey: "secret-key", password: "hunter2", email: "a@b.c", token: "tok",
      },
    }, new Date(2026, 10, 4).getTime());
    expect(file.pillboxBackup).toBe(1);
    const raw = JSON.stringify(file);
    for (const hidden of ["logEdit", "ABCDEFGHJKLMNPQR", "secret-key", "hunter2", "a@b.c", "tok"]) expect(raw).not.toContain(hidden);
    expect(file.patients.me.meds[0].name).toBe("Real med");
    expect(file.patients.me.localOnly).toBe(true);
  });

  it("restores into an empty record without deleting a different person", () => {
    const file = buildBackup({ old: { id: "old", name: "Sam", meds: [savedMed], doses: { a: 1 }, events: {} } });
    const existing = { me: { id: "me", name: "Me", meds: [], doses: {} }, kept: { id: "kept", name: "Kept", meds: [{ id: "z", name: "Stay" }] } };
    const plan = planImport(existing, file, { intoEmptyId: "me" });
    expect(plan.ok).toBe(true);
    expect(plan.patients.me.meds[0].name).toBe("Real med");
    expect(plan.patients.me.doses).toEqual({ a: 1 });
    expect(plan.patients.kept.meds[0].name).toBe("Stay");
    expect(plan.message).toMatch(/does not connect/i);
  });

  it("adds a second phone's backup beside medicines you already have", () => {
    const file = buildBackup({ me: { id: "me", name: "Sam", meds: [savedMed], doses: {}, events: {} } });
    const existing = { me: { id: "me", name: "Me", meds: [{ id: "mine", name: "Mine" }], doses: {} } };
    const plan = planImport(existing, file);
    expect(plan.patients.me.meds.map(m => m.name)).toEqual(["Mine"]);
    const added = plan.imported[0];
    expect(added).not.toBe("me");
    expect(plan.patients[added].localOnly).toBe(true);
    expect(plan.patients[added].access).toEqual({});
    expect(plan.message).toMatch(/not a synced link/i);
    expect(planImport(existing, { pillboxBackup: 2 }).ok).toBe(false);
  });
});
