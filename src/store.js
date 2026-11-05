// Data layer. Both stores have the same interface, so the UI doesn't care which one runs.
//   LocalStore: everything on this phone (no account, no caregiver sync). Used until Firebase is set up.
//   CloudStore: Firebase Auth + Firestore, shared between the patient's and caregivers' phones.
import { uid, dayKey, doseKey, COLORS } from "./model.js";
import { firebaseConfig } from "./firebase-config.js";

const listeners = () => new Set();

// ---------------- Local ----------------
const LKEY = "pillbox.v2";
function sampleMeds(start = dayKey(new Date())) {
  return [
    { id: uid(), name: "Vitamin D3", strength: "1000 IU", perDose: "1 softgel", times: ["08:00"], stock: 42, fullCount: 90, refillAt: 10, slot: 1, color: COLORS[0], notes: "With breakfast" },
    { id: uid(), name: "Metformin", strength: "500 mg", perDose: "1 tablet", times: ["08:00", "20:00"], stock: 9, fullCount: 60, refillAt: 10, slot: 2, prescribedBy: "Dr. Patel (example)", color: COLORS[1], notes: "Take with food" },
    { id: uid(), name: "Ibuprofen", strength: "200 mg", perDose: "1 tablet", times: [], stock: 30, fullCount: 50, refillAt: 6, slot: 3, color: COLORS[2], notes: "As needed, max 3 per day" },
  ].map(m => ({ ...m, start }));
}
// Two weeks of mostly-taken history so the calendar has something to show.
function sampleHistory(meds, missRate) {
  const doses = {}, now = new Date();
  for (let i = 1; i <= 20; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const day = dayKey(d);
    for (const m of meds) for (const t of m.times) {
      if (Math.random() < missRate) continue;
      const [h, mi] = t.split(":").map(Number);
      const taken = new Date(d); taken.setHours(h, mi + Math.floor(Math.random() * 25), 0, 0);
      doses[doseKey(m.id, day, t)] = { medId: m.id, day, time: t, status: "taken", at: taken.toISOString(), source: "app", by: "patient" };
    }
  }
  return doses;
}

export class LocalStore {
  constructor(role) {
    this.mode = "local"; this.role = role; this.subs = new Map(); this.listSubs = listeners();
    let data = null;
    try { data = JSON.parse(localStorage.getItem(LKEY)); } catch (e) {}
    if (!data || data.role !== role) data = this.seed(role);
    this.data = data;
    this.user = { uid: "local", name: role === "caregiver" ? "You" : "Me", role };
  }
  seed(role) {
    if (role === "patient") {
      return { role, example: true, patients: { me: { id: "me", name: "Me", meds: sampleMeds(), doses: {}, stockLog: [], caregivers: [] } } };
    }
    const ago = new Date(); ago.setDate(ago.getDate() - 20); const st = dayKey(ago);
    const a = sampleMeds(st).slice(0, 2), b = [{ id: uid(), name: "Lisinopril", strength: "10 mg", perDose: "1 tablet", times: ["09:00"], stock: 4, refillAt: 7, color: COLORS[3] }, { id: uid(), name: "Atorvastatin", strength: "20 mg", perDose: "1 tablet", times: ["21:00"], stock: 25, refillAt: 7, color: COLORS[4] }].map(m => ({ ...m, start: st }));
    return {
      role, example: true, patients: {
        p1: { id: "p1", name: "Example: Maria", meds: a, doses: sampleHistory(a, 0.08), caregivers: ["local"],
          stockLog: [{ id: uid(), medId: a[1].id, delta: 60, after: 60, reason: "refill", note: "Rx renewed", by: "caregiver", byName: "Dr. Patel (example)", at: new Date(Date.now() - 18 * 86400000).toISOString() }] },
        p2: { id: "p2", name: "Example: Joe", meds: b, doses: sampleHistory(b, 0.25), caregivers: ["local"] },
      }
    };
  }
  persist() { try { localStorage.setItem(LKEY, JSON.stringify(this.data)); } catch (e) {} }
  emit(pid) {
    const p = this.data.patients[pid]; const s = this.subs.get(pid);
    if (s && p) for (const cb of s) cb(structuredClone(p));
    const list = this.patientList(); for (const cb of this.listSubs) cb(list);
    this.persist();
  }
  patientList() { return Object.values(this.data.patients).map(p => ({ id: p.id, name: p.name })); }
  get example() { return !!this.data.example; }
  clearExamples() { this.data = this.role === "patient" ? { role: "patient", example: false, patients: { me: { id: "me", name: "Me", meds: [], doses: {}, caregivers: [] } } } : { role: "caregiver", example: false, patients: {} }; this.persist(); for (const id of this.subs.keys()) this.emit(id); for (const cb of this.listSubs) cb(this.patientList()); }
  async init() { return this.user; }
  onAuth(cb) { cb(this.user); return () => {}; }
  listPatients(cb) { this.listSubs.add(cb); cb(this.patientList()); return () => this.listSubs.delete(cb); }
  watchPatient(pid, cb) {
    if (!this.subs.has(pid)) this.subs.set(pid, listeners());
    this.subs.get(pid).add(cb);
    const p = this.data.patients[pid]; if (p) cb(structuredClone(p));
    return () => this.subs.get(pid).delete(cb);
  }
  async saveMed(pid, med) { const p = this.data.patients[pid]; const i = p.meds.findIndex(m => m.id === med.id); if (i >= 0) p.meds[i] = med; else p.meds.push(med); this.data.example = false; this.emit(pid); }
  async deleteMed(pid, medId) { const p = this.data.patients[pid]; p.meds = p.meds.filter(m => m.id !== medId); this.emit(pid); }
  async setDose(pid, key, dose) { this.data.patients[pid].doses[key] = dose; this.emit(pid); }
  async clearDose(pid, key) { delete this.data.patients[pid].doses[key]; this.emit(pid); }
  async adjustStock(pid, medId, delta, ev = {}) {
    const p = this.data.patients[pid], m = p.meds.find(x => x.id === medId);
    if (!m || typeof m.stock !== "number") return;
    m.stock = Math.max(0, m.stock + delta);
    (p.stockLog = p.stockLog || []).push({ id: uid(), medId, delta, after: m.stock, at: new Date().toISOString(), ...ev });
    p.stockLog = p.stockLog.slice(-500);
    this.emit(pid);
  }
  async createLinkCode() { throw new Error("Linking a caregiver needs sync, which isn't set up yet."); }
  async joinWithCode() { throw new Error("Linking a patient needs sync, which isn't set up yet."); }
  async removeCaregiver() {}
  async signOut() {}
}

