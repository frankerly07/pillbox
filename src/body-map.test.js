import { describe, it, expect } from "vitest";
import { BODY_AREAS, LEGACY_BODY_AREAS, eventLabel, normalizeEvent } from "./model.js";
import chart from "./assets/body-map/points.json";
import {
  BODY_HOTSPOTS, BODY_AREA_ALIASES, FIGURE, bodyAreasOnFigure, bodyAreasListOnly, hotspotName, areaAfterTap, bodyMapHtml,
  figureDisplayWidth, hitCssPx, normalizeFigure, figureContains, labelBox, selectionTargets, hotspotsFor,
} from "./body-map.js";

const box = h => ({ l: h.cx - h.hw / 2, r: h.cx + h.hw / 2, t: h.cy - h.hh / 2, b: h.cy + h.hh / 2 });
const overlaps = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
const holds = (b, x, y) => x > b.l && x < b.r && y > b.t && y < b.b;

function buttons(html) {
  return [...html.matchAll(/<button\b[^>]*>/g)].map(m => m[0]);
}
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : "";
}

const ON_CHART = ["head", "neck", "chest", "stomach", "groin"];
const LIMBS = ["Shoulder", "Elbow", "Forearm", "Wrist", "Hand", "Hip", "Thigh", "Knee", "Calf", "Ankle", "Foot"];

describe("body map areas", () => {
  it("uses only existing BODY_AREAS keys", () => {
    for (const h of BODY_HOTSPOTS) expect(BODY_AREAS[h.area], h.area).toBeTruthy();
    expect(new Set([...bodyAreasOnFigure(), ...bodyAreasListOnly()])).toEqual(new Set(Object.keys(BODY_AREAS)));
  });

  it("puts the design points on the chart and keeps the other ids readable", () => {
    const on = bodyAreasOnFigure();
    for (const id of ON_CHART) expect(on).toContain(id);
    expect(on).not.toEqual(expect.arrayContaining(["nose", "mouth", "lowerStomach", "leftUpperArm", "rightUpperArm", ...LEGACY_BODY_AREAS]));
    expect(bodyAreasListOnly()).toEqual([
      "leftUpperArm", "rightUpperArm", "mouth", "nose", "lowerStomach",
      "muscleThigh", "muscleCalf", "muscleArm", "other",
    ]);
    expect(eventLabel({ type: "bleed", area: "nose" })).toBe("Bleed · Nose");
    expect(eventLabel({ type: "bleed", area: "mouth" })).toBe("Bleed · Mouth / gums");
    expect(eventLabel({ type: "bleed", area: "lowerStomach" })).toBe("Bleed · Lower stomach");
    expect(eventLabel({ type: "bleed", area: "leftUpperArm" })).toBe("Bleed · Left upper arm");
  });

  it("covers both sides of every limb point, and keeps the old unsided ids readable", () => {
    const on = bodyAreasOnFigure();
    for (const part of LIMBS) {
      expect(on).toContain("left" + part);
      expect(on).toContain("right" + part);
    }
    expect(eventLabel({ type: "bleed", area: "muscleCalf", severity: 1 })).toBe("Bleed · Muscle (calf) · Mild");
    expect(eventLabel({ type: "bleed", area: "neck" })).toBe("Bleed · Neck");
    expect(eventLabel({ type: "bleed", area: "head" })).toBe("Bleed · Head");
    expect(eventLabel({ type: "bleed", area: "leftWrist" })).toBe("Bleed · Left wrist");
    expect(eventLabel({ type: "bleed", area: "leftCalf" })).toBe("Bleed · Left shin");
    expect(selectionTargets("muscleArm")).toEqual(["leftUpperArm", "rightUpperArm"]);
    expect(selectionTargets("muscleThigh")).toEqual(["leftThigh", "rightThigh"]);
    expect(selectionTargets("muscleCalf")).toEqual(["leftCalf", "rightCalf"]);
  });

  it("stores a tap as that BODY_AREAS key, and a second tap clears it", () => {
    const at = new Date(2026, 10, 4, 9, 30);
    for (const h of BODY_HOTSPOTS) {
      expect(normalizeEvent({ type: "bleed", at, area: h.area }).area).toBe(h.area);
      expect(normalizeEvent({ type: "symptom", at, area: h.area }).area).toBe(h.area);
    }
    expect(areaAfterTap("", "leftKnee")).toBe("leftKnee");
    expect(areaAfterTap("leftKnee", "rightKnee")).toBe("rightKnee");
    expect(areaAfterTap("leftCalf", "leftCalf")).toBe("");
    expect(normalizeEvent({ type: "bleed", at, area: "muscleArm" }).area).toBe("muscleArm");
    expect(normalizeEvent({ type: "bleed", at, area: "neck" }).area).toBe("neck");
    expect(normalizeEvent({ type: "bleed", at, area: "nose" }).area).toBe("nose");
    expect(areaAfterTap("leftKnee", "tail")).toBe("leftKnee");
    expect(areaAfterTap("", "not-a-place")).toBe("");
    expect(normalizeEvent({ type: "bleed", at, area: areaAfterTap("leftKnee", "leftKnee") }).area).toBeNull();
  });
});

