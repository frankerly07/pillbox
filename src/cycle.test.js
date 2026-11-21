import { describe, it, expect, afterEach } from "vitest";
import {
  FLOWS, SYMPTOMS, MIN_CYCLE, MAX_CYCLE, MAX_PERIOD, OPEN_DAYS, cycleEnabled, isDayKey, daysBetween, addDays,
  normalizePeriod, sortPeriods, episodes, cycleStats, bleedingDays, isOngoing, checkPeriod, newestFirst,
} from "./cycle.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, SETTINGS_KEY } from "./reminders.js";
import { TABLES, setLang, t, tn } from "./i18n.js";

const per = (start, end = null, extra = {}) => ({ id: "p" + start, start, end, ...extra });
const memStore = (init = {}) => {
  const data = { ...init };
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } };
};

afterEach(() => setLang("en"));

describe("who sees cycle tracking", () => {
  it("is off by default and needs both the female figure and the toggle", () => {
    expect(DEFAULT_SETTINGS.cycleTracking).toBe(false);
    expect(cycleEnabled(DEFAULT_SETTINGS)).toBe(false);
    expect(cycleEnabled({ bodyFigure: "female", cycleTracking: false })).toBe(false);
    expect(cycleEnabled({ bodyFigure: "female", cycleTracking: true })).toBe(true);
    expect(cycleEnabled({ bodyFigure: "male", cycleTracking: true })).toBe(false);
    expect(cycleEnabled({ bodyFigure: "female", cycleTracking: "yes" })).toBe(false);
    expect(cycleEnabled(null)).toBe(false);
    expect(cycleEnabled(undefined)).toBe(false);
  });

  it("switching to the male figure hides it but keeps the setting for later", () => {
    const st = memStore();
    saveSettings({ ...loadSettings(st), bodyFigure: "female", cycleTracking: true }, st);
    expect(cycleEnabled(loadSettings(st))).toBe(true);
    saveSettings({ ...loadSettings(st), bodyFigure: "male" }, st);
    const s = loadSettings(st);
    expect(cycleEnabled(s)).toBe(false);
    expect(s.cycleTracking).toBe(true);
    saveSettings({ ...s, bodyFigure: "female" }, st);
    expect(cycleEnabled(loadSettings(st))).toBe(true);
  });

  it("older saved settings load with tracking off, and only a saved true turns it on", () => {
    expect(loadSettings(memStore({ [SETTINGS_KEY]: JSON.stringify({ bodyFigure: "female" }) })).cycleTracking).toBe(false);
    expect(loadSettings(memStore({ [SETTINGS_KEY]: JSON.stringify({ bodyFigure: "female", cycleTracking: 1 }) })).cycleTracking).toBe(false);
    expect(loadSettings(memStore({ [SETTINGS_KEY]: "{bad" })).cycleTracking).toBe(false);
  });
});

describe("calendar day math", () => {
  it("checks real calendar days only", () => {
    for (const k of ["2026-01-01", "2024-02-29", "2026-12-31"]) expect(isDayKey(k)).toBe(true);
    for (const k of ["2026-02-29", "2026-13-01", "2026-1-5", "", null, undefined, "2026-04-31", 20260101, "2026-01-01T00:00"]) expect(isDayKey(k)).toBe(false);
  });

  it("counts whole days across month, year, leap day and DST changes", () => {
    expect(daysBetween("2026-01-31", "2026-02-01")).toBe(1);
    expect(daysBetween("2025-12-20", "2026-01-17")).toBe(28);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    // US daylight saving starts 2026-03-08 and ends 2026-11-01; EU on 03-29 and 10-25
    expect(daysBetween("2026-03-01", "2026-03-29")).toBe(28);
    expect(daysBetween("2026-10-20", "2026-11-17")).toBe(28);
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-25", 10)).toBe("2027-01-04");
    expect(addDays("2026-01-05", -10)).toBe("2025-12-26");
    expect(daysBetween("2026-02-10", "2026-02-01")).toBe(-9);
  });
});