// ---------------- Cloud (Firebase) ----------------
export class CloudStore {
  constructor(role) { this.mode = "cloud"; this.role = role; this.user = null; this.example = false; }
  async init() {
    const { initializeApp } = await import("firebase/app");
    const A = await import("firebase/auth");
    const F = await import("firebase/firestore");
    this.A = A; this.F = F;
    const app = initializeApp(firebaseConfig);
    // initializeAuth (not getAuth) because the default popup resolver hangs inside the Android WebView.
    this.auth = A.initializeAuth(app, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence] });
    this.db = F.initializeFirestore(app, { localCache: F.persistentLocalCache() });
    await new Promise(res => { const u = A.onAuthStateChanged(this.auth, async fbUser => { u(); await this.loadUser(fbUser); res(); }); });
    return this.user;
  }
  async loadUser(fbUser) {
    if (!fbUser) { this.user = null; return; }
    const { doc, getDoc } = this.F;
    const snap = await getDoc(doc(this.db, "users", fbUser.uid)).catch(() => null);
    const prof = snap && snap.exists() ? snap.data() : {};
    this.user = { uid: fbUser.uid, email: fbUser.email, name: prof.name || fbUser.displayName || fbUser.email, role: this.role };
  }
  onAuth(cb) { return this.A.onAuthStateChanged(this.auth, async u => { await this.loadUser(u); cb(this.user); }); }
  async signUp({ email, password, name }) {
    const { createUserWithEmailAndPassword, updateProfile } = this.A;
    const { doc, setDoc } = this.F;
    const cred = await createUserWithEmailAndPassword(this.auth, email, password);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(this.db, "users", cred.user.uid), { name, role: this.role, createdAt: Date.now() });
    if (this.role === "patient") {
      await setDoc(doc(this.db, "patients", cred.user.uid), { name, ownerUid: cred.user.uid, caregivers: [], caregiverNames: {}, createdAt: Date.now() });
    }
    await this.loadUser(cred.user);
    return this.user;
  }
  async signIn({ email, password }) { const c = await this.A.signInWithEmailAndPassword(this.auth, email, password); await this.loadUser(c.user); return this.user; }
  async resetPassword(email) { await this.A.sendPasswordResetEmail(this.auth, email); }
  async signOut() { await this.A.signOut(this.auth); }

  listPatients(cb) {
    const { collection, query, where, onSnapshot, doc } = this.F;
    if (this.role === "patient") {
      return onSnapshot(doc(this.db, "patients", this.user.uid), s => cb(s.exists() ? [{ id: s.id, name: s.data().name }] : []));
    }
    const q = query(collection(this.db, "patients"), where("caregivers", "array-contains", this.user.uid));
    return onSnapshot(q, s => cb(s.docs.map(d => ({ id: d.id, name: d.data().name }))));
  }
  watchPatient(pid, cb) {
    const { doc, collection, query, where, onSnapshot } = this.F;
    const state = { id: pid, name: "", meds: [], doses: {}, stockLog: [], caregivers: [], caregiverNames: {} };
    const got = new Set(); const push = k => { got.add(k); if (got.has("p") && got.has("m") && got.has("d")) cb(structuredClone(state)); };
    const since = new Date(); since.setDate(since.getDate() - 120);
    const unsubs = [
      onSnapshot(doc(this.db, "patients", pid), s => { Object.assign(state, s.data() || {}); state.id = pid; push("p"); }),
      onSnapshot(collection(this.db, "patients", pid, "meds"), s => { state.meds = s.docs.map(d => ({ ...d.data(), id: d.id })); push("m"); }),
      onSnapshot(query(collection(this.db, "patients", pid, "doses"), where("day", ">=", dayKey(since))), s => { state.doses = Object.fromEntries(s.docs.map(d => [d.id, d.data()])); push("d"); }),
      onSnapshot(query(collection(this.db, "patients", pid, "stock"), where("at", ">=", since.toISOString())), s => { state.stockLog = s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => a.at.localeCompare(b.at)); push("s"); }),
    ];
    return () => unsubs.forEach(u => u());
  }
  async saveMed(pid, med) { const { doc, setDoc } = this.F; const { id, ...rest } = med; await setDoc(doc(this.db, "patients", pid, "meds", id), { ...rest, updatedAt: Date.now(), updatedBy: this.user.uid }); }
  async deleteMed(pid, medId) { const { doc, deleteDoc } = this.F; await deleteDoc(doc(this.db, "patients", pid, "meds", medId)); }
  async setDose(pid, key, dose) { const { doc, setDoc } = this.F; await setDoc(doc(this.db, "patients", pid, "doses", key), dose); }
  async clearDose(pid, key) { const { doc, deleteDoc } = this.F; await deleteDoc(doc(this.db, "patients", pid, "doses", key)); }
  async adjustStock(pid, medId, delta, ev = {}) {
    const { doc, collection, writeBatch, increment } = this.F;
    const b = writeBatch(this.db);
    b.update(doc(this.db, "patients", pid, "meds", medId), { stock: increment(delta) });
    b.set(doc(collection(this.db, "patients", pid, "stock")), { medId, delta, at: new Date().toISOString(), ...ev });
    await b.commit(); // let failures reach the caller, which undoes the matching dose change and tells the user
  }

  // Patient makes a 6-digit code (valid 24 h). Caregiver types it in to link.
  async createLinkCode(pid) {
    const { doc, setDoc, updateDoc } = this.F;
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = Date.now() + 24 * 3600000;
    await setDoc(doc(this.db, "linkCodes", code), { patientId: pid, expires });
    await updateDoc(doc(this.db, "patients", pid), { linkCode: code, linkCodeExpires: expires });
    return { code, expires };
  }
  async joinWithCode(code) {
    const { doc, getDoc, updateDoc, arrayUnion } = this.F;
    const s = await getDoc(doc(this.db, "linkCodes", code));
    if (!s.exists() || s.data().expires < Date.now()) throw new Error("That code isn't valid or has expired. Ask for a new one.");
    const pid = s.data().patientId;
    await updateDoc(doc(this.db, "patients", pid), { caregivers: arrayUnion(this.user.uid), ["caregiverNames." + this.user.uid]: this.user.name, joinCode: code });
    return pid;
  }
  async removeCaregiver(pid, cuid) {
    const { doc, updateDoc, arrayRemove, deleteField } = this.F;
    await updateDoc(doc(this.db, "patients", pid), { caregivers: arrayRemove(cuid), ["caregiverNames." + cuid]: deleteField() });
  }
}

export function makeStore(role) {
  return firebaseConfig && firebaseConfig.apiKey ? new CloudStore(role) : new LocalStore(role);
}
