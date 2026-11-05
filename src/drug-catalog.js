// Package codes and RxNorm records. Nothing here chooses a dose, a schedule, or a unit conversion.
// A barcode match is only a candidate until a catalog lookup confirms it and the person accepts it.

const INVITE = /pillbox:invite:v1:/i;
const STRENGTH = /\d+(?:\.\d+)?\s*(?:MG|MCG|G|ML|L|UNT|MEQ|IU|%)(?:\s*\/\s*(?:\d+(?:\.\d+)?\s*)?(?:MG|MCG|G|ML|L|UNT|MEQ|IU|%))*/gi;

export const CATALOG_NOTICE = "Search sends only the name or package code you enter to the NIH RxNav service (rxnav.nlm.nih.gov). It does not send your name, your doses, or a photo.";

/** GS1 check digit for the digits before the check digit. Weights 3,1,3,1… from the right. */
export function gs1CheckDigit(body) {
  const digits = String(body || "");
  if (!/^\d+$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[digits.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}
export function gs1Valid(full) {
  const s = String(full || "");
  if (!/^\d{8,14}$/.test(s)) return false;
  return gs1CheckDigit(s.slice(0, -1)) === Number(s.slice(-1));
}

/** Three legal hyphenations of a 10-digit FDA NDC. The digits alone do not say which one. */
export function ndcHyphenations(ndc10) {
  const d = String(ndc10 || "");
  if (!/^\d{10}$/.test(d)) return [];
  return [
    d.slice(0, 4) + "-" + d.slice(4, 8) + "-" + d.slice(8),
    d.slice(0, 5) + "-" + d.slice(5, 8) + "-" + d.slice(8),
    d.slice(0, 5) + "-" + d.slice(5, 9) + "-" + d.slice(9),
  ];
}

function ndc10FromGtin12(gtin) {
  if (!gs1Valid(gtin) || gtin.length !== 12 || gtin[0] !== "3") return null;
  return gtin.slice(1, 11);
}
function ndc10FromGtin14(gtin) {
  // Indicator + "03" + 10-digit NDC + check, the GS1 US pattern for an NDC embedded in a GTIN.
  // A GTIN that does not use this pattern is not treated as an NDC.
  if (!gs1Valid(gtin) || gtin.length !== 14 || gtin[1] !== "0" || gtin[2] !== "3") return null;
  return gtin.slice(3, 13);
}

function cleanRaw(raw) {
  return String(raw || "").trim().replace(/^\][A-Za-z]\d/, "").replace(/\u001d/g, "");
}

/**
 * What a scanned or typed package code might be.
 * status: invite | candidates | unmapped | invalid
 * ids: strings safe to send to RxNav (hyphenated 10-digit NDC, or 11-digit CMS NDC). No lot, serial, or expiry.
 */
export function parsePackageCode(raw) {
  const text = cleanRaw(raw);
  if (!text) return { status: "invalid", ids: [], reason: "empty" };
  if (INVITE.test(text)) return { status: "invite", ids: [], reason: "invite" };
  const paren01 = text.match(/\(01\)\s*(\d{14})/i);
  const paren715 = text.match(/\(715\)\s*(\d{10,12})/i);
  let gtin = null;
  let explicit = null;
  if (paren01) gtin = paren01[1];
  else if (paren715) explicit = paren715[1];
  else if (/^01\d{14}/.test(text.replace(/\s/g, ""))) gtin = text.replace(/\s/g, "").slice(2, 16);
  else if (/^\d{4,5}-\d{3,4}-\d{1,2}$/.test(text)) explicit = text;
  else if (/^\d{10}$/.test(text) || /^\d{11}$/.test(text)) explicit = text;
  else if (/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(text)) gtin = text;

  if (explicit && explicit.includes("-")) {
    const digits = explicit.replace(/-/g, "");
    const shape = explicit.split("-").map(s => s.length).join("-");
    if (digits.length === 10 && ["4-4-2", "5-3-2", "5-4-1"].includes(shape)) return { status: "candidates", ids: [explicit], reason: "ndc10" };
    if (digits.length === 11 && shape === "5-4-2") return { status: "candidates", ids: [digits], reason: "ndc11" };
    return { status: "invalid", ids: [], reason: "ndc-shape" };
  }
  if (explicit && /^\d{11}$/.test(explicit)) return { status: "candidates", ids: [explicit], reason: "ndc11" };
  if (explicit && /^\d{10}$/.test(explicit)) return { status: "candidates", ids: ndcHyphenations(explicit), reason: "ndc10-ambiguous" };
  if (explicit) return { status: "unmapped", ids: [], reason: "ndc715" };

  if (!gtin) return { status: "invalid", ids: [], reason: "unrecognized" };
  if (!gs1Valid(gtin)) return { status: "invalid", ids: [], reason: "check-digit" };
  const ndc10 = gtin.length === 12 ? ndc10FromGtin12(gtin) : gtin.length === 14 ? ndc10FromGtin14(gtin) : null;
  if (!ndc10) return { status: "unmapped", ids: [], reason: gtin.length === 12 ? "upc" : "gtin" };
  return { status: "candidates", ids: ndcHyphenations(ndc10), reason: "ndc-in-gtin", ndc10 };
}

/** Literal strength words from an RxNorm name. MG, mL, and UNT/IU are not converted into each other. */
export function strengthText(name) {
  const found = String(name || "").match(STRENGTH);
  if (!found) return "";
  return [...new Set(found.map(s => s.replace(/\s+/g, " ").trim()))].join(" + ");
}

const KEEP_TTY = new Set(["SCD", "SBD"]);

/** SCD/SBD rows only. Brand-only or ingredient-only rows have no strength and are left out. */
export function choicesFromDrugGroup(json, retrievedAt) {
  const groups = json?.drugGroup?.conceptGroup || [];
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    const tty = group?.tty;
    if (!KEEP_TTY.has(tty)) continue;
    for (const c of group.conceptProperties || []) {
      if (!c?.rxcui || !c?.name || seen.has(c.rxcui)) continue;
      seen.add(c.rxcui);
      out.push(choiceFromConcept(c, { retrievedAt }));
    }
  }
  return out;
}

