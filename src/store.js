// Data layer. Both stores share an interface, so the screens don't care which one runs.
//   LocalStore: this phone only. No account and no real caregiver link.
//   CloudStore: Firebase Auth + Firestore. Invites and caregiver writes go through Cloud Functions,
//   which are not deployed in this build (they need Blaze billing). Owner writes use a transaction.
import { uid, dayKey, normalizeMed, normalizeEvent, anchorsToLastDose, doseAnchors, COLORS } from "./model.js";
import { commitAdministration } from "./dose-log.js";
import { planDoseCommit } from "./cloud-handlers.js";
import { buildBackup, emptyPatient, migrateLocalData, migrateCycleData, planImport } from "./migrate.js";
import { firebaseConfig } from "./firebase-config.js";
import { t } from "./i18n.js";

const listeners = () => new Set();
const LKEY = "pillbox.v2";
/** Where unreadable saved data is copied before anything new is written over it. */
export const RESCUE_KEY = LKEY + ".unreadable";
/** A copy of this phone's records taken just before a backup file is imported. */
export const PRE_IMPORT_KEY = LKEY + ".before-import";

/** JSON from storage, or `fallback` when it is missing, unreadable, or storage is not available. Never throws. */
export function readJson(key, fallback = null, storage = globalThis.localStorage) {
  try {
    const text = storage?.getItem(key);
    if (text == null) return fallback;
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch (e) { return fallback; }
}
// Messages people can see, in the current language.
const NOT_DEPLOYED = () => t("err.notDeployed");
const NEEDS_SYNC = () => t("err.needsSync");

/** Example medicines for a new phone, worded in the current language. */
export function sampleMeds(start = dayKey(new Date())) {
  return [
    { id: uid(), name: t("sample.vitD"), strength: t("sample.iu"), perDose: t("sample.softgel"), times: ["08:00"], stock: 42, fullCount: 90, refillAt: 10, slot: 1, color: COLORS[0], notes: t("sample.withBreakfast") },
    { id: uid(), name: "Metformin", strength: "500 mg", perDose: t("sample.tablet"), times: ["08:00", "20:00"], stock: 9, fullCount: 60, refillAt: 10, slot: 2, prescribedBy: t("sample.doctor"), color: COLORS[1], notes: t("sample.withFood") },
    { id: uid(), name: "Ibuprofen", strength: "200 mg", perDose: t("sample.tablet"), times: [], stock: 30, fullCount: 50, refillAt: 6, slot: 3, color: COLORS[2], notes: t("sample.prnMax") },
    { id: uid(), name: t("sample.vitB12"), type: "injection", strength: "1000 mcg/mL", doseAmount: 1, doseUnit: "mL", supplyUnit: "vials", times: ["09:00"], schedule: { kind: "everyNWeeks", n: 2 }, stock: 3, fullCount: 5, refillAt: 1, refillDays: 14, color: COLORS[3], notes: t("sample.shotSites") },
  ].map(m => normalizeMed({ ...m, start }));
}
function defined(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));
}

export function syncStatus(store) {
  if (store && store.mode === "cloud") {
    return {
      mode: "cloud",
      title: "Signed in",
      detail: "A code from this account can connect another signed-in phone only after the invite function is deployed. That deploy needs Firebase Blaze (billing), which is not turned on here. Until then, linking does not succeed.",
    };
  }
  return {
    mode: "phone",
    title: "On this phone only",
    detail: "Sync is not set up. Records stay on this phone. A code created here would not connect another phone, so PillAlly does not create one. This is not shared access.",
  };
}

