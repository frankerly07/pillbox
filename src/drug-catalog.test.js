import { describe, expect, it } from "vitest";
import {
  applyCatalogChoice, choicesFromDrugGroup, gs1CheckDigit, gs1Valid, ndcHyphenations, parsePackageCode, rxnavDrugsUrl, strengthText,
} from "./drug-catalog.js";
import { lookupPackageCode, searchDrugNames } from "./rxnav.js";

const NOW = new Date(2026, 10, 5, 12).getTime();

describe("GS1 check digit and NDC-in-GTIN", () => {
  it("matches the GS1 US examples for an NDC embedded in a GTIN", () => {
    // NDC 0001012345 → GTIN-12 300010123455, GTIN-14 00300010123455, indicator 1 → 10300010123452
    expect(gs1CheckDigit("30001012345")).toBe(5);
    expect(gs1Valid("300010123455")).toBe(true);
    expect(gs1Valid("00300010123455")).toBe(true);
    expect(gs1Valid("10300010123452")).toBe(true);
    for (const code of ["300010123455", "00300010123455", "10300010123452"]) {
      const parsed = parsePackageCode(code);
      expect(parsed.status).toBe("candidates");
      expect(parsed.ndc10).toBe("0001012345");
      expect(parsed.ids).toEqual(ndcHyphenations("0001012345"));
      expect(parsed.ids).toHaveLength(3);
    }
  });

  it("does not treat a retail UPC as an NDC", () => {
    const body = "01234567890";
    const upc = body + gs1CheckDigit(body);
    expect(gs1Valid(upc)).toBe(true);
    expect(upc[0]).not.toBe("3");
    const parsed = parsePackageCode(upc);
    expect(parsed.status).toBe("unmapped");
    expect(parsed.ids).toEqual([]);
  });

  it("drops lot and serial and refuses a Pillbox connection code", () => {
    const parsed = parsePackageCode("(01)00300010123455(17)281231(10)LOT9(21)SERIAL99");
    expect(parsed.ndc10).toBe("0001012345");
    expect(JSON.stringify(parsed)).not.toContain("SERIAL99");
    expect(JSON.stringify(parsed)).not.toContain("LOT9");
    expect(parsePackageCode("pillbox:invite:v1:ABCDEFGHJKLMNPQR").status).toBe("invite");
  });

  it("keeps a hyphenated NDC as one candidate and a bare 10-digit code as three", () => {
    expect(parsePackageCode("0378-4517-93").ids).toEqual(["0378-4517-93"]);
    expect(parsePackageCode("0001012345").ids).toHaveLength(3);
    expect(parsePackageCode("00904629161").ids).toEqual(["00904629161"]);
    expect(parsePackageCode("123").status).toBe("invalid");
  });
});

describe("strength text is not a conversion", () => {
  it("keeps mg, mL, and UNT as written", () => {
    expect(strengthText("atorvastatin 10 MG Oral Tablet [Lipitor]")).toBe("10 MG");
    expect(strengthText("insulin lispro 100 UNT/ML Injectable Solution")).toBe("100 UNT/ML");
    expect(strengthText("acetaminophen 160 MG / 5 mL Oral Suspension")).toBe("160 MG / 5 mL");
    expect(strengthText("amoxicillin 250 MG / clavulanate 125 MG Oral Tablet")).toBe("250 MG + 125 MG");
    expect(strengthText("sodium chloride 0.9 % Injection")).toBe("0.9 %");
  });
});