describe("saved periods", () => {
  it("cleans up a period and keeps only known flows and symptoms", () => {
    const p = normalizePeriod({ id: "a", start: "2026-11-01", end: "2026-11-05", flow: "heavy", symptoms: ["mood", "cramps", "nope", "cramps"], note: "  sore  ", createdAt: 5 });
    expect(p).toEqual({ id: "a", start: "2026-11-01", end: "2026-11-05", flow: "heavy", symptoms: ["cramps", "mood"], note: "sore", createdAt: 5, updatedAt: 5 });
    expect(normalizePeriod({ start: "2026-11-01", flow: "gushing", symptoms: "cramps" }, 9)).toMatchObject({ id: "p-2026-11-01", end: null, flow: "medium", symptoms: [], note: "", createdAt: 9 });
    expect(normalizePeriod({ start: "2026-11-05", end: "2026-11-01" }).end).toBeNull();
    expect(normalizePeriod({ start: "nope" })).toBeNull();
    expect(normalizePeriod(null)).toBeNull();
    expect(normalizePeriod({ start: "2026-11-01", note: "x".repeat(900) }).note).toHaveLength(500);
    expect(FLOWS).toEqual(["light", "medium", "heavy"]);
    expect(SYMPTOMS).toEqual(["cramps", "headache", "mood", "bloating", "spotting", "other"]);
  });

  it("sorts unsorted input oldest first and drops bad entries", () => {
    const list = sortPeriods([per("2026-10-03"), { start: "bad" }, per("2026-08-01"), null, per("2026-09-02")]);
    expect(list.map(p => p.start)).toEqual(["2026-08-01", "2026-09-02", "2026-10-03"]);
    expect(newestFirst(list).map(p => p.start)).toEqual(["2026-10-03", "2026-09-02", "2026-08-01"]);
    expect(sortPeriods(undefined)).toEqual([]);
  });

  it("counts duplicate and overlapping entries as one period", () => {
    const eps = episodes([
      per("2026-09-01", "2026-09-05"), { ...per("2026-09-01"), id: "dup" }, per("2026-09-04", "2026-09-07"),
      per("2026-10-01"), { ...per("2026-10-01", "2026-10-04"), id: "later" },
    ]);
    expect(eps.map(e => [e.start, e.end, e.ids.length])).toEqual([["2026-09-01", "2026-09-07", 3], ["2026-10-01", "2026-10-04", 2]]);
    // two open entries on the same day stay open
    expect(episodes([per("2026-10-01"), { ...per("2026-10-01"), id: "z" }])).toEqual([{ start: "2026-10-01", end: null, ids: ["p2026-10-01", "z"] }]);
    // touching but not overlapping periods stay separate
    expect(episodes([per("2026-10-01", "2026-10-03"), per("2026-10-04", "2026-10-05")])).toHaveLength(2);
  });
});

describe("averages and the estimate", () => {
  it("has nothing to say with no data", () => {
    for (const input of [[], undefined, null]) {
      expect(cycleStats(input, "2026-11-21")).toEqual({ count: 0, avgCycle: null, avgPeriod: null, cycles: 0, outliers: 0, lastStart: null, nextStart: null, daysUntil: null });
    }
  });

  it("needs at least 2 starts for a cycle average and an estimate", () => {
    const one = cycleStats([per("2026-11-01", "2026-11-05")], "2026-11-21");
    expect(one).toMatchObject({ count: 1, avgCycle: null, avgPeriod: 5, lastStart: "2026-11-01", nextStart: null, daysUntil: null });
  });

  it("averages start to start and first to last day", () => {
    const st = cycleStats([per("2026-10-27", "2026-10-31"), per("2026-08-31", "2026-09-04"), per("2026-09-28", "2026-10-03")], "2026-11-10");
    // gaps 28 and 29 → 28.5 → 29; lengths 5, 6, 5 → 5.33 → 5
    expect(st).toMatchObject({ count: 3, avgCycle: 29, avgPeriod: 5, cycles: 2, outliers: 0, lastStart: "2026-10-27", nextStart: "2026-11-25", daysUntil: 15 });
  });

  it("works with an open period that has no last day", () => {
    const st = cycleStats([per("2026-10-01", "2026-10-05"), per("2026-10-29")], "2026-11-01");
    expect(st).toMatchObject({ avgCycle: 28, avgPeriod: 5, nextStart: "2026-11-26", daysUntil: 25 });
    expect(cycleStats([per("2026-10-01"), per("2026-10-29")]).avgPeriod).toBeNull();
  });

  it("leaves out gaps shorter than 15 or longer than 60 days", () => {
    expect([MIN_CYCLE, MAX_CYCLE]).toEqual([15, 60]);
    const st = cycleStats([per("2026-01-01"), per("2026-04-15"), per("2026-05-13"), per("2026-05-20"), per("2026-06-17")], "2026-06-20");
    // gaps: 104 (out), 28, 7 (out), 28
    expect(st).toMatchObject({ avgCycle: 28, cycles: 2, outliers: 2, nextStart: "2026-07-15" });
    expect(cycleStats([per("2026-01-01"), per("2026-04-15")])).toMatchObject({ avgCycle: null, nextStart: null, outliers: 1 });
    expect(cycleStats([per("2026-01-01"), per("2026-01-16")]).avgCycle).toBe(15);
    expect(cycleStats([per("2026-01-01"), per("2026-03-02")]).avgCycle).toBe(60);
  });

  it("leaves out implausibly long periods from the period average", () => {
    expect(MAX_PERIOD).toBe(20);
    expect(cycleStats([per("2026-01-01", "2026-02-15"), per("2026-02-20", "2026-02-23")]).avgPeriod).toBe(4);
  });

  it("does not double count duplicates or overlaps", () => {
    const st = cycleStats([per("2026-09-01", "2026-09-05"), { ...per("2026-09-01", "2026-09-05"), id: "x" }, per("2026-09-03", "2026-09-06"), per("2026-09-29", "2026-10-02")]);
    expect(st).toMatchObject({ count: 2, avgCycle: 28, avgPeriod: 5, outliers: 0 });
  });

  it("predicts across a year end and says when the estimate has passed", () => {
    const st = cycleStats([per("2026-11-08"), per("2026-12-06")], "2027-01-10");
    expect(st).toMatchObject({ nextStart: "2027-01-03", daysUntil: -7 });
    expect(cycleStats([per("2026-11-08"), per("2026-12-06")], "2027-01-03").daysUntil).toBe(0);
    expect(cycleStats([per("2026-11-08"), per("2026-12-06")], "not a day").daysUntil).toBeNull();
  });
});

