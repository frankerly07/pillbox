// Who can see a person's record, and invitations to connect.
// A UI role (patient / caregiver / both) is never an input here. Access is the owner id
// or an entry the patient approved. Invite secrets are random, single-use, and carry no medical details.

export const INVITE_TTL_MS = 30 * 60 * 1000;
export const INVITE_MAX_FAILURES = 8;
export const INVITE_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const PERMISSIONS = {
  read: "View only",
  logEdit: "Can log and edit",
};
// No 0/O/1/I. 32 symbols × 16 = 80 bits from 10 random bytes.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeInviteCode(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z2-9]/g, "").replace(/[O0]/g, "").replace(/[I1]/g, "");
}

export function generateInviteCode(randomBytes) {
  const bytes = randomBytes || crypto.getRandomValues(new Uint8Array(10));
  if (!bytes || bytes.length < 10) throw new Error("Need 10 random bytes.");
  let value = 0n;
  for (let i = 0; i < 10; i++) value = (value << 8n) | BigInt(bytes[i]);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out.slice(0, 4) + "-" + out.slice(4, 8) + "-" + out.slice(8, 12) + "-" + out.slice(12, 16);
}

export async function hashInviteCode(code) {
  const norm = normalizeInviteCode(code);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(norm));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** QR and manual entry carry the same opaque code. No name, no medicines. */
export function inviteQrPayload(code) {
  const norm = normalizeInviteCode(code);
  if (norm.length !== 16) throw new Error("Invite code is the wrong length.");
  return "pillbox:invite:v1:" + norm;
}

export function parseInviteInput(text) {
  const raw = String(text || "").trim();
  const body = raw.replace(/^pillbox:invite:v1:/i, "");
  const code = normalizeInviteCode(body);
  return code.length === 16 ? code : null;
}

export function cleanDisplayName(name, fallback = "Someone") {
  const s = String(name || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80);
  return s || fallback;
}

/**
 * Invite record stored server-side. Extra fields on `input` (medicines, notes, tokens) are dropped.
 * The raw code is not stored; callers persist `hash` from hashInviteCode(code).
 */
export function buildInviteRecord({ patientId, patientName, permission, hash, now = Date.now(), ttlMs = INVITE_TTL_MS }) {
  if (!patientId) throw new Error("Missing patient.");
  if (!PERMISSIONS[permission]) throw new Error("Choose view only, or log and edit.");
  if (!hash || String(hash).length < 32) throw new Error("Missing invite hash.");
  return {
    hash: String(hash),
    patientId: String(patientId),
    patientName: cleanDisplayName(patientName, "Patient"),
    permission,
    createdAt: now,
    expiresAt: now + ttlMs,
    usedAt: null,
    usedBy: null,
  };
}

export function inviteFailureMessage() {
  return "That code isn't valid, was already used, or has expired. Ask for a new one.";
}

/** Preview does not consume the invite. Returns only who and what permission, never medicines. */
export function previewInviteRecord(record, { hash, now = Date.now() } = {}) {
  if (!record || record.hash !== hash) return { ok: false, code: "invalid", message: inviteFailureMessage() };
  if (record.usedAt) return { ok: false, code: "used", message: inviteFailureMessage() };
  if (!(now < record.expiresAt)) return { ok: false, code: "expired", message: inviteFailureMessage() };
  return {
    ok: true,
    code: "ok",
    patientId: record.patientId,
    patientName: record.patientName,
    permission: record.permission,
    permissionLabel: PERMISSIONS[record.permission],
    expiresAt: record.expiresAt,
  };
}

/**
 * Accept consumes the invite. The same caregiver retrying after success is a replay.
 * A second person, or the patient themselves, cannot use it.
 */
export function decideAccept(record, patient, { hash, caregiverUid, caregiverName, now = Date.now() } = {}) {
  if (!caregiverUid) return { ok: false, code: "denied", message: "Sign in before using a code." };
  if (record && record.hash === hash && caregiverUid === record.patientId) return { ok: false, code: "self", message: "You can't connect to your own record with a code." };
  if (record && record.hash === hash && record.usedBy === caregiverUid && patient && patient.access && patient.access[caregiverUid]) {
    return {
      ok: true, code: "replay",
      patientId: record.patientId, patientName: record.patientName,
      permission: patient.access[caregiverUid].permission,
      permissionLabel: PERMISSIONS[patient.access[caregiverUid].permission] || "",
    };
  }
  const preview = previewInviteRecord(record, { hash, now });
  if (!preview.ok) return preview;
  if (!patient || patient.ownerUid !== record.patientId) return { ok: false, code: "invalid", message: inviteFailureMessage() };
  const entry = { permission: record.permission, name: cleanDisplayName(caregiverName, "Caregiver"), since: now };
  return {
    ok: true,
    code: "accepted",
    patientId: record.patientId,
    patientName: record.patientName,
    permission: record.permission,
    permissionLabel: PERMISSIONS[record.permission],
    invite: { ...record, usedAt: now, usedBy: caregiverUid },
    entry,
    patient: grantAccess(patient, caregiverUid, entry),
  };
}

/** Add one approved person without touching medicines, doses, or other people's access. */
export function grantAccess(patient, caregiverUid, entry) {
  const access = { ...(patient.access || {}), [caregiverUid]: entry };
  const caregiverUids = [...new Set([...(patient.caregiverUids || []), caregiverUid])];
  return { ...patient, access, caregiverUids };
}

export function decideRevoke(patient, { ownerUid, caregiverUid } = {}) {
  if (!patient || ownerUid !== patient.ownerUid) return { ok: false, code: "denied", message: "Only the person this record belongs to can remove someone." };
  if (!caregiverUid || caregiverUid === patient.ownerUid) return { ok: false, code: "bad-command", message: "Choose someone to remove." };
  const access = { ...(patient.access || {}) };
  delete access[caregiverUid];
  const caregiverUids = (patient.caregiverUids || []).filter(id => id !== caregiverUid);
  const caregivers = (patient.caregivers || []).filter(id => id !== caregiverUid);
  return { ok: true, code: "revoked", patient: { ...patient, access, caregiverUids, caregivers } };
}

/**
 * @param {{uid?:string, uiRole?:string}} actor uiRole is ignored on purpose
 * @param {{ownerUid?:string, access?:object}} patient
 * @param {'view'|'log'|'editMed'|'manageAccess'} action
 */
export function can(actor, patient, action) {
  const uid = actor && actor.uid;
  if (!uid || !patient || !patient.ownerUid) return false;
  if (uid === patient.ownerUid) return true;
  const entry = patient.access && patient.access[uid];
  if (!entry) return false;
  if (action === "view") return entry.permission === "read" || entry.permission === "logEdit";
  if (action === "log" || action === "editMed") return entry.permission === "logEdit";
  return false;
}

export function recentFailures(times, now = Date.now()) {
  return (times || []).filter(t => typeof t === "number" && now - t < INVITE_FAILURE_WINDOW_MS);
}

export function rateLimitOk(times, now = Date.now()) {
  return recentFailures(times, now).length < INVITE_MAX_FAILURES;
}