export class LocalStore {
  constructor(opts = {}) {
    this.mode = "local";
    this.legacyCarePackage = !!opts.legacyCarePackage;
    this.subs = new Map();
    this.listSubs = listeners();
    this.onSaveError = null;
    let raw = null, text = null;
    try { text = localStorage.getItem(LKEY); } catch (e) {}
    try { raw = JSON.parse(text); } catch (e) { raw = null; }
    const data = migrateLocalData(raw, { legacyCarePackage: this.legacyCarePackage });
    // Saved text that can't be read as records is kept under another key, so starting over
    // (and the first save after it) never destroys the only copy.
    if (text != null && text !== "null" && data.fresh) {
      try { if (localStorage.getItem(RESCUE_KEY) == null) localStorage.setItem(RESCUE_KEY, text); } catch (e) {}
    }
    this.data = data;
    this.user = { uid: "local", name: "Me" };
    if (raw) this.persist();
  }
  get profile() { return this.data.profile || null; }
  get suggested() { return this.data.suggested; }
  get example() { return !!this.data.example; }
  /** Save to this phone. Returns false (and calls onSaveError) when the phone refuses, for example when storage is full. */
  persist() {
    const { suggested, fresh, ...rest } = this.data;
    try { localStorage.setItem(LKEY, JSON.stringify(rest)); return true; }
    catch (e) {
      try { this.onSaveError?.(e); } catch (err) {}
      return false;
    }
  }
  emit(pid) {
    const p = this.data.patients[pid];
    const s = this.subs.get(pid);
    if (s && p) for (const cb of s) cb(structuredClone(p));
    const list = this.patientList();
    for (const cb of this.listSubs) cb(list);
    this.persist();
  }
  emitAll() {
    for (const id of Object.keys(this.data.patients)) {
      const s = this.subs.get(id);
      const p = this.data.patients[id];
      if (s && p) for (const cb of s) cb(structuredClone(p));
    }
    const list = this.patientList();
    for (const cb of this.listSubs) cb(list);
    this.persist();
  }
  patientList() {
    return Object.values(this.data.patients).map(p => ({
      id: p.id, name: p.name, localOnly: true,
      example: !!(p.example || (this.data.example && String(p.name || "").startsWith("Example:"))),
    }));
  }
  applyProfile(profile) {
    const recommended = profile.recommended === "yes" || profile.recommended === "no" || profile.recommended === "skip" ? profile.recommended : null;
    let usePatient = !!profile.usePatient, useCaregiver = !!profile.useCaregiver;
    if (!usePatient && !useCaregiver) usePatient = true;
    this.data.profile = { usePatient, useCaregiver, recommended, onboarded: true };
    this.data.suggested = this.data.profile;
    if (usePatient && !this.data.patients.me) {
      const seedExamples = !!this.data.fresh && Object.keys(this.data.patients).length === 0;
      this.data.patients.me = { ...emptyPatient("me", "Me"), meds: seedExamples ? sampleMeds() : [], localOnly: true };
      if (seedExamples) this.data.example = true;
    }
    this.data.fresh = false;
    this.data.role = this.legacyCarePackage ? "caregiver" : "patient";
    this.emitAll();
    return this.data.profile;
  }
  clearExamples() {
    if (this.data.patients.me && this.data.example) {
      this.data.patients.me.meds = [];
      this.data.patients.me.doses = {};
      this.data.patients.me.events = {};
      this.data.patients.me.stockLog = [];
    }
    for (const [id, p] of Object.entries(this.data.patients)) {
      if (id === "me") continue;
      if (p.example || String(p.name || "").startsWith("Example:")) delete this.data.patients[id];
    }
    this.data.example = false;
    this.emitAll();
  }
  exportBackup() { return buildBackup(this.data.patients); }
  importBackup(backup) {
    const into = this.data.patients.me ? "me" : null; // planImport fills it only when it has nothing in it
    const plan = planImport(this.data.patients, backup, { intoEmptyId: into });
    if (!plan.ok) return plan;
    // Keep what was here right before the import, so a wrong file can be undone by hand.
    try {
      const { suggested, fresh, ...rest } = this.data;
      localStorage.setItem(PRE_IMPORT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data: rest }));
    } catch (e) {}
    this.data.patients = plan.patients;
    this.data.example = false;
    this.data.fresh = false;
    this.emitAll();
    return plan;
  }
  async init() { return this.user; }
  onAuth(cb) { cb(this.user); return () => {}; }
  listPatients(cb) { this.listSubs.add(cb); cb(this.patientList()); return () => this.listSubs.delete(cb); }
  watchPatient(pid, cb) {
    if (!this.subs.has(pid)) this.subs.set(pid, listeners());
    this.subs.get(pid).add(cb);
    const p = this.data.patients[pid];
    if (p) cb(structuredClone(p));
    return () => this.subs.get(pid).delete(cb);
  }
  async saveMed(pid, med) {
    const p = this.data.patients[pid];
    if (!p) return;
    med = normalizeMed(med);
    const i = p.meds.findIndex(m => m.id === med.id);
    if (i >= 0) p.meds[i] = med; else p.meds.push(med);
    this.data.example = false;
    this.emit(pid);
  }
  async deleteMed(pid, medId) {
    const p = this.data.patients[pid];
    if (!p) return;
    p.meds = p.meds.filter(m => m.id !== medId);
    this.emit(pid);
  }
  async setDose(pid, key, dose) { this.data.patients[pid].doses[key] = dose; this.emit(pid); }
  async clearDose(pid, key) { delete this.data.patients[pid].doses[key]; this.emit(pid); }
  async commitDose(pid, cmd) {
    const p = this.data.patients[pid];
    if (!p) return { ok: false, code: "not-found", message: t("commit.not-found"), delta: 0 };
    const result = commitAdministration(p, cmd, cmd.now || Date.now());
    if (result.code === "applied") {
      this.data.patients[pid] = result.patient;
      this.emit(pid);
    }
    return {
      ok: result.ok, code: result.code, message: result.message, delta: result.delta || 0,
      key: result.key || result.removedKey || cmd.key || null, at: result.at || result.dose?.at || null, dose: result.dose || null,
    };
  }
  async saveEvent(pid, ev) {
    ev = normalizeEvent(ev);
    const p = this.data.patients[pid];
    if (!p) return;
    (p.events = p.events || {})[ev.id] = ev;
    this.emit(pid);
  }
  async deleteEvent(pid, id) {
    const p = this.data.patients[pid];
    if (p?.events) delete p.events[id];
    this.emit(pid);
  }
  async adjustStock(pid, medId, delta, ev = {}) {
    const p = this.data.patients[pid], m = p?.meds.find(x => x.id === medId);
    if (!m || typeof m.stock !== "number" || !Number.isFinite(m.stock)) return;
    if (!Number.isFinite(Number(delta))) return; // never turn a count into NaN
    delta = Number(delta);
    if (ev.opId && (p.appliedOps || []).includes(ev.opId)) return;
    m.stock = Math.round((m.stock + delta) * 1e6) / 1e6;
    (p.stockLog = p.stockLog || []).push({ id: ev.opId || uid(), medId, delta, after: m.stock, at: new Date().toISOString(), ...ev });
    p.stockLog = p.stockLog.slice(-500);
    if (ev.opId) {
      p.appliedOps = p.appliedOps || [];
      p.appliedOps.push(ev.opId);
    }
    this.emit(pid);
  }
  async createInvite() { throw new Error(t("sync.phone.detail")); }
  async previewInvite() { throw new Error(t("sync.phone.detail")); }
  async acceptInvite() { throw new Error(t("sync.phone.detail")); }
  async createLinkCode() { return this.createInvite(); }
  async joinWithCode() { return this.acceptInvite(); }
  async removeCaregiver(pid, cuid) {
    const p = this.data.patients[pid];
    if (!p) return;
    p.caregivers = (p.caregivers || []).filter(id => id !== cuid);
    p.caregiverUids = (p.caregiverUids || []).filter(id => id !== cuid);
    if (p.access) delete p.access[cuid];
    this.emit(pid);
  }
  async signOut() {}
  async signUp() { throw new Error(NEEDS_SYNC()); }
  async signIn() { throw new Error(NEEDS_SYNC()); }
  async resetPassword() { throw new Error(NEEDS_SYNC()); }
}