describe("logged bleeding days", () => {
  it("lists every day from first to last, across months", () => {
    expect([...bleedingDays([per("2026-01-30", "2026-02-02")])]).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });

  it("runs an open period up to today, for at most OPEN_DAYS days", () => {
    expect([...bleedingDays([per("2026-11-19")], "2026-11-21")]).toEqual(["2026-11-19", "2026-11-20", "2026-11-21"]);
    expect(bleedingDays([per("2026-10-01")], "2026-11-21").size).toBe(OPEN_DAYS);
    expect([...bleedingDays([per("2026-11-19")])]).toEqual(["2026-11-19"]);
    expect(isOngoing(normalizePeriod(per("2026-11-19")), "2026-11-21")).toBe(true);
    expect(isOngoing(normalizePeriod(per("2026-10-01")), "2026-11-21")).toBe(false);
    expect(isOngoing(normalizePeriod(per("2026-11-19", "2026-11-20")), "2026-11-21")).toBe(false);
  });
});

describe("checking the form", () => {
  const saved = [per("2026-10-01", "2026-10-05"), per("2026-11-01")];
  it("accepts a good period, including the one being edited", () => {
    expect(checkPeriod(per("2026-10-28", "2026-10-30"), saved, "2026-11-21")).toBeNull();
    expect(checkPeriod({ ...saved[0], end: "2026-10-06" }, saved, "2026-11-21")).toBeNull();
  });
  it("refuses missing, future, backwards, too long and overlapping days", () => {
    expect(checkPeriod({ start: "" }, saved, "2026-11-21")).toEqual({ code: "start" });
    expect(checkPeriod(per("2026-11-22"), saved, "2026-11-21")).toEqual({ code: "future" });
    expect(checkPeriod(per("2026-11-10", "2026-11-09"), saved, "2026-11-21")).toEqual({ code: "endBefore" });
    expect(checkPeriod(per("2026-11-10", "2026-11-25"), saved, "2026-11-21")).toEqual({ code: "endFuture" });
    expect(checkPeriod(per("2026-06-01", "2026-06-30"), saved, "2026-11-21")).toEqual({ code: "tooLong", n: MAX_PERIOD });
    expect(checkPeriod({ id: "new", start: "2026-10-04", end: "2026-10-08" }, saved, "2026-11-21")).toEqual({ code: "overlap", start: "2026-10-01" });
    expect(checkPeriod({ id: "new", start: "2026-11-01" }, saved, "2026-11-21")).toEqual({ code: "overlap", start: "2026-11-01" });
  });
});

describe("cycle wording", () => {
  it("has natural Spanish and makes no fertility or contraception claims", () => {
    setLang("es");
    expect(t("set.cycle")).toBe("Registrar mi ciclo");
    expect(t("cycle.flowLine", { flow: t("flow.light").toLowerCase() })).toBe("Flujo: ligero");
    expect(["flow.light", "flow.medium", "flow.heavy"].map(k => t(k))).toEqual(["Ligero", "Moderado", "Abundante"]);
    expect(tn("cycle.days", 1)).toBe("1 día");
    expect(tn("cycle.days", 28)).toBe("28 días");
    setLang("en");
    expect(t("cycle.nextEst")).toMatch(/estimate/i);
    expect(t("cycle.disclaimer")).toMatch(/not medical advice/);
    for (const table of [TABLES.en, TABLES.es]) {
      const words = Object.entries(table).filter(([k]) => /^(cycle|flow|sym)\.|^set\.cycle/.test(k)).map(([, v]) => v).join(" ");
      expect(words).not.toMatch(/fertil|ovula|contracep|anticoncep|pregnan|embaraz|safe days|días seguros/i);
    }
  });
});
