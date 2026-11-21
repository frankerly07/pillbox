// Phone-only paths of native.js, with the Capacitor plugins replaced by fakes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = { write: [], share: [], cancel: [], schedule: [] };
let pending = [];
let shareError = null;

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE" }, Encoding: { UTF8: "utf8" },
  Filesystem: { writeFile: async o => { calls.write.push(o); return { uri: "file:///cache/" + o.path }; } },
}));
vi.mock("@capacitor/share", () => ({
  Share: { share: async o => { if (shareError) throw shareError; calls.share.push(o); } },
}));
vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    getPending: async () => ({ notifications: pending }),
    cancel: async o => { calls.cancel.push(o); },
    schedule: async o => { calls.schedule.push(o); },
  },
}));

const N = await import("./native.js");

beforeEach(() => {
  for (const k of Object.keys(calls)) calls[k] = [];
  pending = [];
  shareError = null;
});

describe("saveBackupFile on the phone", () => {
  it("writes the file to the cache and opens the share sheet (a web download link does nothing in the Android WebView)", async () => {
    const res = await N.saveBackupFile('{"pillboxBackup":1}', "pillbox-backup.json");
    expect(res).toEqual({ ok: true, method: "share" });
    expect(calls.write[0]).toMatchObject({ path: "pillbox-backup.json", data: '{"pillboxBackup":1}', directory: "CACHE" });
    expect(calls.share[0].files).toEqual(["file:///cache/pillbox-backup.json"]);
  });
  it("reports a cancelled share instead of saying the backup was saved", async () => {
    shareError = new Error("Share canceled");
    const res = await N.saveBackupFile("{}");
    expect(res.ok).toBe(false);
    expect(res.cancelled).toBe(true);
  });
});

describe("caregiver checks", () => {
  it("cancels only its own ids (5000–8999), not pending immediate alerts (9000+)", async () => {
    pending = [{ id: 1500 }, { id: 5000 }, { id: 8999 }, { id: 9001 }];
    await N.scheduleCaregiverChecks([], 60);
    expect(calls.cancel[0].notifications.map(n => n.id)).toEqual([5000, 8999]);
  });
  it("never hands out an id above 8999", async () => {
    // many people with an hourly medicine due later today
    const now = new Date();
    const later = new Date(now.getTime() + 2 * 3600000);
    if (later.getDate() !== now.getDate()) return; // too close to midnight for this check to mean anything
    const time = String(later.getHours()).padStart(2, "0") + ":" + String(later.getMinutes()).padStart(2, "0");
    const patients = Array.from({ length: 4100 }, (_, i) => ({ id: "p" + i, name: "P" + i, doses: {}, meds: [{ id: "m" + i, name: "M", times: [time], schedule: { kind: "daily" } }] }));
    await N.scheduleCaregiverChecks(patients, 60);
    const ids = calls.schedule[0].notifications.map(n => n.id);
    expect(Math.max(...ids)).toBe(8999);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
