// Regression tests for the fixes from the November 2026 audit (branch audit-safe-fixes).
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { medToIcs, normalizeMed, supply } from "./model.js";
import { commitAdministration } from "./dose-log.js";
import { planImport, migrateLocalData, isEmptyRecord, medList } from "./migrate.js";
import { LocalStore, readJson, RESCUE_KEY, PRE_IMPORT_KEY } from "./store.js";

const src = f => readFileSync(new URL("./" + f, import.meta.url), "utf8");

let mem;
beforeEach(() => {
  mem = new Map();
  globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  };
});

describe("calendar file text", () => {
  it("escapes semicolons as \\; (RFC 5545), not as a bare ;", () => {
    const ics = medToIcs({ id: "m1", name: "Take; then rest", type: "pill", doseAmount: 1, times: ["08:00"], schedule: { kind: "daily" }, start: "2026-11-01" }, {}, new Date(2026, 10, 10, 6, 0).getTime());
    const summary = ics.split("\r\n").find(l => l.startsWith("SUMMARY:"));
    expect(summary).toContain("Take\\; then rest");
    expect(summary).not.toMatch(/[^\\];/);
  });
});

describe("normalizeMed with damaged records", () => {
  it("drops times that are not H:MM, so one bad value can't break every screen", () => {
    const m = normalizeMed({ id: "a", name: "A", times: ["08:00", "8:30", "", null, "25:00", "noon", 7, "\"><img>"] });
    expect(m.times).toEqual(["08:00", "8:30"]);
  });
  it("treats a count that is not a real number as not counted", () => {
    expect(normalizeMed({ id: "a", name: "A", times: ["08:00"], stock: NaN }).stock).toBeNull();
    expect(normalizeMed({ id: "a", name: "A", times: ["08:00"], stock: Infinity }).stock).toBeNull();
    expect(normalizeMed({ id: "a", name: "A", times: ["08:00"], stock: 4 }).stock).toBe(4);
    expect(supply({ id: "a", name: "A", times: ["08:00"], stock: NaN }).left).toBeNull();
  });
});

describe("dose log with a NaN count", () => {
  it("does not write NaN into the count or the supply history", () => {
    const patient = { meds: [{ id: "m", name: "M", type: "pill", doseAmount: 1, times: ["08:00"], schedule: { kind: "daily" }, stock: NaN }], doses: {} };
    const now = new Date(2026, 10, 4, 9, 0).getTime();
    const r = commitAdministration(patient, { opId: "op1", kind: "log", medId: "m", key: "m_2026-11-04_0800", day: "2026-11-04", time: "08:00", at: new Date(now).toISOString() }, now);
    expect(r.code).toBe("applied");
    expect(r.delta).toBe(0);
    expect(r.stockEntry).toBeNull();
    expect(r.patient.stockLog).toEqual([]);
  });
});

describe("migration and import robustness", () => {
  it("survives a record whose medicines are not a list", () => {
    const data = migrateLocalData({ patients: { me: { id: "me", name: "Me", meds: "oops", doses: [], events: null } } });
    expect(data.patients.me.meds).toEqual([]);
    expect(data.patients.me.doses).toEqual({});
    expect(data.patients.me.events).toEqual({});
  });
  it("skips medicines that are not objects and gives each a text id", () => {
    const meds = medList([null, "x", 3, { name: "No id", times: ["08:00"] }, { id: 7, name: "Number id", times: [] }]);
    expect(meds).toHaveLength(2);
    expect(typeof meds[0].id).toBe("string");
    expect(meds[0].id.length).toBeGreaterThan(0);
    expect(meds[1].id).toBe("7");
  });
  it("imports a file whose meds/events are the wrong shape without throwing", () => {
    const plan = planImport({}, { pillboxBackup: 1, patients: { p: { name: "P", meds: { a: 1 }, events: "x", doses: [] } } });
    expect(plan.ok).toBe(true);
    expect(plan.patients.p.meds).toEqual([]);
    expect(plan.patients.p.events).toEqual({});
  });
  it("does not replace the events and dose history of a record that only has no medicines", () => {
    const existing = {
      me: { id: "me", name: "Me", meds: [], doses: { k1: { medId: "old", status: "taken", at: "2026-11-01T08:00:00.000Z", day: "2026-11-01" } },
        events: { e1: { id: "e1", type: "bleed", at: "2026-11-02T10:00:00.000Z", day: "2026-11-02", notes: "left knee" } }, stockLog: [] },
    };
    const backup = { pillboxBackup: 1, patients: { me: { name: "Me", meds: [{ id: "n", name: "New", times: ["08:00"] }], doses: {}, events: {} } } };
    const plan = planImport(existing, backup, { intoEmptyId: "me" });
    expect(plan.ok).toBe(true);
    expect(plan.patients.me.events.e1.notes).toBe("left knee");
    expect(plan.patients.me.doses.k1).toBeTruthy();
    // the file was added beside it instead
    const added = plan.imported.find(id => id !== "me");
    expect(plan.patients[added].meds[0].name).toBe("New");
  });
  it("still restores straight into a brand-new empty record", () => {
    const plan = planImport({ me: { id: "me", name: "Me", meds: [], doses: {}, events: {}, stockLog: [] } },
      { pillboxBackup: 1, patients: { x: { name: "Ana", meds: [{ id: "n", name: "New", times: ["08:00"] }] } } }, { intoEmptyId: "me" });
    expect(plan.imported).toEqual(["me"]);
    expect(plan.patients.me.meds[0].name).toBe("New");
  });
  it("isEmptyRecord", () => {
    expect(isEmptyRecord({ meds: [], doses: {}, events: {}, stockLog: [] })).toBe(true);
    expect(isEmptyRecord({ meds: [], doses: {}, events: { a: {} } })).toBe(false);
    expect(isEmptyRecord(null)).toBe(false);
  });
});

