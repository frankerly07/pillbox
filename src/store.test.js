import { beforeEach, describe, expect, it } from "vitest";
import { LocalStore } from "./store.js";

beforeEach(() => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  };
});

describe("LocalStore", () => {
  it("keeps saved medicines even when an older role would not match", () => {
    localStorage.setItem("pillbox.v2", JSON.stringify({
      role: "caregiver",
      patients: { me: { id: "me", name: "Me", meds: [{ id: "x", name: "Real", times: ["08:00"], perDose: "1 tablet", stock: 5 }], doses: {} } },
    }));
    const store = new LocalStore({ legacyCarePackage: false });
    expect(store.data.patients.me.meds[0].name).toBe("Real");
    expect(store.data.patients.me.meds[0].stock).toBe(5);
    store.applyProfile({ usePatient: true, useCaregiver: true, recommended: "no" });
    expect(store.data.patients.me.meds[0].name).toBe("Real");
    expect(store.profile).toMatchObject({ usePatient: true, useCaregiver: true, recommended: "no", onboarded: true });
    const again = new LocalStore({ legacyCarePackage: false });
    expect(again.data.patients.me.meds[0].name).toBe("Real");
    expect(again.profile.onboarded).toBe(true);
  });

  it("logs a dose once when the same scheduled dose is submitted twice", async () => {
    const store = new LocalStore({});
    store.applyProfile({ usePatient: true, useCaregiver: false, recommended: "skip" });
    store.data.patients.me.meds = [{ id: "x", name: "Real", type: "pill", doseAmount: 1, doseUnit: "pills", supplyUnit: "pills", times: ["08:00"], schedule: { kind: "daily" }, stock: 5 }];
    store.data.example = false;
    const at = new Date(2026, 10, 4, 8, 5).toISOString();
    const now = new Date(2026, 10, 4, 12, 0).getTime();
    const cmd = { kind: "log", medId: "x", key: "x_2026-11-04_0800", extra: false, day: "2026-11-04", time: "08:00", slot: "08:00", at, amount: 1, unit: "pills", now };
    const first = await store.commitDose("me", { ...cmd, opId: "one" });
    const second = await store.commitDose("me", { ...cmd, opId: "two" });
    const retry = await store.commitDose("me", { ...cmd, opId: "one" });
    expect(first.code).toBe("applied");
    expect(second.code).toBe("already-logged");
    expect(retry.code).toBe("replay");
    expect(store.data.patients.me.meds[0].stock).toBe(4);
    await expect(store.createInvite()).rejects.toThrow(/this phone/i);
  });
});
