import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { register } from "../functions/index.js";

const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");

describe("firestore rules text", () => {
  it("clients cannot read or write invites or link codes", () => {
    expect(rules).toMatch(/match \/invites\/\{id\} \{\s*allow read, write: if false;/);
    expect(rules).toMatch(/match \/linkCodes\/\{code\} \{\s*allow read, write: if false;/);
    expect(rules).toMatch(/match \/inviteFailures\/\{uid\} \{\s*allow read, write: if false;/);
  });
  it("the access map and owner cannot be changed by a client update", () => {
    expect(rules).toContain("accessUnchanged()");
    expect(rules).toContain("request.resource.data.ownerUid == resource.data.ownerUid");
    expect(rules).toContain("request.resource.data.get('caregiverUids', []).size() == 0");
    expect(rules).not.toContain("arrayUnion");
  });
  it("a linked caregiver is not granted a client write", () => {
    expect(rules).toMatch(/function canWrite\(pid\) \{\s*return signedIn\(\) && parent\(pid\).ownerUid == request\.auth\.uid;\s*\}/);
  });
});

describe("functions entry", () => {
  it("refuses to register unless a deploy was requested on purpose", async () => {
    const previous = process.env.PILLBOX_FUNCTIONS_DEPLOY;
    delete process.env.PILLBOX_FUNCTIONS_DEPLOY;
    await expect(register()).rejects.toThrow(/Blaze/);
    if (previous) process.env.PILLBOX_FUNCTIONS_DEPLOY = previous;
  });
});
