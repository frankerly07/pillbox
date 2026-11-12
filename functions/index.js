// PillAlly Cloud Functions — NOT DEPLOYED.
//
// Billing: Cloud Functions need the Firebase Blaze plan. This file does not enable
// billing, does not call `firebase deploy`, and refuses to register handlers unless
// PILLBOX_FUNCTIONS_DEPLOY=1 is set on purpose. There are no service account keys here.
//
// The behavior tests cover is src/cloud-handlers.js (in-memory). This wrapper is the
// Firebase adapter for a later deploy. The Firebase CLI uploads only this folder, so
// a real deploy must bundle ../src first (see README). Do not point a production
// project at this tree and deploy it as part of the app build.
import { can } from "../src/access.js";
import { acceptInvite, commitDose, createInvite, planDoseCommit, previewInvite, revokeCaregiver } from "../src/cloud-handlers.js";

export const handlers = { createInvite, previewInvite, acceptInvite, revokeCaregiver, commitDose, planDoseCommit };

const REFUSE = "Refusing to register PillAlly Cloud Functions. They are not deployed. Deploying requires the Firebase Blaze plan (billing). This repository does not enable billing and does not contain credentials. Read the README before setting PILLBOX_FUNCTIONS_DEPLOY=1.";

export async function register() {
  if (process.env.PILLBOX_FUNCTIONS_DEPLOY !== "1") throw new Error(REFUSE);
  const { onCall, HttpsError } = await import("firebase-functions/v2/https");
  const { initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  initializeApp();
  const fs = getFirestore();
  const db = firestoreAdapter(fs);
  const call = (fn) => onCall(async (request) => {
    const data = request.data || {};
    const result = await fn(db, { ...data, actor: { uid: request.auth?.uid || null, name: request.auth?.token?.name || data.caregiverName || "" } });
    if (!result || result.ok === false) {
      const code = result?.code === "limited" ? "resource-exhausted" : "permission-denied";
      throw new HttpsError(code, result?.message || "Not allowed");
    }
    return result;
  });
  return {
    createInvite: call(createInvite),
    previewInvite: call(previewInvite),
    acceptInvite: call(acceptInvite),
    revokeCaregiver: call(revokeCaregiver),
    // Re-reads the medicine and dose inside the transaction, then uses the tested planner.
    commitDose: onCall(async (request) => commitDoseInTransaction(fs, request)),
  };
}

function defined(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));
}

async function commitDoseInTransaction(fs, request) {
  const { HttpsError } = await import("firebase-functions/v2/https");
  const data = request.data || {};
  const actor = { uid: request.auth?.uid || null, name: request.auth?.token?.name || "" };
  const { pid, cmd } = data;
  if (!actor.uid || !pid || !cmd?.opId || !cmd?.medId) throw new HttpsError("invalid-argument", "Missing the dose change.");
  const outcome = await fs.runTransaction(async (tx) => {
    const parentRef = fs.doc("patients/" + pid);
    const parentSnap = await tx.get(parentRef);
    if (!parentSnap.exists) return { ok: false, code: "not-found", message: "That record doesn't exist.", delta: 0 };
    const parent = { id: pid, ...parentSnap.data() };
    if (!can(actor, parent, "log")) return { ok: false, code: "denied", message: "You don't have access to log treatments for this person.", delta: 0 };
    const medRef = fs.doc("patients/" + pid + "/meds/" + cmd.medId);
    const medSnap = await tx.get(medRef);
    const opRef = fs.doc("patients/" + pid + "/ops/" + cmd.opId);
    const opSnap = await tx.get(opRef);
    let dose = null;
    if (cmd.key && !cmd.extra) {
      const doseSnap = await tx.get(fs.doc("patients/" + pid + "/doses/" + cmd.key));
      if (doseSnap.exists) dose = doseSnap.data();
    }
    const plan = planDoseCommit({
      parent, med: medSnap.exists ? { ...medSnap.data(), id: cmd.medId } : null, dose, opExists: opSnap.exists,
    }, cmd, Date.now());
    if (plan.result.code !== "applied") return plan.result;
    if (plan.medStock != null) tx.update(medRef, { stock: plan.medStock });
    if (plan.dose && plan.doseKey) tx.set(fs.doc("patients/" + pid + "/doses/" + plan.doseKey), defined(plan.dose));
    if (plan.deleteDose) tx.delete(fs.doc("patients/" + pid + "/doses/" + plan.deleteDose));
    if (plan.stockEntry) tx.set(fs.doc("patients/" + pid + "/stock/" + cmd.opId), defined(plan.stockEntry));
    if (plan.audit) tx.set(fs.doc("patients/" + pid + "/doseAudit/" + cmd.opId), defined(plan.audit));
    tx.set(opRef, { opId: cmd.opId, at: Date.now() });
    return plan.result;
  });
  if (!outcome.ok) throw new HttpsError(outcome.code === "not-found" ? "not-found" : "permission-denied", outcome.message || "Not allowed");
  return outcome;
}

// Admin adapter. Only constructed from register(), which does not run in tests or the app.
function firestoreAdapter(fs) {
  return {
    async getPatient(pid) {
      const snap = await fs.doc("patients/" + pid).get();
      return snap.exists ? { id: pid, ...snap.data() } : null;
    },
    async readPatient(pid) {
      const patient = await this.getPatient(pid);
      return patient ? { patient, rev: 0 } : null;
    },
    async savePatient(pid, patient) {
      // Revoke only. Never rewrite medicines or doses from this path.
      await fs.doc("patients/" + pid).update({
        access: patient.access || {},
        caregiverUids: patient.caregiverUids || [],
        caregivers: patient.caregivers || [],
      });
    },
    async saveInvite(invite) {
      await fs.doc("invites/" + invite.hash).set(invite);
    },
    async getInvite(hash) {
      const snap = await fs.doc("invites/" + hash).get();
      return snap.exists ? snap.data() : null;
    },
    async failures(uid) {
      const snap = await fs.doc("inviteFailures/" + uid).get();
      return snap.exists ? snap.data().times || [] : [];
    },
    async addFailure(uid, now, recent) {
      await fs.doc("inviteFailures/" + uid).set({ times: [...(recent || []), now] });
    },
    async commitAccept({ invite, pid, caregiverUid, entry }) {
      await fs.runTransaction(async (tx) => {
        const inviteRef = fs.doc("invites/" + invite.hash);
        const patientRef = fs.doc("patients/" + pid);
        const currentInvite = await tx.get(inviteRef);
        const currentPatient = await tx.get(patientRef);
        if (!currentPatient.exists) throw Object.assign(new Error("missing"), { code: "not-found" });
        if (currentInvite.exists && currentInvite.data().usedAt && currentInvite.data().usedBy !== caregiverUid) {
          throw Object.assign(new Error("used"), { code: "used" });
        }
        const patient = currentPatient.data();
        const access = { ...(patient.access || {}), [caregiverUid]: entry };
        const caregiverUids = [...new Set([...(patient.caregiverUids || []), caregiverUid])];
        tx.set(inviteRef, invite);
        tx.update(patientRef, { access, caregiverUids });
      });
    },
  };
}
