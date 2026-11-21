// Optional period log for people who chose the female body figure. Pure functions only: no DOM, no storage.
// Days are local calendar days as "YYYY-MM-DD" strings. Day math runs on UTC midnights built from those
// strings, so daylight-saving changes and time zones never shift a day.
// Estimates come only from logged dates. Nothing here predicts fertility or ovulation.

export const FLOWS = ["light", "medium", "heavy"];
export const SYMPTOMS = ["cramps", "headache", "mood", "bloating", "spotting", "other"];
/** Start-to-start gaps outside this range are left out of the average as outliers. */
export const MIN_CYCLE = 15, MAX_CYCLE = 60;
/** A logged period longer than this is not used for the average period length (and is refused by the form). */
export const MAX_PERIOD = 20;
/** A period with no last day is shown as ongoing for at most this many days. */
export const OPEN_DAYS = 10;
const NOTE_MAX = 500;
const DAY_MS = 86400000;

/** Shown only for the female figure, and only after "Track my cycle" is turned on. Data is kept either way. */
export const cycleEnabled = settings => settings?.bodyFigure === "female" && settings?.cycleTracking === true;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** UTC midnight for a day key, or NaN when it isn't a real calendar day ("2026-02-30" is not). */
function utc(key) {
  const m = DAY_RE.exec(String(key ?? ""));
  if (!m) return NaN;
  const y = +m[1], mo = +m[2], d = +m[3], ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : NaN;
}
const fromUtc = ms => { const d = new Date(ms); return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0"); };
export const isDayKey = key => !Number.isNaN(utc(key));
/** Whole days from a to b (b later → positive). */
export const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY_MS);
export const addDays = (key, n) => fromUtc(utc(key) + n * DAY_MS);

/** One saved period, cleaned up. Returns null when the first day is missing or not a real day. */
export function normalizePeriod(p = {}, now = Date.now()) {
  if (!p || typeof p !== "object" || !isDayKey(p.start)) return null;
  const end = isDayKey(p.end) && daysBetween(p.start, p.end) >= 0 ? p.end : null;
  const symptoms = SYMPTOMS.filter(s => Array.isArray(p.symptoms) && p.symptoms.includes(s));
  return {
    id: String(p.id || "p-" + p.start),
    start: p.start,
    end,
    flow: FLOWS.includes(p.flow) ? p.flow : "medium",
    symptoms,
    note: String(p.note ?? "").trim().slice(0, NOTE_MAX),
    createdAt: Number(p.createdAt) || now,
    updatedAt: Number(p.updatedAt) || Number(p.createdAt) || now,
  };
}

/** Valid periods, oldest first. Same first day sorts by id so the order is stable. */
export function sortPeriods(list) {
  return (Array.isArray(list) ? list : []).map(p => normalizePeriod(p)).filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/**
 * Logged periods joined into episodes: entries on the same first day, or overlapping each other, count once.
 * An entry with no last day only covers its first day here.
 */
export function episodes(list) {
  const out = [];
  for (const p of sortPeriods(list)) {
    const last = out[out.length - 1];
    if (last && p.start <= (last.end || last.start)) {
      const a = last.end || last.start, b = p.end || p.start;
      if (last.end || p.end) last.end = b > a ? b : a;
      last.ids.push(p.id);
      continue;
    }
    out.push({ start: p.start, end: p.end, ids: [p.id] });
  }
  return out;
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

/**
 * Averages and an estimated next start.
 *   avgCycle    start-to-start, needs 2+ starts and at least one gap of MIN_CYCLE–MAX_CYCLE days
 *   avgPeriod   first-to-last day, inclusive, from periods that have a last day
 *   nextStart   last start + avgCycle (rounded); daysUntil is from `today` (negative if it has passed)
 */
export function cycleStats(list, today = null) {
  const eps = episodes(list);
  const gaps = [];
  for (let i = 1; i < eps.length; i++) gaps.push(daysBetween(eps[i - 1].start, eps[i].start));
  const used = gaps.filter(g => g >= MIN_CYCLE && g <= MAX_CYCLE);
  const lengths = eps.filter(e => e.end).map(e => daysBetween(e.start, e.end) + 1).filter(n => n >= 1 && n <= MAX_PERIOD);
  const avgCycle = used.length ? Math.round(mean(used)) : null;
  const avgPeriod = lengths.length ? Math.round(mean(lengths)) : null;
  const lastStart = eps.length ? eps[eps.length - 1].start : null;
  const nextStart = avgCycle && lastStart ? addDays(lastStart, avgCycle) : null;
  return {
    count: eps.length,
    avgCycle, avgPeriod,
    cycles: used.length, outliers: gaps.length - used.length,
    lastStart, nextStart,
    daysUntil: nextStart && isDayKey(today) ? daysBetween(today, nextStart) : null,
  };
}

/**
 * Every logged bleeding day as a Set of day keys. A period with no last day counts from its first day up to
 * `today`, for at most OPEN_DAYS days (only its first day when `today` isn't given).
 */
export function bleedingDays(list, today = null) {
  const days = new Set();
  for (const p of sortPeriods(list)) {
    let end = p.end;
    if (!end) {
      end = p.start;
      if (isDayKey(today) && today > p.start) { const cap = addDays(p.start, OPEN_DAYS - 1); end = today < cap ? today : cap; }
    }
    for (let k = p.start, n = 0; k <= end && n <= 366; k = addDays(k, 1), n++) days.add(k);
  }
  return days;
}

/** Is this period still going (no last day, started within OPEN_DAYS)? */
export const isOngoing = (p, today) => !!p && !p.end && isDayKey(today) && daysBetween(p.start, today) >= 0 && daysBetween(p.start, today) < OPEN_DAYS;

/**
 * Check a period from the form before saving. `others` are the saved periods (the one being edited is skipped).
 * Returns null when it's fine, else { code, ... } with code "start" | "future" | "endBefore" | "endFuture" | "tooLong" | "overlap".
 */
export function checkPeriod(p, others = [], today) {
  if (!p || !isDayKey(p.start)) return { code: "start" };
  if (isDayKey(today) && p.start > today) return { code: "future" };
  if (p.end) {
    if (!isDayKey(p.end) || p.end < p.start) return { code: "endBefore" };
    if (isDayKey(today) && p.end > today) return { code: "endFuture" };
    if (daysBetween(p.start, p.end) + 1 > MAX_PERIOD) return { code: "tooLong", n: MAX_PERIOD };
  }
  const end = p.end || p.start;
  for (const o of sortPeriods(others)) {
    if (o.id === p.id) continue;
    const oEnd = o.end || o.start;
    if (p.start <= oEnd && o.start <= end) return { code: "overlap", start: o.start };
  }
  return null;
}

/** Periods newest first, for the list. */
export const newestFirst = list => sortPeriods(list).reverse();
