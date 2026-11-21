import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LocalStore, sampleMeds, CYCLE_KEY, loadCycle, saveCycle } from "./store.js";
import { setLang } from "./i18n.js";
import { doseLabel, sampleText, calendarDescription } from "./model.js";

afterEach(() => setLang("en"));

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

  it("gives its messages in the current language", async () => {
    setLang("es");
    const store = new LocalStore({});
    await expect(store.createInvite()).rejects.toThrow(/este teléfono/);
    await expect(store.signIn()).rejects.toThrow(/sincronización/);
    expect((await store.commitDose("nobody", {})).message).toBe("Ese registro no está en este teléfono.");
  });
});

describe("period log storage", () => {
  const period = { id: "c1", start: "2026-11-01", end: "2026-11-05", flow: "heavy", symptoms: ["cramps"], note: "secret-cycle-note" };

  it("saves and loads on its own key and survives bad storage", () => {
    expect(loadCycle()).toEqual({ version: 1, periods: [] });
    saveCycle({ periods: [period] });
    expect(JSON.parse(localStorage.getItem(CYCLE_KEY)).periods[0].note).toBe("secret-cycle-note");
    expect(loadCycle().periods[0]).toMatchObject({ id: "c1", flow: "heavy", symptoms: ["cramps"] });
    localStorage.setItem(CYCLE_KEY, "{oops");
    expect(loadCycle()).toEqual({ version: 1, periods: [] });
    const bad = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); } };
    expect(loadCycle(bad).periods).toEqual([]);
    expect(() => saveCycle({ periods: [period] }, bad)).not.toThrow();
  });

  it("is not in patient records, backups, or caregiver views", async () => {
    saveCycle({ periods: [period] });
    const store = new LocalStore({});
    store.applyProfile({ usePatient: true, useCaregiver: true, recommended: "skip" });
    await store.saveMed("me", { id: "x", name: "Factor", times: ["08:00"], perDose: "1 vial" });
    const watched = [];
    store.watchPatient("me", p => watched.push(JSON.stringify(p)));
    for (const raw of [localStorage.getItem("pillbox.v2"), JSON.stringify(store.exportBackup()), ...watched, JSON.stringify(store.patientList())]) {
      expect(raw).not.toContain("secret-cycle-note");
      expect(raw).not.toContain("periods");
    }
    // clearing example medicines leaves the period log alone
    store.clearExamples();
    expect(loadCycle().periods).toHaveLength(1);
  });

  it("is never read by the cloud store or the caregiver functions", () => {
    const store = readFileSync(new URL("./store.js", import.meta.url), "utf8");
    const cloud = store.slice(store.indexOf("export class CloudStore"), store.indexOf("// Period log:"));
    expect(cloud.length).toBeGreaterThan(1000);
    for (const src of [cloud, readFileSync(new URL("./cloud-handlers.js", import.meta.url), "utf8"), readFileSync(new URL("../functions/index.js", import.meta.url), "utf8")]) {
      expect(src).not.toMatch(/cycle|period/i);
    }
  });
});

describe("example medicines", () => {
  it("are worded in English on an English phone, as before", () => {
    const meds = sampleMeds("2026-11-17");
    expect(meds.map(m => m.name)).toEqual(["Vitamin D3", "Metformin", "Ibuprofen", "Vitamin B12"]);
    expect(meds[1]).toMatchObject({ perDose: "1 tablet", notes: "Take with food", prescribedBy: "Dr. Patel (example)" });
    expect(meds[2].notes).toBe("As needed, max 3 per day");
    expect(doseLabel(meds[0])).toBe("1 softgel");
  });

  it("are worded in Spanish when the phone is in Spanish", () => {
    setLang("es");
    const store = new LocalStore({});
    store.applyProfile({ usePatient: true, useCaregiver: false, recommended: "skip" });
    expect(store.example).toBe(true);
    const meds = store.data.patients.me.meds;
    expect(meds.map(m => m.name)).toEqual(["Vitamina D3", "Metformin", "Ibuprofen", "Vitamina B12"]);
    expect(meds[1]).toMatchObject({ perDose: "1 tableta", notes: "Tomar con comida", prescribedBy: "Dr. Patel (ejemplo)" });
    expect(meds[2].notes).toBe("Cuando se necesite, máximo 3 al día");
    expect(meds[3].notes).toBe("Parte superior del brazo, alternar lados");
    expect(doseLabel(meds[1])).toBe("1 tableta");
  });

  it("are shown in the current language when they were saved in the other one", () => {
    const meds = sampleMeds("2026-11-17");
    setLang("es");
    expect(doseLabel(meds[0])).toBe("1 cápsula blanda");
    expect(sampleText(meds[1].notes)).toBe("Tomar con comida");
    expect(sampleText(meds[1].prescribedBy)).toBe("Dr. Patel (ejemplo)");
    expect(calendarDescription(meds[1])).toMatch(/Tomar con comida$/);
    setLang("en");
    expect(sampleText("Tomar con comida")).toBe("Take with food");
  });

  it("leaves what people typed alone", () => {
    setLang("es");
    for (const v of ["Take with food please", "2 tablets", "Dr. Patel", "", null, undefined, 3]) expect(sampleText(v)).toBe(v);
    expect(doseLabel({ type: "pill", perDose: "2 tablets", doseAmount: 2 })).toBe("2 tablets");
  });

  it("does not change saved medicines when the store loads", () => {
    localStorage.setItem("pillbox.v2", JSON.stringify({
      role: "patient",
      patients: { me: { id: "me", name: "Me", meds: [{ id: "x", name: "Real", times: ["08:00"], perDose: "1 tablet", notes: "Take with food", stock: 5 }], doses: {} } },
    }));
    setLang("es");
    const store = new LocalStore({});
    expect(store.data.patients.me.meds[0]).toMatchObject({ perDose: "1 tablet", notes: "Take with food" });
  });
});
