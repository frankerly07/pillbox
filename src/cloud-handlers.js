// Trusted invite and dose operations. Unit-tested against an in-memory database.
// The Firebase wrapper in functions/index.js is not deployed and refuses to register
// unless PILLBOX_FUNCTIONS_DEPLOY=1. No credentials live here.
import {
  INVITE_TTL_MS, PERMISSIONS, buildInviteRecord, can, cleanDisplayName, decideAccept, decideRevoke,
  generateInviteCode, grantAccess, hashInviteCode, inviteFailureMessage, parseInviteInput,
  previewInviteRecord, rateLimitOk, recentFailures,
} from "./access.js";
import { commitAdministration } from "./dose-log.js";

function denied(message) {
  return { ok: false, code: "denied", message };
}

async function tooMany(db, uid, now) {
  const times = await db.failures(uid);
  if (rateLimitOk(times, now)) return null;
  return { ok: false, code: "limited", message: "Too many codes were tried. Wait a few minutes and ask for a new code." };
}

async function noteFailure(db, uid, now) {
  const times = recentFailures(await db.failures(uid), now);
  await db.addFailure(uid, now, times);
}

/**
 * Patient creates an invitation. The raw code is returned once and is not stored.
 * `input` may contain medicines or notes; those are ignored.
 */
export async function createInvite(db, { actor, patientId, patientName, permission, now = Date.now(), randomBytes } = {}) {
  if (!actor?.uid || actor.uid !== patientId) return denied("Only the person this record belongs to can create a code.");
  const patient = await db.getPatient(patientId);
  if (!patient || patient.ownerUid !== actor.uid) return { ok: false, code: "not-found", message: "That record doesn't exist." };
  if (!PERMISSIONS[permission]) return { ok: false, code: "bad-command", message: "Choose view only, or log and edit." };
  const code = generateInviteCode(randomBytes);
  const hash = await hashInviteCode(code);
  const invite = buildInviteRecord({
    patientId, patientName: patientName || patient.name, permission, hash, now, ttlMs: INVITE_TTL_MS,
  });
  await db.saveInvite(invite);
  return {
    ok: true,
    code: "created",
    inviteCode: code,
    expiresAt: invite.expiresAt,
    permission,
    permissionLabel: PERMISSIONS[permission],
    patientName: invite.patientName,
    payload: "pillbox:invite:v1:" + code.replace(/-/g, ""),
  };
}

export async function previewInvite(db, { actor, codeText, now = Date.now() } = {}) {
  if (!actor?.uid) return denied("Sign in before using a code.");
  const blocked = await tooMany(db, actor.uid, now);
  if (blocked) return blocked;
  const parsed = parseInviteInput(codeText);
  if (!parsed) {
    await noteFailure(db, actor.uid, now);
    return { ok: false, code: "invalid", message: inviteFailureMessage() };
  }
  const hash = await hashInviteCode(parsed);
  const record = await db.getInvite(hash);
  const preview = previewInviteRecord(record, { hash, now });
  if (!preview.ok) {
    await noteFailure(db, actor.uid, now);
    return preview;
  }
  return preview;
}

export async function acceptInvite(db, { actor, codeText, caregiverName, now = Date.now() } = {}) {
  if (!actor?.uid) return denied("Sign in before using a code.");
  const blocked = await tooMany(db, actor.uid, now);
  if (blocked) return blocked;
  const parsed = parseInviteInput(codeText);
  if (!parsed) {
    await noteFailure(db, actor.uid, now);
    return { ok: false, code: "invalid", message: inviteFailureMessage() };
  }
  const hash = await hashInviteCode(parsed);
  const record = await db.getInvite(hash);
  const patient = record ? await db.getPatient(record.patientId) : null;
  const decision = decideAccept(record, patient, { hash, caregiverUid: actor.uid, caregiverName: caregiverName || actor.name, now });
  if (decision.code === "replay") {
    return { ok: true, code: "replay", patientId: decision.patientId, patientName: decision.patientName, permission: decision.permission, permissionLabel: decision.permissionLabel };
  }
  if (!decision.ok) {
    if (decision.code !== "self") await noteFailure(db, actor.uid, now);
    return decision;
  }
  await db.commitAccept({
    invite: decision.invite,
    pid: decision.patientId,
    caregiverUid: actor.uid,
    entry: decision.entry,
  });
  return {
    ok: true,
    code: "accepted",
    patientId: decision.patientId,
    patientName: decision.patientName,
    permission: decision.permission,
    permissionLabel: decision.permissionLabel,
  };
}