describe("body map layout", () => {
  it("places every dot on the design coordinates for that figure", () => {
    for (const figure of ["male", "female"]) {
      const spots = hotspotsFor(figure);
      const file = chart[figure].points;
      expect(spots).toHaveLength(file.length);
      expect(spots).toHaveLength(27);
      file.forEach((p, i) => {
        expect(spots[i].cx, figure + " " + p.label).toBe(p.x);
        expect(spots[i].cy, figure + " " + p.label).toBe(p.y);
        expect(spots[i].point).toBe(p.label);
      });
      const shin = spots.find(h => h.point === "shin" && h.side === "left");
      expect(shin.area).toBe("leftCalf");
    }
    const maleChest = hotspotsFor("male").find(h => h.area === "chest");
    const femaleChest = hotspotsFor("female").find(h => h.area === "chest");
    expect(maleChest.cy).not.toBe(femaleChest.cy);
  });

  it("draws the patient's left on the viewer's right", () => {
    for (const figure of ["male", "female"]) {
      for (const h of hotspotsFor(figure)) {
        if (h.side === "left" || h.area.startsWith("left")) expect(h.cx, figure + " " + h.area).toBeGreaterThan(FIGURE.midX);
        if (h.side === "right" || h.area.startsWith("right")) expect(h.cx, figure + " " + h.area).toBeLessThan(FIGURE.midX);
      }
    }
  });

  it("mirrors the two sides and lines each pair up", () => {
    for (const figure of ["male", "female"]) {
      const spots = hotspotsFor(figure);
      for (const part of LIMBS) {
        const left = spots.find(h => h.area === "left" + part);
        const right = spots.find(h => h.area === "right" + part);
        expect(left.cy, figure + " " + part).toBe(right.cy);
        expect(left.cx).toBeGreaterThan(right.cx);
        expect(left.cx + right.cx).toBe(200);
        expect(left.text).toBe(right.text);
        expect(left.text.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every dot selectable, with a hit that does not cover a neighbor's center", () => {
    for (const figure of ["male", "female"]) {
      const spots = hotspotsFor(figure);
      const boxes = spots.map(h => box(h));
      for (let i = 0; i < spots.length; i++) {
        const b = boxes[i];
        expect(b.t, spots[i].area).toBeGreaterThanOrEqual(0);
        expect(b.b, spots[i].area).toBeLessThanOrEqual(FIGURE.h);
        expect(holds(b, spots[i].cx, spots[i].cy)).toBe(true);
        for (let j = 0; j < spots.length; j++) {
          if (i === j) continue;
          expect(holds(boxes[j], spots[i].cx, spots[i].cy), `${figure} ${spots[j].area} covers ${spots[i].area}`).toBe(false);
        }
      }
    }
  });
});

describe("body map markup", () => {
  const html = bodyMapHtml("leftKnee");

  it("names the side in the selected line", () => {
    expect(html).toContain("Selected: Left knee");
    expect(html).toContain("Left and Right are this person's own sides.");
    const left = buttons(html).find(t => attr(t, "data-area") === "leftKnee");
    const right = buttons(html).find(t => attr(t, "data-area") === "rightKnee");
    expect(Number(attr(left, "style").match(/left:([\d.]+)%/)[1])).toBeGreaterThan(50);
    expect(Number(attr(right, "style").match(/left:([\d.]+)%/)[1])).toBeLessThan(50);
  });

  it("presses the tapped area and draws the design outline", () => {
    const tags = buttons(html);
    const pressed = tags.filter(t => attr(t, "aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(attr(pressed[0], "data-area")).toBe("leftKnee");
    expect(html).toMatch(/class="body-picked on"[^>]*>Selected: Left knee</);
    expect(html).toContain("Tap where it happened");
    expect(html).toContain('class="outline"');
    expect(html).toContain('class="chest"');
    expect(html).toContain("M 100.00,20.00");
    expect(html).not.toContain("<ellipse");
    expect(html).not.toContain("face-deco");
    expect(html).toContain(">Stomach<");
    expect(html).toContain(">Shin<");
    expect(html).not.toContain("Selected: Stomach");
    expect(bodyMapHtml("stomach")).toContain("Selected: Stomach");
    expect(bodyMapHtml("leftCalf")).toContain("Selected: Left shin");
    expect(html).toContain('data-tone="accent"');
    expect(bodyMapHtml("leftKnee", "bad")).toContain('data-tone="bad"');
    expect(bodyMapHtml("leftKnee", "nope")).toContain('data-tone="accent"');
    expect(html).toContain(`viewBox="${FIGURE.minX} 0 ${FIGURE.w} ${FIGURE.h}"`);
    expect(bodyMapHtml("", "accent", "female")).not.toContain(bodyMapHtml("", "accent", "male").match(/class="outline" d="([^"]+)"/)[1]);
  });

  it("lights up both new sides when an older unsided muscle is still saved", () => {
    const tags = buttons(bodyMapHtml("muscleThigh"));
    const pressed = tags.filter(t => attr(t, "aria-pressed") === "true");
    expect(pressed.map(t => attr(t, "data-area")).sort()).toEqual(["leftThigh", "rightThigh"]);
    expect(pressed.map(t => attr(t, "data-side")).sort()).toEqual(["left", "right"]);
    expect(bodyMapHtml("muscleThigh")).toContain("Selected: Muscle (thigh)");
    expect(bodyMapHtml("muscleCalf")).toContain("Selected: Muscle (calf)");
    const calves = buttons(bodyMapHtml("muscleCalf")).filter(t => attr(t, "aria-pressed") === "true");
    expect(calves.map(t => attr(t, "data-area")).sort()).toEqual(["leftCalf", "rightCalf"]);
    expect(bodyMapHtml("muscleArm")).toContain("Selected: Muscle (arm)");
    expect(buttons(bodyMapHtml("muscleArm")).some(t => attr(t, "aria-pressed") === "true")).toBe(false);
    expect(BODY_AREA_ALIASES.muscleCalf).toEqual(["leftCalf", "rightCalf"]);
    expect(hotspotName(BODY_HOTSPOTS.find(h => h.area === "leftKnee"))).toBe("Left knee");
  });

  it("gives every charted place a hit target on both figures", () => {
    const ids = bodyAreasOnFigure();
    expect(new Set(hotspotsFor("female").map(h => h.area))).toEqual(new Set(ids));
    for (const figure of ["male", "female"]) {
      for (const id of ids) {
        const page = bodyMapHtml(id, "accent", figure);
        const pressed = buttons(page).filter(t => attr(t, "aria-pressed") === "true");
        expect(pressed.length, figure + " " + id).toBeGreaterThan(0);
        expect(pressed.every(t => attr(t, "data-area") === id)).toBe(true);
        expect(areaAfterTap("", id)).toBe(id);
        expect(page).toContain('data-figure="' + figure + '"');
      }
    }
    const maleAreas = buttons(bodyMapHtml("", "accent", "male")).map(t => attr(t, "data-area")).sort();
    const femaleAreas = buttons(bodyMapHtml("", "accent", "female")).map(t => attr(t, "data-area")).sort();
    expect(femaleAreas).toEqual(maleAreas);
    expect(normalizeFigure("female")).toBe("female");
    expect(normalizeFigure("nope")).toBe("male");
    expect(normalizeFigure(undefined)).toBe("male");
  });

  it("shows a short label on every dot without the labels overlapping", () => {
    for (const figure of ["male", "female"]) {
      const page = bodyMapHtml("", "accent", figure);
      const spots = hotspotsFor(figure);
      for (const h of spots) {
        expect(h.text, h.area).toBeTruthy();
        expect(page).toContain(`>${h.text}<`);
        const b = labelBox(h);
        expect(b.l, figure + " " + h.area).toBeGreaterThanOrEqual(FIGURE.minX);
        expect(b.r, figure + " " + h.area).toBeLessThanOrEqual(FIGURE.minX + FIGURE.w);
        expect(b.t, figure + " " + h.area).toBeGreaterThanOrEqual(0);
        expect(b.b, figure + " " + h.area).toBeLessThanOrEqual(FIGURE.h);
      }
      expect(page).toContain('class="mark"');
      for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          expect(
            overlaps(labelBox(spots[i]), labelBox(spots[j])),
            `${figure} ${spots[i].text}/${spots[i].area} overlaps ${spots[j].text}/${spots[j].area}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps every hotspot inside its own outline", () => {
    for (const figure of ["male", "female"]) {
      for (const h of hotspotsFor(figure)) {
        expect(figureContains(figure, h.cx, h.cy), figure + " " + h.area + " " + (h.side || "")).toBe(true);
      }
    }
  });

  it("keeps every hit at least 44px on a phone", () => {
    for (const viewport of [360, 390, 412]) {
      const width = figureDisplayWidth(viewport);
      for (const figure of ["male", "female"]) {
        for (const h of hotspotsFor(figure)) {
          const size = hitCssPx(h, width);
          expect(size.w, viewport + " " + figure + " " + h.area).toBeGreaterThanOrEqual(44);
          expect(size.h, viewport + " " + figure + " " + h.area).toBeGreaterThanOrEqual(44);
        }
      }
    }
  });

  it("ignores an unknown selection and escapes it", () => {
    const blank = bodyMapHtml('"><script>');
    expect(blank).not.toContain("<script>");
    expect(buttons(blank).some(t => attr(t, "aria-pressed") === "true")).toBe(false);
    expect(blank).toContain("Tap where it happened");
    expect(buttons(blank)).toHaveLength(BODY_HOTSPOTS.length);
    expect(buttons(blank).every(t => attr(t, "type") === "button" && attr(t, "data-act") === "ev-area")).toBe(true);
  });
});
