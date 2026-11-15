// Tiny i18n: English and Spanish string tables, t() lookups, and the per-phone language setting.
// No DOM work at import time, so model code and tests can use t() and get English until initLang() runs.
import { en } from "./i18n-en.js";
import { es } from "./i18n-es.js";

export const TABLES = { en, es };
export const LANGS = ["en", "es"];
/** Values for the Settings picker. "auto" follows the phone's language. */
export const LANG_CHOICES = ["auto", "en", "es"];
export const LANG_KEY = "pillbox.lang";

let lang = "en";

/** "es" when the phone's language is Spanish (es, es-MX, es-419…), else "en". */
export function detectLang(navLang) {
  const list = Array.isArray(navLang) ? navLang : [navLang];
  const first = String(list.find(Boolean) || "").toLowerCase();
  return first === "es" || first.startsWith("es-") || first.startsWith("es_") ? "es" : "en";
}
/** The language to show for a saved choice ("auto" | "en" | "es") and the phone's language. */
export function resolveLang(pref, navLang) {
  return pref === "en" || pref === "es" ? pref : detectLang(navLang);
}
/** The saved choice on this phone, "auto" when there isn't one (or storage isn't available). */
export function readLangPref(storage = globalThis.localStorage) {
  try { const v = storage?.getItem(LANG_KEY); return LANG_CHOICES.includes(v) ? v : "auto"; } catch (e) { return "auto"; }
}
export function saveLangPref(pref, storage = globalThis.localStorage) {
  const v = LANG_CHOICES.includes(pref) ? pref : "auto";
  try { if (v === "auto") storage?.removeItem(LANG_KEY); else storage?.setItem(LANG_KEY, v); } catch (e) {}
  return v;
}
const phoneLang = () => { try { return globalThis.navigator?.languages?.length ? globalThis.navigator.languages : globalThis.navigator?.language; } catch (e) { return ""; } };
/** Pick the language from the saved choice and the phone, and mark the page with it. Returns the language. */
export function initLang(pref = readLangPref(), navLang = phoneLang()) {
  return setLang(resolveLang(pref, navLang));
}
export function setLang(l) {
  lang = LANGS.includes(l) ? l : "en";
  try { if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = lang; } catch (e) {}
  return lang;
}
export const getLang = () => lang;
/** BCP 47 locale for dates and times: US English, or Latin American Spanish. */
export const locale = () => (lang === "es" ? "es-419" : "en-US");

/** The string for `key` in the current language (English if missing), with {name} placeholders filled from `vars`. */
export function t(key, vars) {
  const s = TABLES[lang][key] ?? TABLES.en[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}
/** Plural lookup: `key_one` when n is 1, else `key_other`. {n} is filled in. */
export const tn = (key, n, vars) => t(key + (Math.abs(n) === 1 ? "_one" : "_other"), { n, ...vars });

// ---- dates and times in the current language ----
/** A date with Intl options, in the current locale. */
export const fmtDateL = (d, opts) => d.toLocaleDateString(locale(), opts);
/** A date and time in the current locale. */
export const fmtDateTimeL = d => d.toLocaleString(locale());
/** "8:05 AM" in English, "8:05 a.m." in Spanish. */
export function fmtHM(h, m) {
  if (lang === "en") return ((h % 12) || 12) + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM");
  return new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, h, m));
}
/** Short weekday name, 0 = Sunday ("Tue", "mar"). */
export const weekdayShort = i => t("wd." + i);
/** One-letter weekday for the calendar head ("T", "M"). */
export const weekdayLetter = i => t("wdl." + i);
/** First letter upper case ("lunes, 16 de noviembre" → "Lunes, 16 de noviembre"). */
export const capFirst = s => (s ? s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1) : s);