export async function revokeCaregiver(db, { actor, pid, caregiverUid } = {}) {
  const patient = await db.getPatient(pid);
  const decision = decideRevoke(patient, { ownerUid: actor?.uid, caregiverUid });
  if (!decision.ok) return decision;
  await db.savePatient(pid, decision.patient);
  return { ok: true, code: "revoked" };
}

function publicDose(result) {
  return {
    ok: result.ok,
    code: result.code,
    message: result.message,
    delta: result.delta || 0,
    key: result.key || result.removedKey || null,
    at: result.at || result.dose?.at || null,
  };
}

/**
 * What a transaction should write after re-reading the medicine, the dose, and this op.
 * `appliedOps` / the op document make a retry a no-op. A second op against a dose that is
 * already taken writes nothing. Callers must run this on data read inside the transaction.
 */
export function planDoseCommit({ parent, med, dose, opExists }, cmd, now = Date.now()) {
  const patient = {
    ...(parent || {}),
    meds: med ? [structuredClone(med)] : [],
    doses: dose && cmd.key && !cmd.extra ? { [cmd.key]: structuredClone(dose) } : {},
    stockLog: [],
    doseAudit: [],
    appliedOps: opExists ? [cmd.opId] : [],
  };
  const result = commitAdministration(patient, cmd, now);
  if (result.code !== "applied") {
    return { result: publicDose(result), medStock: null, doseKey: null, dose: null, deleteDose: null, stockEntry: null, audit: null };
  }
  const medOut = result.patient.meds.find(m => m.id === cmd.medId);
  return {
    result: publicDose(result),
    medStock: medOut && typeof medOut.stock === "number" ? medOut.stock : null,
    doseKey: result.key || null,
    dose: result.dose || null,
    deleteDose: result.removedKey || null,
    stockEntry: result.stockEntry || null,
    audit: result.audit || null,
  };
}

/**
 * Serialize a dose change. A save that loses a revision race is retried against the new record,
 * so two overlapping logs of the same dose only change inventory once.
 * `actor.uiRole` is not read; `can()` uses the uid only.
 */
export async function commitDose(db, { actor, pid, cmd, now = Date.now() } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const loaded = await db.readPatient(pid);
    if (!loaded) return { ok: false, code: "not-found", message: "That record doesn't exist.", delta: 0 };
    if (!can(actor, loaded.patient, "log")) {
      return { ok: false, code: "denied", message: "You don't have access to log treatments for this person.", delta: 0 };
    }
    const result = commitAdministration(loaded.patient, cmd, now);
    if (result.code !== "applied") return publicDose(result);
    try {
      await db.savePatient(pid, result.patient, loaded.rev);
      return publicDose(result);
    } catch (err) {
      if (err && err.code === "conflict") continue;
      throw err;
    }
  }
  return { ok: false, code: "conflict", message: "Couldn't save because someone else saved at the same time. Try again.", delta: 0 };
}

export function createMemoryDb(seed = {}) {
  const state = {
    patients: structuredClone(seed.patients || {}),
    invites: {},
    failures: {},
    rev: {},
  };
  for (const id of Object.keys(state.patients)) state.rev[id] = 1;
  return {
    state,
    async getPatient(pid) {
      return state.patients[pid] ? structuredClone(state.patients[pid]) : null;
    },
    async readPatient(pid) {
      if (!state.patients[pid]) return null;
      return { patient: structuredClone(state.patients[pid]), rev: state.rev[pid] || 1 };
    },
    async savePatient(pid, patient, rev) {
      const current = state.rev[pid] || 1;
      if (rev != null && rev !== current) {
        const err = new Error("conflict");
        err.code = "conflict";
        throw err;
      }
      state.patients[pid] = structuredClone(patient);
      state.rev[pid] = current + 1;
    },
    async saveInvite(invite) { state.invites[invite.hash] = structuredClone(invite); },
    async getInvite(hash) { return state.invites[hash] ? structuredClone(state.invites[hash]) : null; },
    async failures(uid) { return [...(state.failures[uid] || [])]; },
    async addFailure(uid, now, recent) {
      const list = recent || state.failures[uid] || [];
      state.failures[uid] = [...list, now];
    },
    async commitAccept({ invite, pid, caregiverUid, entry }) {
      const latest = state.patients[pid];
      if (!latest) throw new Error("missing patient");
      if (state.invites[invite.hash]?.usedAt && state.invites[invite.hash].usedBy !== caregiverUid) {
        const err = new Error("used");
        err.code = "used";
        throw err;
      }
      state.invites[invite.hash] = structuredClone(invite);
      state.patients[pid] = grantAccess(latest, caregiverUid, entry);
      state.rev[pid] = (state.rev[pid] || 1) + 1;
    },
  };
}

export { cleanDisplayName };
