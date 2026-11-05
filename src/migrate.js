// Local records live in this app's own storage. A different Android package is a different sandbox;
// this module never claims it can see the other app. It only keeps data already in this one,
// and builds a backup file a person can move themselves.
import { normalizeMed, normalizeEvent } from "./model.js";

const DROP = ["access", "caregivers", "caregiverUids", "caregiverNames", "linkCode", "linkCodeExpires", "joinCode", "apiKey", "password", "token", "email", "secret"];

export function emptyPatient(id, name) {
  return {
    id, name, meds: [], doses: {}, events: {}, stockLog: [], doseAudit: [], appliedOps: [],
    caregivers: [], caregiverUids: [], access: {}, localOnly: true,
  };
}

function copyPatient(id, p) {
  const next = {
    ...p,
    id: p.id || id,
    name: p.name || "Person",
    meds: (p.meds || []).map(normalizeMed),
    doses: p.doses && typeof p.doses === "object" ? p.doses : {},
    events: p.events && typeof p.events === "object" ? p.events : {},
    stockLog: Array.isArray(p.stockLog) ? p.stockLog : [],
    doseAudit: Array.isArray(p.doseAudit) ? p.doseAudit : [],
    appliedOps: Array.isArray(p.appliedOps) ? p.appliedOps : [],
    access: p.access && typeof p.access === "object" ? p.access : {},
    caregivers: Array.isArray(p.caregivers) ? p.caregivers : [],
    caregiverUids: Array.isArray(p.caregiverUids) ? p.caregiverUids : [],
  };
  return next;
}

export function suggestedProfile(data, { legacyCarePackage = false } = {}) {
  const saved = data && data.profile;
  if (saved && saved.onboarded) {
    return {
      usePatient: !!saved.usePatient,
      useCaregiver: !!saved.useCaregiver,
      recommended: saved.recommended === "yes" || saved.recommended === "no" || saved.recommended === "skip" ? saved.recommended : null,
      onboarded: true,
    };
  }
  const wasCaregiver = data?.role === "caregiver" || (legacyCarePackage && data?.role !== "patient");
  if (wasCaregiver) return { usePatient: false, useCaregiver: true, recommended: null, onboarded: false };
  return { usePatient: true, useCaregiver: false, recommended: null, onboarded: false };
}

/**
 * Keep every patient already stored. A role mismatch must not reseed or delete them.
 * `fresh` means this install has no saved record yet.
 */
export function migrateLocalData(data, opts = {}) {
  const legacy = !!opts.legacyCarePackage;
  if (!data || typeof data !== "object" || !data.patients || typeof data.patients !== "object") {
    return {
      version: 3,
      role: legacy ? "caregiver" : "patient",
      example: false,
      patients: {},
      profile: null,
      suggested: suggestedProfile(data, opts),
      fresh: true,
    };
  }
  const patients = {};
  for (const [id, p] of Object.entries(data.patients)) {
    if (!p || typeof p !== "object") continue;
    patients[id] = copyPatient(id, p);
  }
  const profile = data.profile && data.profile.onboarded ? suggestedProfile(data, opts) : null;
  return {
    version: 3,
    // Remember the package this file was last saved by so an older build of THAT app
    // still sees role match and does not throw the record away. Not an access check.
    role: legacy ? "caregiver" : "patient",
    example: !!data.example,
    patients,
    profile,
    suggested: profile || suggestedProfile(data, opts),
    fresh: false,
  };
}

function strippedPatient(id, p) {
  const next = {
    id: p.id || id,
    name: p.name || "Person",
    meds: (p.meds || []).map(m => ({ ...m })),
    doses: { ...(p.doses || {}) },
    events: { ...(p.events || {}) },
    stockLog: [...(p.stockLog || [])],
    doseAudit: [...(p.doseAudit || [])],
    appliedOps: [...(p.appliedOps || [])],
    localOnly: true,
  };
  for (const k of DROP) delete next[k];
  return next;
}

/** A file the person can keep. No access map, codes, or account fields. */
export function buildBackup(patients, now = Date.now()) {
  const out = {};
  for (const [id, p] of Object.entries(patients || {})) {
    if (!p || typeof p !== "object") continue;
    out[id] = strippedPatient(id, p);
  }
  return { pillboxBackup: 1, exportedAt: new Date(now).toISOString(), patients: out };
}

function newId(id, taken, n) {
  let i = n;
  let candidate = id + "-import-" + i;
  while (taken[candidate]) { i += 1; candidate = id + "-import-" + i; }
  return candidate;
}

/**
 * Add backup patients beside the ones already here. Does not delete existing meds.
 * If `intoEmptyId` points at a record with no medicines and the file has one person,
 * those medicines restore into that record (the usual move onto a new install).
 */
export function planImport(existingPatients, backup, { intoEmptyId = null, idStart = 1 } = {}) {
  if (!backup || backup.pillboxBackup !== 1 || !backup.patients || typeof backup.patients !== "object") {
    return { ok: false, message: "That file isn't a Pillbox backup." };
  }
  const patients = {};
  for (const [id, p] of Object.entries(existingPatients || {})) patients[id] = structuredClone(p);
  const entries = Object.entries(backup.patients).filter(([, p]) => p && typeof p === "object");
  if (!entries.length) return { ok: false, message: "That backup has no records." };
  const imported = [];
  const emptyTarget = intoEmptyId && patients[intoEmptyId] && !(patients[intoEmptyId].meds || []).length ? intoEmptyId : null;
  if (emptyTarget && entries.length === 1) {
    const [, raw] = entries[0];
    const meds = (raw.meds || []).map(normalizeMed);
    const events = {};
    for (const [eid, ev] of Object.entries(raw.events || {})) events[eid] = normalizeEvent({ ...ev, id: eid });
    patients[emptyTarget] = {
      ...patients[emptyTarget],
      name: patients[emptyTarget].name && patients[emptyTarget].name !== "Me" ? patients[emptyTarget].name : (raw.name || patients[emptyTarget].name),
      meds,
      doses: raw.doses && typeof raw.doses === "object" ? raw.doses : {},
      events,
      stockLog: Array.isArray(raw.stockLog) ? raw.stockLog : [],
      doseAudit: Array.isArray(raw.doseAudit) ? raw.doseAudit : [],
      appliedOps: Array.isArray(raw.appliedOps) ? raw.appliedOps : [],
    };
    imported.push(emptyTarget);
    return { ok: true, patients, imported, message: "Backup restored on this phone. This does not connect another phone." };
  }
  let n = idStart;
  for (const [id, raw] of entries) {
    const events = {};
    for (const [eid, ev] of Object.entries(raw.events || {})) events[eid] = normalizeEvent({ ...ev, id: eid });
    let dest = id;
    if (patients[dest]) { dest = newId(id, patients, n); n += 1; }
    patients[dest] = {
      ...emptyPatient(dest, String(raw.name || "Imported").slice(0, 80)),
      meds: (raw.meds || []).map(normalizeMed),
      doses: raw.doses && typeof raw.doses === "object" ? raw.doses : {},
      events,
      stockLog: Array.isArray(raw.stockLog) ? raw.stockLog : [],
      doseAudit: Array.isArray(raw.doseAudit) ? raw.doseAudit : [],
      appliedOps: Array.isArray(raw.appliedOps) ? raw.appliedOps : [],
      localOnly: true,
      example: false,
    };
    imported.push(dest);
  }
  return { ok: true, patients, imported, message: imported.length === 1 ? "1 record added on this phone. It is not a synced link." : imported.length + " records added on this phone. They are not synced links." };
}
