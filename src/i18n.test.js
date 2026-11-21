import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  TABLES, LANG_KEY, t, tn, detectLang, resolveLang, readLangPref, saveLangPref, initLang, setLang, getLang, locale, fmtHM,
} from "./i18n.js";
import * as M from "./model.js";
import * as C from "./cycle.js";
import { historyNoun, historyCount } from "./dose-log.js";
import { bodyMapHtml, hotspotsFor, labelBox, labelLines, FIGURE } from "./body-map.js";

const { en, es } = TABLES;
const vars = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
const memStore = (init = {}) => {
  const data = { ...init };
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } };
};

afterEach(() => setLang("en"));

describe("string tables", () => {
  it("English and Spanish have exactly the same keys", () => {
    const a = Object.keys(en).sort(), b = Object.keys(es).sort();
    expect(a.filter(k => !(k in es)), "missing in es").toEqual([]);
    expect(b.filter(k => !(k in en)), "missing in en").toEqual([]);
    expect(a).toEqual(b);
  });

  it("every string is filled in and uses the same {placeholders} in both languages", () => {
    // The monthly schedule gets both an English ordinal ("3rd") and the plain number; Spanish uses the number.
    const different = { "sched.monthly": { en: ["ord"], es: ["n"] } };
    for (const k of Object.keys(en)) {
      expect(String(en[k]).trim(), "en " + k).not.toBe("");
      expect(String(es[k]).trim(), "es " + k).not.toBe("");
      if (different[k]) { expect(vars(en[k])).toEqual(different[k].en); expect(vars(es[k])).toEqual(different[k].es); continue; }
      expect(vars(es[k]), k).toEqual(vars(en[k]));
    }
  });

  it("has a string for every key the app code asks for", () => {
    const files = ["main.js", "model.js", "dose-log.js", "body-map.js", "native.js", "migrate.js", "store.js", "reminders.js", "cycle.js"];
    const missing = [];
    for (const f of files) {
      const src = readFileSync(new URL("./" + f, import.meta.url), "utf8");
      for (const [, fn, key] of src.matchAll(/\b(t|tn)\(\s*"([^"]+)"/g)) {
        const need = fn === "tn" ? [key + "_one", key + "_other"] : [key];
        // keys built from a prefix, like t("area." + k), are checked in the next test
        if (!key.endsWith(".")) for (const k of need) if (!(k in en)) missing.push(f + ": " + k);
      }
      // t(cond ? "a.b" : "c.d") and lists of keys such as NAV
      for (const [, key] of src.matchAll(/"((?:nav|today|ev|cal|meds|supply|form|sheet|perm|rec|role|onb|auth|drug|btn|err|hist|dose|care|join|toast|cycle)\.[A-Za-z0-9_-]+)"/g)) {
        if (!(key in en) && !(key + "_one" in en)) missing.push(f + ": " + key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("names every medicine type, unit, body area, event, status and badge", () => {
    const need = [
      ...Object.keys(M.TYPES).flatMap(k => ["type." + k, "typeShort." + k]),
      ...["pills", "mL", "units", "mg", "doses", "vials", "pens", "bags", "bottles"].flatMap(u => ["unit." + u + "_one", "unit." + u + "_other"]),
      ...Object.keys(M.BODY_AREAS).map(k => "area." + k),
      ...Object.keys(M.EVENT_TYPES).map(k => "event." + k),
      ...Object.keys(M.SEVERITIES).map(k => "sev." + k),
      ...Object.keys(M.BLEED_CAUSES).map(k => "cause." + k),
      ...M.BADGES.map(b => "badge." + b.days),
      ...["taken", "skipped", "missed", "due", "upcoming"].map(s => "status." + s),
      ...[0, 1, 2, 3, 4, 5, 6].flatMap(i => ["wd." + i, "wdl." + i]),
      ...["daily", "weekdays", "everyNDays", "everyNWeeks", "monthly", "prn"].map(k => "freq." + k),
      "lang.auto", "lang.en", "lang.es",
      ...C.FLOWS.map(k => "flow." + k),
      ...C.SYMPTOMS.map(k => "sym." + k),
    ];
    expect(need.filter(k => !(k in en) || !(k in es))).toEqual([]);
  });

  it("keeps the English wording the app had before", () => {
    expect(M.BODY_AREAS.leftCalf).toBe(en["area.leftCalf"]);
    for (const [k, v] of Object.entries(M.BODY_AREAS)) expect(en["area." + k]).toBe(v);
    for (const [k, v] of Object.entries(M.EVENT_TYPES)) expect(en["event." + k]).toBe(v.label);
    for (const [k, v] of Object.entries(M.TYPES)) { expect(en["type." + k]).toBe(v.label); expect(en["typeShort." + k]).toBe(v.short); }
    for (const b of M.BADGES) expect(en["badge." + b.days]).toBe(b.label);
  });
});

describe("t() and tn()", () => {
  it("fills placeholders and leaves unknown ones alone", () => {
    expect(t("toast.loggedAt", { what: "2 pills", time: "8:00 AM" })).toBe("Logged 2 pills at 8:00 AM");
    expect(t("toast.loggedAt", { what: "2 pills" })).toBe("Logged 2 pills at {time}");
    setLang("es");
    expect(t("toast.loggedAt", { what: "2 pastillas", time: "8:00 a.m." })).toBe("Se registró 2 pastillas a las 8:00 a.m.");
  });
  it("falls back to the key when no table has it", () => {
    expect(t("no.such.key")).toBe("no.such.key");
  });
  it("picks _one or _other", () => {
    expect(tn("cal.events", 1)).toBe("1 event");
    expect(tn("cal.events", 3)).toBe("3 events");
    setLang("es");
    expect(tn("cal.events", 1)).toBe("1 evento");
    expect(tn("cal.events", 0)).toBe("0 eventos");
  });
});

describe("language choice", () => {
  it("follows a Spanish phone", () => {
    for (const l of ["es", "es-MX", "es-419", "ES-us", "es_CO", ["es-AR", "en-US"]]) expect(detectLang(l), String(l)).toBe("es");
    for (const l of ["en-US", "en", "pt-BR", "et", "", undefined, null, [], ["en-GB", "es-ES"]]) expect(detectLang(l), String(l)).toBe("en");
  });
  it("lets the saved setting win over the phone", () => {
    expect(resolveLang("auto", "es-MX")).toBe("es");
    expect(resolveLang("auto", "en-US")).toBe("en");
    expect(resolveLang("en", "es-MX")).toBe("en");
    expect(resolveLang("es", "en-US")).toBe("es");
    expect(resolveLang("fr", "es-MX")).toBe("es");
  });
  it("stores the choice on this phone and forgets it for Automatic", () => {
    const s = memStore();
    expect(readLangPref(s)).toBe("auto");
    expect(saveLangPref("es", s)).toBe("es");
    expect(s.data[LANG_KEY]).toBe("es");
    expect(readLangPref(s)).toBe("es");
    saveLangPref("auto", s);
    expect(LANG_KEY in s.data).toBe(false);
    expect(readLangPref(s)).toBe("auto");
    expect(saveLangPref("xx", s)).toBe("auto");
    expect(readLangPref(memStore({ [LANG_KEY]: "klingon" }))).toBe("auto");
  });
  it("survives storage that throws", () => {
    const bad = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); }, removeItem() { throw new Error("no"); } };
    expect(readLangPref(bad)).toBe("auto");
    expect(() => saveLangPref("es", bad)).not.toThrow();
    expect(readLangPref(undefined)).toBe("auto");
  });
  it("initLang sets the current language and locale", () => {
    expect(initLang("auto", "es-MX")).toBe("es");
    expect(getLang()).toBe("es");
    expect(locale()).toBe("es-419");
    expect(initLang("en", "es-MX")).toBe("en");
    expect(locale()).toBe("en-US");
  });
});

describe("Spanish screens", () => {
  it("shows times the Spanish way and keeps English times unchanged", () => {
    expect(fmtHM(8, 5)).toBe("8:05 AM");
    expect(M.fmtTime("20:30")).toBe("8:30 PM");
    setLang("es");
    expect(M.fmtTime("08:05").replace(/\s/g, " ")).toMatch(/^8:05 a\.\s?m\.$/);
    expect(M.fmtTime("20:30").replace(/\s/g, " ")).toMatch(/^8:30 p\.\s?m\.$/);
  });
  it("formats dates with the Spanish locale", () => {
    setLang("es");
    const d = new Date(2026, 10, 16);
    expect(d.toLocaleDateString(locale(), { weekday: "long", month: "long", day: "numeric" })).toBe("lunes, 16 de noviembre");
  });
  it("translates medicine summaries but not the names people typed", () => {
    const med = { name: "Factor VIII", type: "injection", doseAmount: 2000, doseUnit: "units", times: ["09:00"], schedule: { kind: "everyNWeeks", n: 2 } };
    expect(M.medSummary(med)).toBe("Injection · 2000 units · every 2 weeks");
    setLang("es");
    expect(M.medSummary(med)).toBe("Inyección · 2000 unidades · cada 2 semanas");
    expect(M.medSummary({ ...med, type: "pill", doseAmount: 1, times: [], schedule: { kind: "prn" } })).toBe("Pastilla · 1 pastilla · cuando se necesite");
    expect(M.scheduleLabel({ times: ["08:00"], schedule: { kind: "weekdays", days: [1, 3] } })).toBe("lun, mié");
    expect(M.scheduleLabel({ times: ["08:00"], schedule: { kind: "monthly", dayOfMonth: 3 } })).toBe("cada mes, el día 3");
    const doses = { k: { medId: "m1", status: "taken", at: new Date(2026, 10, 16, 10, 0).toISOString() } };
    expect(M.doseLinkLabel(doses.k, [{ id: "m1", name: "Mi medicina XR", strength: "5 mg" }], new Date(2026, 10, 16, 12).getTime())).toMatch(/^Mi medicina XR 5 mg · 10:00/);
  });
  it("translates events, encouragement and the shot history words", () => {
    setLang("es");
    expect(M.eventLabel({ type: "bleed", area: "leftKnee", severity: 2, cause: "injury" })).toBe("Sangrado · Rodilla izquierda · Moderado · Lesión");
    expect(M.fmtLogged({ status: "skipped", at: new Date(2026, 0, 1, 9, 0).toISOString() }, "2026-01-01")).toMatch(/^Omitida 9:00/);
    expect(M.encouragement(5, 100)).toBe("¡Muy bien, 5 días seguidos! Faltan 2 días para ⭐ 1 semana a tiempo.");
    const shot = { type: "injection" }, pill = { type: "pill" };
    expect(historyNoun(shot).title).toBe("Historial de inyecciones");
    expect(historyNoun(pill).title).toBe("Historial de dosis");
    expect(historyCount(shot, 1)).toBe("1 inyección");
    expect(historyCount(shot, 3)).toBe("3 inyecciones");
  });
  it("labels the body chart in Spanish without the labels overlapping", () => {
    setLang("es");
    const overlaps = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
    for (const figure of ["male", "female"]) {
      const page = bodyMapHtml("leftKnee", "accent", figure);
      expect(page).toContain("Seleccionado: Rodilla izquierda");
      expect(page).toContain("Toca dónde pasó");
      const spots = hotspotsFor(figure);
      for (const h of spots) {
        expect(page).toContain(`>${labelLines(h.text).join("<br>")}<`);
        const b = labelBox(h);
        expect(b.l, figure + " " + h.area).toBeGreaterThanOrEqual(FIGURE.minX);
        expect(b.r, figure + " " + h.area).toBeLessThanOrEqual(FIGURE.minX + FIGURE.w);
      }
      for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++)
        expect(overlaps(labelBox(spots[i]), labelBox(spots[j])), `${figure} ${spots[i].text} / ${spots[j].text}`).toBe(false);
    }
  });
  it("uses full Spanish names on the body chart, not abbreviations", () => {
    setLang("es");
    const shortKeys = Object.keys(es).filter(k => k.startsWith("bodyShort."));
    expect(shortKeys.length).toBeGreaterThan(10);
    for (const k of shortKeys) expect(es[k], k).not.toMatch(/\./);
    expect(es["bodyShort.forearm"]).toBe("Antebrazo");
    const forearm = hotspotsFor("male").find(h => h.point === "forearm");
    expect(forearm.text).toBe("Antebrazo");
    expect(forearm.size).toBe("small");
    expect(bodyMapHtml("", "accent", "male")).toContain('class="name pos-start small">Antebrazo<');
  });
  it("wraps a long label with spaces onto two lines and keeps one word on one line", () => {
    expect(labelLines("Abdomen inferior izquierdo")).toEqual(["Abdomen inferior", "izquierdo"]);
    expect(labelLines("Parte superior")).toEqual(["Parte", "superior"]);
    expect(labelLines("Antebrazo")).toEqual(["Antebrazo"]);
    expect(labelLines("Mano der")).toEqual(["Mano der"]);
    const one = labelBox({ text: "Abdomen inferior", cx: 100, cy: 200, anchor: "end" });
    const wide = labelBox({ text: "Abdominal inferior", cx: 100, cy: 200, anchor: "end" });
    expect(one.b - one.t).toBeGreaterThan(12);
    expect(wide.r - wide.l).toBeLessThan("Abdominal inferior".length * 6.4);
  });
});