export function choiceFromConcept(concept, { ndc = null, retrievedAt = null } = {}) {
  const name = String(concept.name || "").trim();
  return {
    source: "rxnorm",
    rxcui: String(concept.rxcui),
    tty: concept.tty || "",
    name,
    strength: strengthText(name),
    ndc: ndc || null,
    retrievedAt: retrievedAt || null,
  };
}

export function choicesFromNdcProperties(json, namesByRxcui, retrievedAt) {
  const rows = json?.ndcPropertyList?.ndcProperty || [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const rxcui = row?.rxcui;
    const concept = rxcui && namesByRxcui[rxcui];
    if (!concept || !KEEP_TTY.has(concept.tty) || seen.has(rxcui + "|" + (row.ndc10 || ""))) continue;
    seen.add(rxcui + "|" + (row.ndc10 || ""));
    out.push(choiceFromConcept(concept, { ndc: row.ndc10 || row.ndcItem || null, retrievedAt }));
  }
  return out;
}

/**
 * Copy a confirmed catalog row onto a medicine. Dose amount, unit, times, and schedule are unchanged.
 * Strength is the catalog's literal text, not a converted quantity.
 */
export function applyCatalogChoice(med, choice) {
  const next = { ...med };
  next.name = choice.name;
  next.strength = choice.strength || "";
  next.catalog = {
    source: "rxnorm",
    rxcui: choice.rxcui,
    tty: choice.tty || "",
    name: choice.name,
    ndc: choice.ndc || null,
    retrievedAt: choice.retrievedAt || null,
  };
  return next;
}

export function rxnavDrugsUrl(name) {
  return "https://rxnav.nlm.nih.gov/REST/drugs.json?name=" + encodeURIComponent(String(name || "").trim().slice(0, 80));
}
export function rxnavNdcUrl(id) {
  return "https://rxnav.nlm.nih.gov/REST/ndcproperties.json?id=" + encodeURIComponent(id);
}
export function rxnavConceptUrl(rxcui) {
  return "https://rxnav.nlm.nih.gov/REST/rxcui/" + encodeURIComponent(rxcui) + "/properties.json";
}
