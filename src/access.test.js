import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  PERMISSIONS, buildInviteRecord, can, decideAccept, decideRevoke, generateInviteCode, hashInviteCode,
  inviteQrPayload, normalizeInviteCode, parseInviteInput, previewInviteRecord, rateLimitOk, INVITE_MAX_FAILURES,
} from "./access.js";

const HASH = "a".repeat(64);

describe("invite codes", () => {
  it("uses the random bytes, groups them, and hashes the same way as SHA-256", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
    const code = generateInviteCode(bytes);
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    expect(generateInviteCode(bytes)).toBe(code);
    expect(generateInviteCode(Uint8Array.from({ length: 10 }, (_, i) => 200 - i))).not.toBe(code);
    const norm = normalizeInviteCode(code);
    expect(await hashInviteCode(" " + code.toLowerCase() + " ")).toBe(createHash("sha256").update(norm).digest("hex"));
    const payload = inviteQrPayload(code);
    expect(payload).toBe("pillbox:invite:v1:" + norm);
    expect(payload).not.toContain("{");
    expect(parseInviteInput(payload)).toBe(norm);
    expect(parseInviteInput("nope")).toBeNull();
  });

  it("stores no code and no medical details", () => {
    const record = buildInviteRecord({
      patientId: "pat-1", patientName: "Ada", permission: "read", hash: HASH,
      meds: [{ name: "FactorSecret" }], notes: "knee bleed", stock: 4,
    });
    expect(Object.keys(record).sort()).toEqual(["createdAt", "expiresAt", "hash", "patientId", "patientName", "permission", "usedAt", "usedBy"]);
    const raw = JSON.stringify(record);
    expect(raw).not.toContain("FactorSecret");
    expect(raw).not.toContain("bleed");
    expect(raw).not.toContain("stock");
    expect(record.usedAt).toBeNull();
  });
});

describe("who is connecting, expiry, reuse, revoke", () => {
  const now = 1_700_000_000_000;
  const record = () => buildInviteRecord({ patientId: "pat", patientName: "Ada", permission: "logEdit", hash: HASH, now });
  const patient = () => ({ ownerUid: "pat", name: "Ada", meds: [{ id: "m", name: "Keep" }], access: {}, caregiverUids: [] });

  it("preview names the person and the permission and does not consume the code", () => {
    const preview = previewInviteRecord(record(), { hash: HASH, now: now + 1000 });
    expect(preview).toMatchObject({ ok: true, patientName: "Ada", permission: "logEdit", permissionLabel: PERMISSIONS.logEdit });
    expect(preview.meds).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain("Keep");
    expect(record().usedAt).toBeNull();
  });

  it("accepts once, replays for the same person, and rejects reuse, expiry, and self", () => {
    const accepted = decideAccept(record(), patient(), { hash: HASH, caregiverUid: "care", caregiverName: "Bo", now: now + 1000 });
    expect(accepted.code).toBe("accepted");
    expect(accepted.patient.meds).toEqual([{ id: "m", name: "Keep" }]);
    expect(accepted.patient.access.care).toMatchObject({ permission: "logEdit", name: "Bo" });
    expect(accepted.invite.usedBy).toBe("care");
    const replay = decideAccept(accepted.invite, accepted.patient, { hash: HASH, caregiverUid: "care", now: now + 2000 });
    expect(replay.code).toBe("replay");
    expect(decideAccept(accepted.invite, accepted.patient, { hash: HASH, caregiverUid: "other", now: now + 2000 }).code).toBe("used");
    expect(decideAccept(record(), patient(), { hash: HASH, caregiverUid: "care", now: now + 31 * 60 * 1000 }).code).toBe("expired");
    expect(decideAccept(record(), patient(), { hash: HASH, caregiverUid: "pat", now: now + 1000 }).code).toBe("self");
    expect(decideAccept(record(), patient(), { hash: "b".repeat(64), caregiverUid: "care", now }).code).toBe("invalid");
  });

  it("revoke removes access and the used code still cannot be reused", () => {
    const accepted = decideAccept(record(), patient(), { hash: HASH, caregiverUid: "care", caregiverName: "Bo", now });
    const revoked = decideRevoke(accepted.patient, { ownerUid: "pat", caregiverUid: "care" });
    expect(revoked.patient.access.care).toBeUndefined();
    expect(revoked.patient.caregiverUids).toEqual([]);
    expect(revoked.patient.meds[0].name).toBe("Keep");
    expect(decideRevoke(accepted.patient, { ownerUid: "care", caregiverUid: "pat" }).code).toBe("denied");
    expect(decideAccept(accepted.invite, revoked.patient, { hash: HASH, caregiverUid: "care", now: now + 1000 }).code).toBe("used");
  });
});

describe("access ignores the UI role", () => {
  const patient = {
    ownerUid: "pat",
    access: { care: { permission: "read", name: "Bo" }, editor: { permission: "logEdit", name: "Cy" } },
  };
  it("denies someone with no link, including a caregiver UI role", () => {
    expect(can({ uid: "stranger", uiRole: "caregiver" }, patient, "view")).toBe(false);
    expect(can({ uid: "stranger", uiRole: "patient" }, patient, "log")).toBe(false);
    expect(can({ uid: "care", uiRole: "patient" }, patient, "view")).toBe(true);
    expect(can({ uid: "care", uiRole: "caregiver" }, patient, "log")).toBe(false);
    expect(can({ uid: "care" }, patient, "editMed")).toBe(false);
    expect(can({ uid: "editor", uiRole: "patient" }, patient, "log")).toBe(true);
    expect(can({ uid: "editor" }, patient, "editMed")).toBe(true);
    expect(can({ uid: "editor" }, patient, "manageAccess")).toBe(false);
    expect(can({ uid: "pat", uiRole: "caregiver" }, patient, "manageAccess")).toBe(true);
  });
  it("stops at the failure limit", () => {
    const now = 5_000_000;
    const times = Array.from({ length: INVITE_MAX_FAILURES }, (_, i) => now - i * 1000);
    expect(rateLimitOk(times, now)).toBe(false);
    expect(rateLimitOk(times.map(t => t - 16 * 60 * 1000), now)).toBe(true);
  });
});