describe("LocalStore storage safety", () => {
  it("keeps unreadable saved data under a rescue key instead of overwriting it", () => {
    mem.set("pillbox.v2", "{not json");
    const store = new LocalStore({});
    store.applyProfile({ usePatient: true, useCaregiver: false, recommended: "skip" });
    expect(mem.get(RESCUE_KEY)).toBe("{not json");
  });
  it("also keeps saved JSON that doesn't look like records", () => {
    mem.set("pillbox.v2", JSON.stringify({ people: { me: { meds: [1] } } }));
    new LocalStore({}).applyProfile({ usePatient: true });
    expect(JSON.parse(mem.get(RESCUE_KEY))).toEqual({ people: { me: { meds: [1] } } });
  });
  it("does not write a rescue copy for a normal first start", () => {
    new LocalStore({}).applyProfile({ usePatient: true });
    expect(mem.has(RESCUE_KEY)).toBe(false);
  });
  it("tells the app when the phone refuses to save", () => {
    const store = new LocalStore({});
    const errors = [];
    store.onSaveError = e => errors.push(e);
    globalThis.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(store.persist()).toBe(false);
    store.applyProfile({ usePatient: true });
    expect(errors.length).toBeGreaterThan(0);
  });
  it("saves a copy of the current records before importing a backup", () => {
    const store = new LocalStore({});
    store.applyProfile({ usePatient: true, useCaregiver: false });
    store.data.patients.me.meds = [normalizeMed({ id: "keep", name: "Keep me", times: ["08:00"] })];
    const plan = store.importBackup({ pillboxBackup: 1, patients: { x: { name: "Ana", meds: [] } } });
    expect(plan.ok).toBe(true);
    const saved = JSON.parse(mem.get(PRE_IMPORT_KEY));
    expect(saved.data.patients.me.meds[0].name).toBe("Keep me");
    expect(saved.data.patients.x).toBeUndefined();
  });
  it("leaves no pre-import copy when the file isn't a backup", () => {
    const store = new LocalStore({});
    store.applyProfile({ usePatient: true });
    expect(store.importBackup({ hello: 1 }).ok).toBe(false);
    expect(mem.has(PRE_IMPORT_KEY)).toBe(false);
  });
  it("ignores a count change that isn't a number", async () => {
    const store = new LocalStore({});
    store.applyProfile({ usePatient: true });
    store.data.patients.me.meds = [normalizeMed({ id: "m", name: "M", times: ["08:00"], stock: 5 })];
    await store.adjustStock("me", "m", NaN, { reason: "adjust" });
    await store.adjustStock("me", "m", "abc", { reason: "adjust" });
    expect(store.data.patients.me.meds[0].stock).toBe(5);
    await store.adjustStock("me", "m", 2, { reason: "refill" });
    expect(store.data.patients.me.meds[0].stock).toBe(7);
  });
  it("readJson never throws", () => {
    mem.set("bad", "{");
    expect(readJson("bad", [])).toEqual([]);
    expect(readJson("missing", "x")).toBe("x");
    mem.set("ok", "[1,2]");
    expect(readJson("ok", [])).toEqual([1, 2]);
    expect(readJson("ok", [], { getItem() { throw new Error("no storage"); } })).toEqual([]);
  });
});

describe("main.js safety checks (source)", () => {
  const main = src("main.js");
  it("never declares a local named t, which would hide the t() translation function", () => {
    // e.g. `const p = ..., t = M.EVENT_TYPES[...]` made every linked event crash with "t is not a function"
    const decl = /(?:\b(?:const|let|var)\s+(?:[^;=]*,\s*)?|,\s*)\bt\s*=(?!=|>)/g;
    const hits = [...main.matchAll(decl)].map(m => main.slice(Math.max(0, m.index - 40), m.index + 30));
    expect(hits).toEqual([]);
  });
  it("escapes ids from saved data and backup files inside HTML attributes", () => {
    const raw = [...main.matchAll(/data-(?:key|med|pid|uid|slot)="\$\{(?!esc\()[^}]*\}"/g)].map(m => m[0]);
    expect(raw).toEqual([]);
    expect(main).toMatch(/const opt = \(v, label, sel\) => `<option value="\$\{esc\(v\)\}"/);
  });
  it("reads saved lists without a bare JSON.parse at start-up", () => {
    expect(main).not.toMatch(/JSON\.parse\(localStorage\.getItem\("pillbox\.alerted"\)/);
  });
});

describe("tap targets in style.css", () => {
  it("buttons and toggles are at least 44px tall", () => {
    const css = src("style.css");
    const rule = sel => { const i = css.indexOf(sel + "{"); expect(i, sel).toBeGreaterThanOrEqual(0); return css.slice(i, css.indexOf("}", i)); };
    for (const sel of ["button,.btn", ".btn-sm", ".seg button", ".tog", ".opt > span", ".toast .toast-undo", "nav.tabs a", "input,select,textarea"]) {
      const m = /min-height:(\d+)px/.exec(rule(sel));
      expect(m && Number(m[1]), sel).toBeGreaterThanOrEqual(44);
    }
  });
  it("skipped doses are not faded with opacity (it dropped grey text below 4.5:1)", () => {
    expect(src("style.css")).not.toMatch(/\.well\.skipped\{[^}]*opacity/);
  });
});