describe("catalog rows", () => {
  const fixture = {
    drugGroup: {
      name: "lipitor",
      conceptGroup: [
        { tty: "BN", conceptProperties: [{ rxcui: "1", name: "Lipitor", tty: "BN" }] },
        { tty: "SBD", conceptProperties: [
          { rxcui: "617314", name: "atorvastatin 10 MG Oral Tablet [Lipitor]", tty: "SBD" },
          { rxcui: "617318", name: "atorvastatin 20 MG Oral Tablet [Lipitor]", tty: "SBD" },
        ] },
      ],
    },
  };
  it("lists strength-and-form rows and does not pick one", () => {
    const choices = choicesFromDrugGroup(fixture, "2026-11-05T00:00:00.000Z");
    expect(choices.map(c => c.rxcui)).toEqual(["617314", "617318"]);
    expect(choices[0].strength).toBe("10 MG");
    expect(choices[1].strength).toBe("20 MG");
  });
  it("fills the name and strength only", () => {
    const med = { name: "", strength: "", type: "pill", doseAmount: 2, doseUnit: "pills", times: ["08:00"], schedule: { kind: "daily" } };
    const next = applyCatalogChoice(med, choicesFromDrugGroup(fixture, "2026-11-05")[0]);
    expect(next.doseAmount).toBe(2);
    expect(next.doseUnit).toBe("pills");
    expect(next.times).toEqual(["08:00"]);
    expect(next.schedule).toEqual({ kind: "daily" });
    expect(next.strength).toBe("10 MG");
    expect(next.catalog).toMatchObject({ source: "rxnorm", rxcui: "617314", tty: "SBD" });
    expect(next.catalog.dose).toBeUndefined();
  });
  it("name search URL has the name and no patient record", () => {
    const url = rxnavDrugsUrl("lipitor");
    expect(url).toBe("https://rxnav.nlm.nih.gov/REST/drugs.json?name=lipitor");
    expect(url).not.toMatch(/dose|patient|history/i);
  });
});

describe("lookup with fixtures", () => {
  function fakeFetch(routes) {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => hit[1] };
    };
    return { fetchImpl, calls };
  }
  const tenMg = { properties: { rxcui: "617314", name: "atorvastatin 10 MG Oral Tablet [Lipitor]", tty: "SBD" } };
  const twenty = { properties: { rxcui: "617318", name: "atorvastatin 20 MG Oral Tablet [Lipitor]", tty: "SBD" } };

  it("an NDC that matches two drugs stays ambiguous", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "ndcproperties.json?id=00071015523": { ndcPropertyList: { ndcProperty: [
        { rxcui: "617314", ndc10: "00071-0155-23" },
        { rxcui: "617318", ndc10: "00071-0155-23" },
      ] } },
      "/rxcui/617314/": tenMg,
      "/rxcui/617318/": twenty,
    });
    const res = await lookupPackageCode("00071-0155-23", { fetchImpl, now: NOW });
    expect(res.code).toBe("ambiguous");
    expect(res.choices.map(c => c.strength)).toEqual(["10 MG", "20 MG"]);
    expect(calls.every(u => u.startsWith("https://rxnav.nlm.nih.gov/") && !/patient|doseAmount|history/i.test(u))).toBe(true);
  });

  it("a 10-digit code is only kept when one hyphenation is in the catalog", async () => {
    const { fetchImpl } = fakeFetch({
      "id=0378-4517-93": { ndcPropertyList: { ndcProperty: [{ rxcui: "597987", ndc10: "0378-4517-93" }] } },
      "/rxcui/597987/": { properties: { rxcui: "597987", name: "carvedilol 25 MG Oral Tablet", tty: "SCD" } },
    });
    const res = await lookupPackageCode("0378451793", { fetchImpl, now: NOW });
    expect(res.parsed.ids).toHaveLength(3);
    expect(res.code).toBe("one");
    expect(res.choices[0]).toMatchObject({ rxcui: "597987", strength: "25 MG", ndc: "0378-4517-93" });
  });

  it("a UPC that is not an NDC never calls the catalog", async () => {
    const body = "01234567890";
    const upc = body + String(gs1CheckDigit(body));
    let called = false;
    const res = await lookupPackageCode(upc, { fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }, now: NOW });
    expect(res.code).toBe("unmapped");
    expect(called).toBe(false);
  });

  it("reports offline, not-found, and a name list from fixtures", async () => {
    const down = await searchDrugNames("lipitor", { fetchImpl: async () => { throw new Error("offline"); }, now: NOW });
    expect(down.code).toBe("offline");
    const empty = await searchDrugNames("zzzznotadrug", { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ drugGroup: { conceptGroup: [] } }) }), now: NOW });
    expect(empty.code).toBe("not-found");
    const limited = await searchDrugNames("lipitor", { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }), now: NOW });
    expect(limited.code).toBe("limited");
  });
});
