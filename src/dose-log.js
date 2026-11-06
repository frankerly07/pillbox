// One administration change and the inventory delta that goes with it.
// Pure: same command + same state => same result. Callers persist only when code is "applied".
// `actor.uiRole` is stored as a label ("patient" / "caregiver"). It is not an access check.
import { normalizeMed, supplyPerDose, supplyTaken, dayKey, hm, CONTAINERS } from "./model.js";

const round6 = n => Math.round(Number(n) * 1e6) / 1e6;
const MAX_OPS = 5000;

function clonePatient(patient) {
  const next = structuredClone(patient || {});
  next.meds = Array.isArray(next.meds) ? next.meds : [];
  next.doses = next.doses && typeof next.doses === "object" ? next.doses : {};
  next.stockLog = Array.isArray(next.stockLog) ? next.stockLog : [];
  next.doseAudit = Array.isArray(next.doseAudit) ? next.doseAudit : [];
  next.appliedOps = Array.isArray(next.appliedOps) ? next.appliedOps : [];
  return next;
}

function fail(code, message) {
  return { ok: false, code, message, delta: 0, key: null, dose: null, stockEntry: null, audit: null };
}

/**
 * Supply consumed by an actual logged amount.
 * The configured dose (amount + unit equal to the medicine) matches supplyPerDose, so a normal tap
 * moves inventory the same way it did before. A different actual amount scales from that cost when
 * the unit is one we can convert. Returns null when the unit can't be counted without guessing.
 */
export function supplyUsed(med, amount, unit) {
  const m = normalizeMed(med);
  const a = Number(amount);
  if (!(a > 0) || !unit) return null;
  if (a === m.doseAmount && unit === m.doseUnit) return round6(supplyPerDose(m));
  if (unit === m.supplyUnit) return round6(a);
  if (CONTAINERS.includes(m.supplyUnit)) {
    const per = m.perContainer || 1;
    if (unit === "doses") return round6(a / per);
    if (unit === m.doseUnit && m.doseAmount > 0) return round6((a / m.doseAmount) / per);
    return null;
  }
  if (m.supplyUnit === "doses") {
    if (unit === "doses") return round6(a);
    if (unit === m.doseUnit && m.doseAmount > 0) return round6(a / m.doseAmount);
    return null;
  }
  return null;
}

function labelOf(actor) {
  return actor && actor.uiRole === "caregiver" ? "caregiver" : "patient";
}

/**
 * @returns {{ok:boolean, code:string, message:string, patient?:object, delta:number, key:?string, removedKey:?string, dose:?object, stockEntry:?object, audit:?object, at?:string}}
 * Codes: applied | replay | already-logged | missing | no-med | bad-command | unconvertible | supply-unit-changed | future | unchanged
 */
