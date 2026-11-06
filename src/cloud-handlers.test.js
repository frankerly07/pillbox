import { describe, it, expect } from "vitest";
import { acceptInvite, commitDose, createInvite, createMemoryDb, planDoseCommit, previewInvite, revokeCaregiver } from "./cloud-handlers.js";
import { normalizeMed } from "./model.js";
import { INVITE_MAX_FAILURES } from "./access.js";

const NOW = new Date(2026, 10, 4, 12, 0).getTime();

function seed() {
  return {
    patients: {
      pat: {
        ownerUid: "pat", name: "Ada", meds: [normalizeMed({ id: "a", name: "Vitamin", doseAmount: 1, doseUnit: "pills", supplyUnit: "pills", type: "pill", times: ["08:00"], stock: 10, schedule: { kind: "daily" } })],
        doses: {}, stockLog: [], doseAudit: [], appliedOps: [], access: {}, caregiverUids: [],
      },
    },
  };
}
const owner = { uid: "pat", name: "Ada", uiRole: "caregiver" };
const cmd = (opId) => ({
  opId, kind: "log", medId: "a", key: "a_2026-11-04_0800", extra: false, slot: "08:00",
  day: "2026-11-04", time: "08:00", at: new Date(2026, 10, 4, 8, 5).toISOString(), amount: 1, unit: "pills",
  actor: owner,
});

describe("invitations on the server", () => {
  it("returns a code once, shows who it connects, then rejects reuse and a stranger", async () => {
    const db = createMemoryDb(seed());
    const created = await createInvite(db, { actor: owner, patientId: "pat", permission: "read", now: NOW, randomBytes: Uint8Array.from({ length: 10 }, (_, i) => i + 3) });
    expect(created.ok).toBe(true);
    expect(created.payload.startsWith("pillbox:invite:v1:")).toBe(true);
    expect(created.payload).not.toContain("Vitamin");
    const stored = JSON.stringify(db.state.invites);
    expect(stored).not.toContain(created.inviteCode.replace(/-/g, ""));
    expect(stored).not.toContain("Vitamin");
    expect(Object.values(db.state.invites)[0].permission).toBe("read");

    const preview = await previewInvite(db, { actor: { uid: "care", name: "Bo", uiRole: "patient" }, codeText: created.payload, now: NOW + 1000 });
    expect(preview).toMatchObject({ ok: true, patientName: "Ada", permission: "read" });
    expect(preview.meds).toBeUndefined();
    expect(db.state.invites[Object.keys(db.state.invites)[0]].usedAt).toBeNull();

    const accepted = await acceptInvite(db, { actor: { uid: "care", name: "Bo" }, codeText: created.inviteCode, now: NOW + 2000 });
    expect(accepted).toMatchObject({ code: "accepted", patientName: "Ada", permission: "read" });
    expect(db.state.patients.pat.meds[0].name).toBe("Vitamin");
    expect(db.state.patients.pat.access.care.permission).toBe("read");

    const again = await acceptInvite(db, { actor: { uid: "other", name: "Cy" }, codeText: created.inviteCode, now: NOW + 3000 });
    expect(again.ok).toBe(false);
    expect(db.state.patients.pat.access.other).toBeUndefined();
    const replay = await acceptInvite(db, { actor: { uid: "care", name: "Bo" }, codeText: created.payload, now: NOW + 4000 });
    expect(replay.code).toBe("replay");
  });

  it("expires, blocks a burst of wrong codes, and does not let the patient use their own code", async () => {
    const db = createMemoryDb(seed());
    const created = await createInvite(db, { actor: owner, patientId: "pat", permission: "logEdit", now: NOW, randomBytes: Uint8Array.from({ length: 10 }, () => 9) });
    expect((await acceptInvite(db, { actor: owner, codeText: created.inviteCode, now: NOW + 1000 })).code).toBe("self");
    expect((await acceptInvite(db, { actor: { uid: "care" }, codeText: created.inviteCode, now: NOW + 31 * 60 * 1000 })).code).toBe("expired");
    const fresh = createMemoryDb(seed());
    for (let i = 0; i < INVITE_MAX_FAILURES; i++) {
      expect((await previewInvite(fresh, { actor: { uid: "care" }, codeText: "ZZZZ-ZZZZ-ZZZZ-ZZZ" + "Y", now: NOW + i })).ok).toBe(false);
    }
    const late = await createInvite(fresh, { actor: owner, patientId: "pat", permission: "read", now: NOW, randomBytes: Uint8Array.from({ length: 10 }, () => 4) });
    const blocked = await previewInvite(fresh, { actor: { uid: "care" }, codeText: late.inviteCode, now: NOW + 10 });
    expect(blocked.code).toBe("limited");
    expect(fresh.state.patients.pat.access.care).toBeUndefined();
  });

  it("denies logging after revoke and never grants access from a UI role", async () => {
    const db = createMemoryDb(seed());
    const created = await createInvite(db, { actor: owner, patientId: "pat", permission: "logEdit", now: NOW, randomBytes: Uint8Array.from({ length: 10 }, () => 8) });
    await acceptInvite(db, { actor: { uid: "care", name: "Bo", uiRole: "patient" }, codeText: created.inviteCode, now: NOW + 1 });
    const logged = await commitDose(db, { actor: { uid: "care", uiRole: "patient" }, pid: "pat", cmd: cmd("c1"), now: NOW });
    expect(logged.code).toBe("applied");
    expect(db.state.patients.pat.meds[0].stock).toBe(9);
    await revokeCaregiver(db, { actor: owner, pid: "pat", caregiverUid: "care" });
    const after = await commitDose(db, { actor: { uid: "care", uiRole: "caregiver" }, pid: "pat", cmd: cmd("c2"), now: NOW });
    expect(after.code).toBe("denied");
    expect(db.state.patients.pat.meds[0].stock).toBe(9);
    const stranger = await commitDose(db, { actor: { uid: "nope", uiRole: "caregiver" }, pid: "pat", cmd: cmd("c3"), now: NOW });
    expect(stranger.code).toBe("denied");
    const readDb = createMemoryDb(seed());
    const readInvite = await createInvite(readDb, { actor: owner, patientId: "pat", permission: "read", now: NOW, randomBytes: Uint8Array.from({ length: 10 }, () => 6) });
    await acceptInvite(readDb, { actor: { uid: "care", name: "Bo" }, codeText: readInvite.inviteCode, now: NOW });
    expect((await commitDose(readDb, { actor: { uid: "care", uiRole: "caregiver" }, pid: "pat", cmd: cmd("r1"), now: NOW })).code).toBe("denied");
    expect(readDb.state.patients.pat.meds[0].stock).toBe(10);
  });
});

