// NIH RxNav. Each request is a drug name or an NDC and nothing else.
// No API key and no billing. NLM asks callers to stay under 20 requests per second per IP address.
import { choiceFromConcept, choicesFromDrugGroup, parsePackageCode, rxnavConceptUrl, rxnavDrugsUrl, rxnavNdcUrl } from "./drug-catalog.js";

async function read(fetchImpl, url) {
  let res;
  try { res = await fetchImpl(url, { headers: { accept: "application/json" } }); }
  catch (e) { return { code: "offline" }; }
  if (res.status === 429) return { code: "limited" };
  if (res.status === 404) return { code: "not-found" };
  if (!res.ok) return { code: "unavailable" };
  try { return { code: "ok", json: await res.json() }; }
  catch (e) { return { code: "unavailable" }; }
}

export async function searchDrugNames(name, { fetchImpl = fetch, now = Date.now() } = {}) {
  const q = String(name || "").trim();
  if (q.length < 2) return { ok: false, code: "short", choices: [] };
  const got = await read(fetchImpl, rxnavDrugsUrl(q));
  if (got.code !== "ok") return { ok: false, code: got.code, choices: [] };
  const choices = choicesFromDrugGroup(got.json, new Date(now).toISOString());
  return { ok: true, code: choices.length ? "ok" : "not-found", choices };
}

export async function lookupPackageCode(raw, { fetchImpl = fetch, now = Date.now() } = {}) {
  const parsed = parsePackageCode(raw);
  if (parsed.status !== "candidates") {
    return { ok: parsed.status === "invite" || parsed.status === "unmapped", code: parsed.status, parsed, choices: [] };
  }
  const retrievedAt = new Date(now).toISOString();
  const concepts = new Map();
  const found = [];
  for (const id of parsed.ids) {
    const got = await read(fetchImpl, rxnavNdcUrl(id));
    if (got.code === "offline" || got.code === "limited" || got.code === "unavailable") return { ok: false, code: got.code, parsed, choices: [] };
    if (got.code !== "ok") continue;
    for (const row of got.json?.ndcPropertyList?.ndcProperty || []) {
      if (!row?.rxcui) continue;
      if (!concepts.has(row.rxcui)) {
        const info = await read(fetchImpl, rxnavConceptUrl(row.rxcui));
        if (info.code === "offline" || info.code === "limited" || info.code === "unavailable") return { ok: false, code: info.code, parsed, choices: [] };
        const p = info.json?.properties;
        if (info.code === "ok" && p?.rxcui && p?.name) concepts.set(row.rxcui, { rxcui: p.rxcui, name: p.name, tty: p.tty || "" });
      }
      const concept = concepts.get(row.rxcui);
      if (!concept || found.some(c => c.rxcui === concept.rxcui)) continue;
      found.push(choiceFromConcept(concept, { ndc: row.ndc10 || null, retrievedAt }));
    }
  }
  const choices = found.filter(c => c.tty === "SCD" || c.tty === "SBD");
  return { ok: true, code: choices.length ? (choices.length === 1 ? "one" : "ambiguous") : "not-found", parsed, choices };
}
