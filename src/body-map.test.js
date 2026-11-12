import { describe, it, expect } from "vitest";
import { BODY_AREAS, normalizeEvent } from "./model.js";
import {
  BODY_HOTSPOTS, FIGURE, bodyAreasOnFigure, bodyAreasListOnly, hotspotName, areaAfterTap, bodyMapHtml,
} from "./body-map.js";

const box = h => ({ l: h.cx - h.hw / 2, r: h.cx + h.hw / 2, t: h.cy - h.hh / 2, b: h.cy + h.hh / 2 });
const overlaps = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;

function buttons(html) {
  return [...html.matchAll(/<button\b[^>]*>/g)].map(m => m[0]);
}
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : "";
}

describe("body map areas", () => {
  it("uses only existing BODY_AREAS keys", () => {
    for (const h of BODY_HOTSPOTS) expect(BODY_AREAS[h.area], h.area).toBeTruthy();
    expect(new Set([...bodyAreasOnFigure(), ...bodyAreasListOnly()])).toEqual(new Set(Object.keys(BODY_AREAS)));
  });

  it("puts nose and mouth in a row under the head, and leaves Other to the list", () => {
    // Nose and mouth/gums are a compact chip row under the plain head, not labels
    // floating beside it. The hit area stays large enough to tap.
    const head = BODY_HOTSPOTS.find(h => h.area === "head");
    const nose = BODY_HOTSPOTS.find(h => h.area === "nose");
    const mouth = BODY_HOTSPOTS.find(h => h.area === "mouth");
    expect(nose.cy).toBeGreaterThan(head.cy + head.hh / 2 - 4);
    expect(mouth.cy).toBe(nose.cy);
    expect(Math.abs(nose.cx - FIGURE.midX)).toBeLessThan(head.hw);
    expect(Math.abs(mouth.cx - FIGURE.midX)).toBeLessThan(head.hw);
    expect(bodyAreasOnFigure()).toEqual(expect.arrayContaining(["nose", "mouth", "head", "stomach"]));
    expect(bodyAreasListOnly()).toEqual(["other"]);
  });

  it("covers both sides of every joint and both limbs of each muscle", () => {
    const on = bodyAreasOnFigure();
    for (const part of ["Knee", "Ankle", "Elbow", "Hip", "Shoulder", "Wrist", "Hand", "Foot"]) {
      expect(on).toContain("left" + part);
      expect(on).toContain("right" + part);
    }
    for (const area of ["muscleArm", "muscleThigh", "muscleCalf"]) {
      const sides = BODY_HOTSPOTS.filter(h => h.area === area).map(h => h.side).sort();
      expect(sides).toEqual(["left", "right"]);
    }
  });

  it("stores a tap as that BODY_AREAS key, and a second tap clears it", () => {
    const at = new Date(2026, 10, 4, 9, 30);
    for (const h of BODY_HOTSPOTS) {
      expect(normalizeEvent({ type: "bleed", at, area: h.area }).area).toBe(h.area);
      expect(normalizeEvent({ type: "symptom", at, area: h.area }).area).toBe(h.area);
    }
    expect(areaAfterTap("", "leftKnee")).toBe("leftKnee");
    expect(areaAfterTap("leftKnee", "rightKnee")).toBe("rightKnee");
    expect(areaAfterTap("muscleArm", "muscleArm")).toBe("");
    expect(areaAfterTap("leftKnee", "tail")).toBe("leftKnee");
    expect(areaAfterTap("", "not-a-place")).toBe("");
    expect(normalizeEvent({ type: "bleed", at, area: areaAfterTap("leftKnee", "leftKnee") }).area).toBeNull();
  });
});