export function commitAdministration(patient, cmd = {}, now = Date.now()) {
  const opId = typeof cmd.opId === "string" ? cmd.opId.trim() : "";
  if (!opId) return fail("bad-command", "This change is missing an id, so it was not saved.");
  const original = clonePatient(patient);
  if (original.appliedOps.includes(opId)) {
    return { ok: true, code: "replay", message: "Already saved.", patient: original, delta: 0, key: cmd.key || null, dose: null, stockEntry: null, audit: null };
  }
  const kind = cmd.kind;
  if (!["log", "edit", "remove", "skip"].includes(kind)) return fail("bad-command", "That change isn't recognized.");
  const next = clonePatient(patient);
  const med = next.meds.find(m => m && m.id === cmd.medId);
  if (!med) return fail("no-med", "That medicine isn't on this list.");
  const view = normalizeMed(med);
  const actor = cmd.actor || {};
  const atMs = cmd.at != null ? new Date(cmd.at).getTime() : now;
  if ((kind === "log" || kind === "edit") && !Number.isFinite(atMs)) return fail("bad-command", "That time isn't valid.");
  if ((kind === "log" || kind === "edit") && atMs > now + 60000) return fail("future", "That time hasn't happened yet.");

  let stockEntry = null;
  let audit = null;
  const remember = () => {
    next.appliedOps.push(opId);
    if (next.appliedOps.length > MAX_OPS) next.appliedOps = next.appliedOps.slice(-MAX_OPS);
  };
  // Apply a supply delta once. Stock is not clamped, so a later undo adds back the same number.
  const moveStock = (delta, reason, note, key) => {
    const tracked = typeof med.stock === "number";
    const applied = tracked ? round6(delta) : 0;
    if (tracked && applied) med.stock = round6(med.stock + applied);
    if (applied) {
      stockEntry = {
        id: opId, opId, medId: med.id, delta: applied,
        after: tracked ? med.stock : null, reason, note: note || "",
        by: labelOf(actor), byName: actor.name || "", at: new Date(now).toISOString(), key,
      };
      next.stockLog.push(stockEntry);
      next.stockLog = next.stockLog.slice(-500);
    }
    return applied;
  };
  const addAudit = (action, key, snapshot) => {
    audit = { opId, action, key, medId: med.id, at: new Date(now).toISOString(), by: labelOf(actor), byName: actor.name || "", snapshot };
    next.doseAudit.push(audit);
    next.doseAudit = next.doseAudit.slice(-500);
  };
  const done = (code, message, key, delta, extra = {}) => {
    remember();
    return { ok: true, code, message, patient: next, delta, key, dose: key ? next.doses[key] || null : null, stockEntry, audit, ...extra };
  };

  if (kind === "log") {
    const extra = !!cmd.extra;
    const key = extra ? "extra_" + med.id + "_" + opId : cmd.key;
    if (!extra && !key) return fail("bad-command", "Missing the scheduled dose to log.");
    const existing = next.doses[key];
    if (!extra && existing && existing.status === "taken") {
      return { ok: false, code: "already-logged", message: "This scheduled treatment is already logged.", delta: 0, key, at: existing.at, dose: existing, stockEntry: null, audit: null };
    }
    const amount = cmd.amount != null && cmd.amount !== "" ? Number(cmd.amount) : view.doseAmount;
    const unit = cmd.unit || view.doseUnit;
    const used = supplyUsed(view, amount, unit);
    if (used == null) return fail("unconvertible", "That amount can't be counted in the current supply unit. Correct the count on the medicine page instead of guessing.");
    const when = new Date(atMs);
    const prevUsed = existing && existing.status === "taken" ? (Number(existing.used) || 0) : 0;
    const dose = {
      medId: med.id,
      day: extra ? (cmd.day || dayKey(when)) : (cmd.day || existing?.day || dayKey(when)),
      time: extra ? (cmd.time || hm(when)) : (existing?.time || cmd.time || hm(when)),
      slot: extra ? null : (cmd.slot || existing?.slot || cmd.time || hm(when)),
      status: "taken",
      at: when.toISOString(),
      source: cmd.source || "app",
      by: labelOf(actor),
      byName: actor.name || "",
      extra,
      amount, unit, used,
      supplyUnit: view.supplyUnit,
      prescribedAmount: view.doseAmount,
      prescribedUnit: view.doseUnit,
      opId,
    };
    next.doses[key] = dose;
    const delta = moveStock(round6(prevUsed - used), extra ? "additional" : "taken", extra ? "additional treatment" : "", key);
    return done("applied", extra ? "Additional treatment logged." : "Treatment logged.", key, delta);
  }

  if (kind === "edit") {
    const key = cmd.key;
    const existing = key && next.doses[key];
    if (!existing || existing.status !== "taken") return fail("missing", "There isn't a logged treatment to change.");
    const amount = cmd.amount != null && cmd.amount !== "" ? Number(cmd.amount) : (existing.amount != null ? Number(existing.amount) : view.doseAmount);
    const unit = cmd.unit || existing.unit || view.doseUnit;
    const amountSame = existing.amount != null && Number(existing.amount) === Number(amount) && (existing.unit || view.doseUnit) === unit;
    if (existing.supplyUnit && existing.supplyUnit !== view.supplyUnit && !amountSame) {
      return fail("supply-unit-changed", "The supply unit changed after this was logged, so the count can't be adjusted from here. Correct the count on the medicine page.");
    }
    let used;
    if (amountSame && Number.isFinite(Number(existing.used))) used = round6(existing.used);
    else if (existing.unit === unit && Number(existing.amount) > 0 && Number.isFinite(Number(existing.used))) used = round6(Number(existing.used) * (Number(amount) / Number(existing.amount)));
    else {
      used = supplyUsed(view, amount, unit);
      if (used == null) return fail("unconvertible", "That amount can't be counted in the current supply unit. Correct the count on the medicine page instead of guessing.");
    }
    const when = new Date(atMs);
    const prevUsed = Number.isFinite(Number(existing.used)) ? round6(existing.used) : round6(supplyTaken(existing, med));
    const dose = {
      ...existing,
      extra: !!existing.extra,
      amount, unit, used,
      at: when.toISOString(),
      supplyUnit: existing.supplyUnit || view.supplyUnit,
      prescribedAmount: existing.prescribedAmount ?? view.doseAmount,
      prescribedUnit: existing.prescribedUnit ?? view.doseUnit,
      editedAt: new Date(now).toISOString(),
      editedBy: actor.name || "",
      opId,
    };
    if (existing.extra) {
      dose.day = cmd.day || dayKey(when);
      dose.time = cmd.time || hm(when);
      dose.slot = null;
    }
    next.doses[key] = dose;
    const delta = moveStock(round6(prevUsed - used), "edit", "", key);
    addAudit("edit", key, { before: { amount: existing.amount ?? null, unit: existing.unit ?? null, used: prevUsed, at: existing.at }, after: { amount, unit, used, at: dose.at } });
    return done("applied", "Logged treatment updated.", key, delta);
  }

  if (kind === "remove") {
    const key = cmd.key;
    const existing = key && next.doses[key];
    if (!existing) return fail("missing", "That log is already gone.");
    const prevUsed = existing.status === "taken" ? (Number.isFinite(Number(existing.used)) ? round6(existing.used) : round6(supplyTaken(existing, med))) : 0;
    delete next.doses[key];
    const delta = moveStock(prevUsed, "removed", existing.extra ? "additional treatment removed" : "logged treatment removed", key);
    addAudit("remove", key, existing);
    return done("applied", "Logged treatment removed.", null, delta, { removedKey: key });
  }

  // skip: the scheduled slot stays on the schedule as not taken. It does not delete the schedule.
  const key = cmd.key;
  if (!key) return fail("bad-command", "Missing the scheduled dose.");
  const existing = next.doses[key];
  if (existing?.extra) return fail("bad-command", "An additional log is removed, not skipped. Skipping only marks a scheduled dose as not taken.");
  if (existing?.status === "skipped") return done("unchanged", "Already marked skipped.", key, 0);
  const prevUsed = existing?.status === "taken" ? (Number(existing.used) || 0) : 0;
  const when = Number.isFinite(atMs) ? new Date(atMs) : new Date(now);
  next.doses[key] = {
    medId: med.id,
    day: existing?.day || cmd.day || dayKey(when),
    time: existing?.time || cmd.time || hm(when),
    slot: existing?.slot || cmd.slot || existing?.time || cmd.time || null,
    status: "skipped",
    at: when.toISOString(),
    source: cmd.source || "app",
    by: labelOf(actor),
    byName: actor.name || "",
    extra: false,
    used: 0,
    amount: existing?.amount ?? null,
    unit: existing?.unit ?? null,
    opId,
  };
  const delta = moveStock(prevUsed, "undo", "skipped", key);
  addAudit("skip", key, { previousStatus: existing?.status || "open" });
  return done("applied", "Scheduled dose marked skipped.", key, delta);
}
