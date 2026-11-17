import { describe, it, expect, afterEach } from "vitest";
import { setLang } from "./i18n.js";
import {
  DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, saveSettings, calendarOnForNewMed, calendarCandidates, turnOnAllReminders, allRemindersMessage,
} from "./reminders.js";

const memStore = (init = {}) => {
  const data = { ...init };
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } };
};
const daily = (id, extra = {}) => ({ id, name: id, type: "pill", doseAmount: 1, times: ["08:00"], schedule: { kind: "daily" }, ...extra });
const prn = id => ({ id, name: id, type: "pill", doseAmount: 1, times: [], schedule: { kind: "prn" } });

afterEach(() => setLang("en"));

describe("settings", () => {
  it("has 'Add new medicines to my calendar' off by default", () => {
    expect(DEFAULT_SETTINGS.calendarForNewMeds).toBe(false);
    const s = loadSettings(memStore());
    expect(s.calendarForNewMeds).toBe(false);
    expect(calendarOnForNewMed(s)).toBe(false);
  });
  it("keeps older saved settings and only turns on for a saved true", () => {
    const old = loadSettings(memStore({ [SETTINGS_KEY]: JSON.stringify({ bodyFigure: "female", dueWindowMin: 30 }) }));
    expect(old).toEqual({ dueWindowMin: 30, bodyFigure: "female", calendarForNewMeds: false });
    expect(loadSettings(memStore({ [SETTINGS_KEY]: JSON.stringify({ calendarForNewMeds: "yes" }) })).calendarForNewMeds).toBe(false);
    const st = memStore();
    saveSettings({ ...loadSettings(st), calendarForNewMeds: true }, st);
    expect(calendarOnForNewMed(loadSettings(st))).toBe(true);
  });
  it("survives bad or missing storage", () => {
    expect(loadSettings(memStore({ [SETTINGS_KEY]: "{not json" }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(memStore({ [SETTINGS_KEY]: "[1,2]" }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    const bad = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); } };
    expect(loadSettings(bad)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS, bad)).not.toThrow();
  });
});

describe("alarms and calendar for all medicines", () => {
  const fakes = (calResult = () => ({ ok: true, ids: ["e1"] })) => {
    const log = { saved: [], scheduled: 0, added: [] };
    return {
      log,
      askPermission: async () => "granted",
      scheduleReminders: async () => { log.scheduled++; },
      addToCalendar: async m => { log.added.push(m.id); return calResult(m); },
      saveMed: async m => { log.saved.push(m); },
    };
  };

  it("picks only scheduled medicines that are not on the calendar yet", () => {
    expect(calendarCandidates([daily("a"), daily("b", { addToCalendar: true }), prn("c")]).map(m => m.id)).toEqual(["a"]);
  });

  it("schedules alarms and turns on the calendar for each scheduled medicine", async () => {
    const f = fakes();
    const res = await turnOnAllReminders({ meds: [daily("a"), daily("b"), prn("c"), daily("d", { addToCalendar: true })], onPhone: true, ...f });
    expect(res).toMatchObject({ perm: "granted", added: 2, failed: 0, calendar: "added" });
    expect(f.log.scheduled).toBe(1);
    expect(f.log.added).toEqual(["a", "b"]);
    expect(f.log.saved.map(m => [m.id, m.addToCalendar, m.calendarEventIds])).toEqual([["a", true, ["e1"]], ["b", true, ["e1"]]]);
    expect(allRemindersMessage(res)).toBe("Dose alarms are on. Added 2 medicines to your calendar.");
  });

  it("stops after the calendar permission is refused and says so", async () => {
    const f = fakes(() => ({ ok: false, denied: true }));
    const res = await turnOnAllReminders({ meds: [daily("a"), daily("b")], onPhone: true, ...f });
    expect(res).toMatchObject({ added: 0, calendar: "denied", skipped: 2 });
    expect(f.log.added).toEqual(["a"]);
    expect(f.log.saved).toEqual([]);
    expect(allRemindersMessage(res)).toMatch(/Calendar permission wasn't given/);
  });

  it("does not try the calendar in a browser", async () => {
    const f = fakes();
    const res = await turnOnAllReminders({ meds: [daily("a")], onPhone: false, ...f, askPermission: async () => "denied" });
    expect(res).toMatchObject({ calendar: "notPhone", added: 0 });
    expect(f.log.added).toEqual([]);
    expect(f.log.scheduled).toBe(1);
    expect(allRemindersMessage(res)).toMatch(/^Dose alarms are blocked\..*phone app/);
  });

  it("counts failures and reports when there is nothing to add", async () => {
    const f = fakes(m => (m.id === "b" ? { ok: false } : { ok: true, ids: [] }));
    const res = await turnOnAllReminders({ meds: [daily("a"), daily("b")], onPhone: true, ...f });
    expect(res).toMatchObject({ added: 1, failed: 1 });
    expect(allRemindersMessage(res)).toBe("Dose alarms are on. Added 1 medicine to your calendar. Couldn't add 1 medicine.");
    const none = await turnOnAllReminders({ meds: [daily("a", { addToCalendar: true })], onPhone: true, ...fakes() });
    expect(none.calendar).toBe("nothing");
    const noSched = await turnOnAllReminders({ meds: [prn("c")], onPhone: true, ...fakes() });
    expect(allRemindersMessage(noSched)).toMatch(/no scheduled medicines/);
  });

  it("keeps going when a phone function throws", async () => {
    const f = fakes(() => { throw new Error("boom"); });
    const res = await turnOnAllReminders({ meds: [daily("a")], onPhone: true, ...f, askPermission: async () => { throw new Error("x"); }, scheduleReminders: async () => { throw new Error("y"); } });
    expect(res).toMatchObject({ perm: "unsupported", failed: 1 });
  });

  it("speaks Spanish", async () => {
    setLang("es");
    const res = await turnOnAllReminders({ meds: [daily("a"), daily("b")], onPhone: true, ...fakes() });
    expect(allRemindersMessage(res)).toBe("Alarmas de dosis activadas. Se agregaron 2 medicamentos a tu calendario.");
  });
});