function notDeployed(err) {
  const code = String(err && err.code || "");
  if (code.includes("not-found") || code.includes("unavailable") || code.includes("internal") || code.includes("functions/")) return new Error(NOT_DEPLOYED());
  return err;
}

export class CloudStore {
  constructor() { this.mode = "cloud"; this.user = null; this.example = false; this.profile = null; this.legacyCarePackage = false; }
  async init() {
    const { initializeApp } = await import("firebase/app");
    const A = await import("firebase/auth");
    const F = await import("firebase/firestore");
    this.A = A; this.F = F;
    this.app = initializeApp(firebaseConfig);
    this.auth = A.initializeAuth(this.app, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence] });
    this.db = F.initializeFirestore(this.app, { localCache: F.persistentLocalCache() });
    await new Promise(res => { const u = A.onAuthStateChanged(this.auth, async fbUser => { u(); await this.loadUser(fbUser); res(); }); });
    return this.user;
  }
  async loadUser(fbUser) {
    if (!fbUser) { this.user = null; return; }
    const { doc, getDoc } = this.F;
    const snap = await getDoc(doc(this.db, "users", fbUser.uid)).catch(() => null);
    const prof = snap && snap.exists() ? snap.data() : {};
    // usePatient / useCaregiver are labels for the signed-in person. Rules do not read them.
    this.user = { uid: fbUser.uid, email: fbUser.email, name: prof.name || fbUser.displayName || fbUser.email, usePatient: !!prof.usePatient, useCaregiver: !!prof.useCaregiver };
  }
  onAuth(cb) { return this.A.onAuthStateChanged(this.auth, async u => { await this.loadUser(u); cb(this.user); }); }
  async signUp({ email, password, name, usePatient, useCaregiver }) {
    const { createUserWithEmailAndPassword, updateProfile } = this.A;
    const { doc, setDoc } = this.F;
    const cred = await createUserWithEmailAndPassword(this.auth, email, password);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(this.db, "users", cred.user.uid), { name, usePatient: !!usePatient, useCaregiver: !!useCaregiver, createdAt: Date.now() });
    if (usePatient) {
      await setDoc(doc(this.db, "patients", cred.user.uid), { name, ownerUid: cred.user.uid, caregivers: [], caregiverUids: [], access: {}, createdAt: Date.now() });
    }
    await this.loadUser(cred.user);
    return this.user;
  }
  async signIn({ email, password }) { const c = await this.A.signInWithEmailAndPassword(this.auth, email, password); await this.loadUser(c.user); return this.user; }
  async resetPassword(email) { await this.A.sendPasswordResetEmail(this.auth, email); }
  async signOut() { await this.A.signOut(this.auth); }

  async callFn(name, data) {
    const { getFunctions, httpsCallable } = await import("firebase/functions");
    try {
      const res = await httpsCallable(getFunctions(this.app), name)(data);
      return res.data;
    } catch (err) { throw notDeployed(err); }
  }

  listPatients(cb) {
    const { collection, query, where, onSnapshot, doc } = this.F;
    let own = [], linked = [];
    const emit = () => {
      const map = new Map();
      for (const p of [...own, ...linked]) if (p.id !== this.user.uid || p.owner) map.set(p.id, p);
      cb([...map.values()]);
    };
    const unsubs = [
      onSnapshot(doc(this.db, "patients", this.user.uid), s => { own = s.exists() ? [{ id: s.id, name: s.data().name, owner: true }] : []; emit(); }),
      onSnapshot(query(collection(this.db, "patients"), where("caregiverUids", "array-contains", this.user.uid)), s => {
        linked = s.docs.filter(d => d.id !== this.user.uid).map(d => ({ id: d.id, name: d.data().name, linked: true }));
        emit();
      }, () => { linked = []; emit(); }),
    ];
    return () => unsubs.forEach(u => u());
  }
  watchPatient(pid, cb) {
    const { doc, collection, query, where, orderBy, startAfter, limit, getDocs, onSnapshot } = this.F;
    const state = { id: pid, name: "", meds: [], doses: {}, events: {}, stockLog: [], caregivers: [], caregiverNames: {}, access: {}, caregiverUids: [] };
    const got = new Set();
    const push = k => { got.add(k); if (got.has("p") && got.has("m") && got.has("d")) cb(structuredClone(state)); };
    const since = new Date(); since.setDate(since.getDate() - 120);
    const doses = collection(this.db, "patients", pid, "doses");
    let recent = null, old = {}, cursor = null, done = false, chain = Promise.resolve();
    const missing = () => recent && !done && state.meds.some(m => anchorsToLastDose(m) && !doseAnchors(m, state.doses).length);
    const sync = k => (chain = chain.then(async () => {
      state.doses = { ...old, ...recent };
      try {
        while (missing()) {
          const s = await getDocs(query(doses, where("day", "<", dayKey(since)), orderBy("day", "desc"), ...(cursor ? [startAfter(cursor)] : []), limit(200)));
          for (const d of s.docs) old[d.id] = d.data();
          if (s.docs.length) cursor = s.docs[s.docs.length - 1];
          if (s.docs.length < 200) done = true;
          state.doses = { ...old, ...recent };
        }
      } catch (e) {}
      push(k);
    }));
    const unsubs = [
      onSnapshot(doc(this.db, "patients", pid), s => { Object.assign(state, s.data() || {}); state.id = pid; push("p"); }),
      onSnapshot(collection(this.db, "patients", pid, "meds"), s => { state.meds = s.docs.map(d => normalizeMed({ ...d.data(), id: d.id })); sync("m"); }),
      onSnapshot(query(doses, where("day", ">=", dayKey(since))), s => { recent = Object.fromEntries(s.docs.map(d => [d.id, d.data()])); sync("d"); }),
      onSnapshot(query(collection(this.db, "patients", pid, "events"), where("day", ">=", dayKey(since))), s => { state.events = Object.fromEntries(s.docs.map(d => [d.id, normalizeEvent({ ...d.data(), id: d.id })])); push("e"); }),
      onSnapshot(query(collection(this.db, "patients", pid, "stock"), where("at", ">=", since.toISOString())), s => { state.stockLog = s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => a.at.localeCompare(b.at)); push("s"); }),
    ];
    return () => unsubs.forEach(u => u());
  }
  ownerGuard(pid) {
    if (pid !== this.user.uid) throw new Error(t("err.ownerOnly") + " " + NOT_DEPLOYED());
  }
  async saveMed(pid, med) {
    this.ownerGuard(pid);
    const { doc, setDoc } = this.F;
    const { id, ...rest } = normalizeMed(med);
    await setDoc(doc(this.db, "patients", pid, "meds", id), { ...rest, updatedAt: Date.now(), updatedBy: this.user.uid });
  }
  async deleteMed(pid, medId) { this.ownerGuard(pid); const { doc, deleteDoc } = this.F; await deleteDoc(doc(this.db, "patients", pid, "meds", medId)); }
  async setDose(pid, key, dose) { this.ownerGuard(pid); const { doc, setDoc } = this.F; await setDoc(doc(this.db, "patients", pid, "doses", key), dose); }
  async clearDose(pid, key) { this.ownerGuard(pid); const { doc, deleteDoc } = this.F; await deleteDoc(doc(this.db, "patients", pid, "doses", key)); }
  async commitDose(pid, cmd) {
    if (pid !== this.user.uid) return this.callFn("commitDose", { pid, cmd });
    const { doc, runTransaction } = this.F;
    return runTransaction(this.db, async (tx) => {
      const parentRef = doc(this.db, "patients", pid);
      const parentSnap = await tx.get(parentRef);
      const parent = parentSnap.exists() ? { id: pid, ...parentSnap.data() } : { id: pid, ownerUid: pid };
      const medRef = doc(this.db, "patients", pid, "meds", cmd.medId);
      const medSnap = await tx.get(medRef);
      const opRef = doc(this.db, "patients", pid, "ops", cmd.opId);
      const opSnap = await tx.get(opRef);
      let dose = null;
      if (cmd.key && !cmd.extra) {
        const doseSnap = await tx.get(doc(this.db, "patients", pid, "doses", cmd.key));
        if (doseSnap.exists()) dose = doseSnap.data();
      }
      const plan = planDoseCommit({
        parent, med: medSnap.exists() ? { ...medSnap.data(), id: cmd.medId } : null, dose, opExists: opSnap.exists(),
      }, cmd, cmd.now || Date.now());
      if (plan.result.code !== "applied") return plan.result;
      if (plan.medStock != null) tx.update(medRef, { stock: plan.medStock });
      if (plan.dose && plan.doseKey) tx.set(doc(this.db, "patients", pid, "doses", plan.doseKey), defined(plan.dose));
      if (plan.deleteDose) tx.delete(doc(this.db, "patients", pid, "doses", plan.deleteDose));
      if (plan.stockEntry) tx.set(doc(this.db, "patients", pid, "stock", cmd.opId), defined(plan.stockEntry));
      if (plan.audit) tx.set(doc(this.db, "patients", pid, "doseAudit", cmd.opId), defined(plan.audit));
      tx.set(opRef, { opId: cmd.opId, at: Date.now() });
      return plan.result;
    });
  }
  async saveEvent(pid, ev) { this.ownerGuard(pid); const { doc, setDoc } = this.F; const { id, ...rest } = normalizeEvent(ev); await setDoc(doc(this.db, "patients", pid, "events", id), { ...rest, updatedBy: this.user.uid }); }
  async deleteEvent(pid, id) { this.ownerGuard(pid); const { doc, deleteDoc } = this.F; await deleteDoc(doc(this.db, "patients", pid, "events", id)); }
  async adjustStock(pid, medId, delta, ev = {}) {
    this.ownerGuard(pid);
    const { doc, collection, writeBatch, increment } = this.F;
    const b = writeBatch(this.db);
    b.update(doc(this.db, "patients", pid, "meds", medId), { stock: increment(delta) });
    b.set(doc(collection(this.db, "patients", pid, "stock")), { medId, delta, at: new Date().toISOString(), ...ev });
    await b.commit();
  }
  async createInvite(pid, permission) { return this.callFn("createInvite", { patientId: pid, permission, patientName: this.user.name }); }
  async previewInvite(codeText) { return this.callFn("previewInvite", { codeText }); }
  async acceptInvite(codeText) { return this.callFn("acceptInvite", { codeText, caregiverName: this.user.name }); }
  async createLinkCode() { throw new Error(NOT_DEPLOYED()); }
  async joinWithCode() { throw new Error(NOT_DEPLOYED()); }
  async removeCaregiver(pid, cuid) { return this.callFn("revokeCaregiver", { pid, caregiverUid: cuid }); }
  exportBackup() { return null; }
  importBackup() { return { ok: false, message: t("err.importLocalOnly") }; }
}

// Period log: its own key on this phone, in both local and cloud mode. CloudStore never reads it and
// LocalStore keeps it out of patient records, so caregivers, sync and backup files don't see it.
export const CYCLE_KEY = "pillbox.cycle";
export function loadCycle(storage = globalThis.localStorage) {
  let raw = null;
  try { raw = JSON.parse(storage?.getItem(CYCLE_KEY) || "null"); } catch (e) { raw = null; }
  return migrateCycleData(raw);
}
export function saveCycle(data, storage = globalThis.localStorage) {
  const clean = migrateCycleData(data);
  try { storage?.setItem(CYCLE_KEY, JSON.stringify(clean)); } catch (e) {}
  return clean;
}

export function makeStore(opts = {}) {
  return firebaseConfig && firebaseConfig.apiKey ? new CloudStore() : new LocalStore(opts);
}