describe("transaction plan", () => {
  it("a second plan that still sees the old dose would deduct, but a plan that sees the write does not", () => {
    const med = normalizeMed({ id: "a", name: "Vitamin", doseAmount: 1, doseUnit: "pills", supplyUnit: "pills", type: "pill", times: ["08:00"], stock: 10, schedule: { kind: "daily" } });
    const parent = { ownerUid: "pat", name: "Ada", appliedOps: [] };
    const first = planDoseCommit({ parent, med, dose: null, opExists: false }, cmd("op-a"), NOW);
    const stale = planDoseCommit({ parent, med, dose: null, opExists: false }, cmd("op-b"), NOW);
    expect(first.result.delta).toBe(-1);
    expect(stale.result.delta).toBe(-1);
    const after = planDoseCommit({ parent, med: { ...med, stock: first.medStock }, dose: first.dose, opExists: false }, cmd("op-b"), NOW);
    expect(after.result.code).toBe("already-logged");
    expect(after.dose).toBeNull();
    expect(after.medStock).toBeNull();
    const retry = planDoseCommit({ parent, med, dose: null, opExists: true }, cmd("op-a"), NOW);
    expect(retry.result.code).toBe("replay");
    expect(retry.medStock).toBeNull();
  });
});

describe("dose handler races", () => {
  it("retries a lost save once and does not deduct twice", async () => {
    const db = createMemoryDb(seed());
    let saves = 0;
    const real = db.savePatient.bind(db);
    db.savePatient = async (pid, patient, rev) => {
      saves += 1;
      if (saves === 1) { const err = new Error("conflict"); err.code = "conflict"; throw err; }
      return real(pid, patient, rev);
    };
    const res = await commitDose(db, { actor: owner, pid: "pat", cmd: cmd("op"), now: NOW });
    expect(res.code).toBe("applied");
    expect(db.state.patients.pat.meds[0].stock).toBe(9);
    const second = await commitDose(db, { actor: owner, pid: "pat", cmd: cmd("op-2"), now: NOW });
    expect(second.code).toBe("already-logged");
    expect(db.state.patients.pat.meds[0].stock).toBe(9);
    const replay = await commitDose(db, { actor: owner, pid: "pat", cmd: cmd("op"), now: NOW });
    expect(replay.code).toBe("replay");
    expect(db.state.patients.pat.meds[0].stock).toBe(9);
  });
});