describe("body map layout", () => {
  it("draws the patient's left on the viewer's right", () => {
    for (const h of BODY_HOTSPOTS) {
      if (h.side === "left" || h.area.startsWith("left")) expect(h.cx).toBeGreaterThan(FIGURE.midX);
      if (h.side === "right" || h.area.startsWith("right")) expect(h.cx).toBeLessThan(FIGURE.midX);
    }
    const nose = BODY_HOTSPOTS.find(h => h.area === "nose");
    const mouth = BODY_HOTSPOTS.find(h => h.area === "mouth");
    expect(nose.cx + mouth.cx).toBe(FIGURE.w);
    expect(nose.cy).toBe(mouth.cy);
  });

  it("mirrors the two sides and lines each pair up", () => {
    for (const part of ["Shoulder", "Elbow", "Wrist", "Hand", "Hip", "Knee", "Ankle", "Foot"]) {
      const left = BODY_HOTSPOTS.find(h => h.area === "left" + part);
      const right = BODY_HOTSPOTS.find(h => h.area === "right" + part);
      expect(left.cy).toBe(right.cy);
      expect(left.cx).toBeGreaterThan(right.cx);
      expect(left.cx + right.cx).toBe(FIGURE.w);
    }
    for (const area of ["muscleArm", "muscleThigh", "muscleCalf"]) {
      const pair = BODY_HOTSPOTS.filter(h => h.area === area);
      expect(pair[0].cy).toBe(pair[1].cy);
      expect(pair[0].cx + pair[1].cx).toBe(FIGURE.w);
    }
  });

  it("keeps every target at least 44px in the figure's own units, inside the frame, and not overlapping", () => {
    for (const h of BODY_HOTSPOTS) {
      expect(h.hw).toBeGreaterThanOrEqual(44);
      expect(h.hh).toBeGreaterThanOrEqual(44);
      const b = box(h);
      expect(b.l).toBeGreaterThanOrEqual(4);
      expect(b.r).toBeLessThanOrEqual(FIGURE.w - 4);
      expect(b.t).toBeGreaterThanOrEqual(18);
      expect(b.b).toBeLessThanOrEqual(FIGURE.h - 4);
    }
    for (let i = 0; i < BODY_HOTSPOTS.length; i++) {
      for (let j = i + 1; j < BODY_HOTSPOTS.length; j++) {
        const a = BODY_HOTSPOTS[i], b = BODY_HOTSPOTS[j];
        expect(overlaps(box(a), box(b)), `${a.area}/${a.side} overlaps ${b.area}/${b.side}`).toBe(false);
      }
    }
  });
});

describe("body map markup", () => {
  const html = bodyMapHtml("leftKnee");

  it("labels Left and Right, with Left on the viewer's right", () => {
    expect(html).toContain(">Left<");
    expect(html).toContain(">Right<");
    const left = Number(html.match(/patient-left" style="left:([\d.]+)%/)[1]);
    const right = Number(html.match(/patient-right" style="left:([\d.]+)%/)[1]);
    expect(left).toBeGreaterThan(50);
    expect(right).toBeLessThan(50);
  });

  it("presses the tapped area and places the patient's left knee on the viewer's right", () => {
    const tags = buttons(html);
    const pressed = tags.filter(t => attr(t, "aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(attr(pressed[0], "data-area")).toBe("leftKnee");
    const left = tags.find(t => attr(t, "data-area") === "leftKnee");
    const right = tags.find(t => attr(t, "data-area") === "rightKnee");
    expect(Number(attr(left, "style").match(/left:([\d.]+)%/)[1])).toBeGreaterThan(Number(attr(right, "style").match(/left:([\d.]+)%/)[1]));
    expect(html).toMatch(/class="body-picked on"[^>]*>Left knee</);
    expect(html).toContain("Tap where it happened");
    expect(html).toContain("<path");
    expect(html).toContain("<ellipse");
    expect(html).not.toContain("face-deco");
    expect(html).not.toContain(">Stomach<");
    expect(bodyMapHtml("stomach")).toContain(">Stomach<");
    expect(html).toContain('data-tone="accent"');
    expect(bodyMapHtml("leftKnee", "bad")).toContain('data-tone="bad"');
    expect(bodyMapHtml("leftKnee", "nope")).toContain('data-tone="accent"');
    expect(html).toContain(`viewBox="0 0 ${FIGURE.w} ${FIGURE.h}"`);
  });

  it("highlights both limbs when the area has no side", () => {
    const tags = buttons(bodyMapHtml("muscleThigh"));
    const pressed = tags.filter(t => attr(t, "aria-pressed") === "true");
    expect(pressed.map(t => attr(t, "data-area"))).toEqual(["muscleThigh", "muscleThigh"]);
    expect(pressed.map(t => attr(t, "data-side")).sort()).toEqual(["left", "right"]);
    expect(hotspotName({ area: "muscleThigh", side: "left" })).toBe("Muscle (thigh), on the person's left");
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
