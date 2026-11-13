import { BODY_AREAS, esc } from "./model.js";

/**
 * Front-facing body diagram for the log-event sheet.
 *
 * The figure faces the viewer, so the patient's left is on the viewer's right.
 * Male and female outlines differ in the chest, waist, and pelvis. They share
 * the same hotspot positions and BODY_AREAS keys, so a saved event names the
 * same place on either figure. "Other" stays in the list only.
 *
 * Hit boxes tile the body: they meet at the edges and do not overlap, so a tap
 * cannot fall through a gap or be swallowed by a neighbor. The neck selects
 * Head. The forearm is part of the wrist target, and the shin is part of the
 * calf, so those stretches are tappable without new stored ids. Chest is its
 * own place. Upper and lower abdomen are one Stomach target.
 *
 * Decorative layers (the outline, side labels, muscle tints, chip text) do not
 * receive taps. Each hotspot is a button of at least 44px on a phone.
 */

const VB_W = 280;
const MID = VB_W / 2;
const TAP = 44;

function spot(area, side, cx, cy, hw, hh, shape, text = "", tilt = 0) {
  return { area, side, cx, cy, hw, hh, shape, text, tilt };
}

function sided(part, cy, xRight, shape, hw = TAP, hh = TAP, tilt = 0) {
  const area = part.startsWith("muscle") ? part : "right" + part;
  const leftArea = part.startsWith("muscle") ? part : "left" + part;
  return [
    spot(area, "right", xRight, cy, hw, hh, shape, "", -tilt),
    spot(leftArea, "left", VB_W - xRight, cy, hw, hh, shape, "", tilt),
  ];
}

// Head, then the neck (also Head) with Nose and Mouth beside it, under the jaw.
const head = spot("head", null, MID, 44, 60, 52, "region");
const neck = spot("head", null, MID, 96, TAP, TAP, "region");
const nose = spot("nose", null, 94, 96, TAP, TAP, "chip", "Nose");
const mouth = spot("mouth", null, VB_W - 94, 96, TAP, TAP, "chip", "Mouth");

// Limbs are stacked bands that touch, so the arm and leg have no dead space.
const arms = [
  ...sided("Shoulder", 140, 74, "joint", 48, TAP),
  ...sided("muscleArm", 196, 68, "zone", 46, 68, 14),
  ...sided("Elbow", 252, 62, "joint"),
  ...sided("Wrist", 308, 58, "joint", TAP, 68),
  ...sided("Hand", 364, 54, "joint", 48, TAP),
];
const legs = [
  ...sided("Hip", 318, 114, "joint", 52, 52),
  ...sided("muscleThigh", 382, 112, "zone", 52, 76, 2),
  ...sided("Knee", 442, 110, "joint"),
  ...sided("muscleCalf", 498, 108, "zone", 46, 68, 1),
  ...sided("Ankle", 554, 106, "joint"),
  ...sided("Foot", 598, 100, "joint", 56, TAP),
];
for (const h of arms) if (h.area.endsWith("Wrist")) h.dot = "end";
const foot = legs.find(h => h.area === "rightFoot");
const shoulder = arms.find(h => h.area === "rightShoulder");
// Chest is the upper torso. Stomach covers the abdomen down to the pelvis.
const chest = spot("chest", null, MID, 162, 64, 80, "region", "Chest");
const stomach = spot("stomach", null, MID, 247, 60, 90, "region", "Stomach");

export const FIGURE = { w: VB_W, h: Math.ceil(foot.cy + foot.hh / 2 + 16), midX: MID };
export const BODY_FIGURES = ["male", "female"];

/** "female" or "male". Anything else, including a missing value, is male. */
export function normalizeFigure(figure) {
  return figure === "female" ? "female" : "male";
}

/** Reading order: top to bottom, then the viewer's left to right. */
export const BODY_HOTSPOTS = [head, neck, nose, mouth, ...arms, chest, stomach, ...legs]
  .sort((a, b) => a.cy - b.cy || a.cx - b.cx);

/** Area ids a tap can set, in first-seen order. */
export function bodyAreasOnFigure() {
  return [...new Set(BODY_HOTSPOTS.map(h => h.area))];
}

/** BODY_AREAS keys with no figure target. Picked from the list. */
export function bodyAreasListOnly() {
  const on = new Set(bodyAreasOnFigure());
  return Object.keys(BODY_AREAS).filter(k => !on.has(k));
}

/**
 * How wide the diagram is on a phone. The sheet is full width up to 560px,
 * with 16px of padding on each side, and the figure itself stops at 360px.
 */
export function figureDisplayWidth(viewportWidth) {
  const panel = Math.min(Math.max(viewportWidth, 0), 560);
  const content = Math.max(panel - 32, 0);
  return Math.min(content, 360);
}

/** Hit size in CSS pixels when the figure is `figureCssWidth` wide. */
export function hitCssPx(h, figureCssWidth) {
  const scale = figureCssWidth / FIGURE.w;
  return { w: h.hw * scale, h: h.hh * scale };
}

/** Spoken name for one hotspot. Muscles say which limb, because the stored id does not. */
export function hotspotName(h) {
  const name = BODY_AREAS[h.area] || "";
  if (!h.area.startsWith("muscle")) return name;
  if (h.side === "left") return name + ", on the person's left";
  if (h.side === "right") return name + ", on the person's right";
  return name;
}

/**
 * Area after a tap. Tapping the selected area again clears it.
 * Unknown ids are ignored so a bad target cannot be stored.
 */
export function areaAfterTap(current, hit) {
  if (!BODY_AREAS[hit]) return BODY_AREAS[current] ? current : "";
  return current === hit ? "" : hit;
}

function n(v) { return Math.round(v * 10) / 10; }

// Points down the patient's right side and back up to the groin.
// Kept close to the hit boxes so every part of the stroke can be tapped.
// Male: broader shoulders, flatter chest, narrower pelvis.
// Female: narrower shoulders, a chest curve, a smaller waist, a wider pelvis.
const MALE_POINTS = [
  [128, 74], [124, 104], [112, 124], [90, 136], [68, 150], [54, 180],
  [48, 230], [46, 290], [48, 340], [60, 358], [78, 352], [88, 310],
  [98, 250], [108, 190], [112, 168], [114, 200], [116, 248], [108, 295],
  [96, 330], [90, 385], [88, 445], [92, 505], [98, 555], [88, 582],
  [110, 604], [126, 588], [118, 545], [112, 475], [116, 405], [124, 352],
  [134, 334], [140, 328],
];
const FEMALE_POINTS = [
  [130, 74], [126, 104], [118, 122], [100, 134], [80, 148], [64, 176],
  [56, 225], [52, 285], [54, 338], [66, 356], [82, 350], [92, 308],
  [102, 250], [106, 200], [104, 184], [110, 215], [120, 250], [112, 290],
  [96, 328], [86, 380], [84, 440], [88, 500], [96, 552], [86, 580],
  [110, 602], [126, 586], [118, 540], [110, 465], [112, 395], [122, 350],
  [134, 338], [140, 334],
];

function smoothHalf(points) {
  const segs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    segs.push([
      [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      p2,
    ]);
  }
  return segs;
}

const MALE_HALF = smoothHalf(MALE_POINTS);
const FEMALE_HALF = smoothHalf(FEMALE_POINTS);
const NECK = MALE_POINTS[0];

function mirrorHalf(segs, start) {
  const out = [];
  let prev = start;
  const starts = [];
  for (const seg of segs) {
    starts.push(prev);
    prev = seg[2];
  }
  for (let i = segs.length - 1; i >= 0; i--) {
    const [c1, c2] = segs[i];
    out.push([[VB_W - c2[0], c2[1]], [VB_W - c1[0], c1[1]], [VB_W - starts[i][0], starts[i][1]]]);
  }
  return out;
}

function cubics(segs) {
  return segs.map(([c1, c2, p]) => `C ${n(c1[0])} ${n(c1[1])}, ${n(c2[0])} ${n(c2[1])}, ${n(p[0])} ${n(p[1])}`).join(" ");
}

function silhouette(figure) {
  const half = figure === "female" ? FEMALE_HALF : MALE_HALF;
  const start = figure === "female" ? FEMALE_POINTS[0] : MALE_POINTS[0];
  const d = `M ${n(start[0])} ${n(start[1])} ${cubics(half)} ${cubics(mirrorHalf(half, start))} Z`;
  return `<g class="person"><path d="${d}"/><ellipse cx="${MID}" cy="42" rx="29" ry="26"/></g>`;
}

function hitButton(h, selected) {
  const pressed = h.area === selected;
  const style = [
    `left:${(h.cx / FIGURE.w * 100).toFixed(2)}%`,
    `top:${(h.cy / FIGURE.h * 100).toFixed(2)}%`,
    `width:${(h.hw / FIGURE.w * 100).toFixed(2)}%`,
    `height:${(h.hh / FIGURE.h * 100).toFixed(2)}%`,
  ].join(";");
  let inner = "";
  if (h.shape === "chip") inner = `<span class="chip-label">${esc(h.text)}</span>`;
  else if (h.shape === "zone") inner = `<span class="zone-tint" style="transform:rotate(${h.tilt || 0}deg)"></span>`;
  else if (h.shape === "region" && pressed && h.text) inner = esc(h.text);
  return `<button type="button" class="body-hit ${h.shape}${h.dot === "end" ? " dot-end" : ""}" data-act="ev-area" data-area="${h.area}" data-side="${h.side || ""}" aria-pressed="${pressed ? "true" : "false"}" aria-label="${esc(hotspotName(h))}" style="${style}">${inner}</button>`;
}

/**
 * Figure, Left/Right labels beside the shoulders, the hint, and the selected name.
 * `tone` is "bad" for a bleed and "accent" otherwise. `figure` is "female" or "male".
 */
export function bodyMapHtml(selected, tone = "accent", figure = "male") {
  const area = BODY_AREAS[selected] ? selected : "";
  const toneName = tone === "bad" ? "bad" : "accent";
  const sex = normalizeFigure(figure);
  const labelY = (shoulder.cy / FIGURE.h * 100).toFixed(2);
  const rightX = ((shoulder.cx - 46) / FIGURE.w * 100).toFixed(2);
  const leftX = ((VB_W - (shoulder.cx - 46)) / FIGURE.w * 100).toFixed(2);
  return `<div class="body-map">
    <div class="body-fig" data-tone="${toneName}" data-figure="${sex}" role="group" aria-labelledby="ev-where" style="aspect-ratio:${FIGURE.w} / ${FIGURE.h}">
      <svg viewBox="0 0 ${FIGURE.w} ${FIGURE.h}" aria-hidden="true">${silhouette(sex)}</svg>
      <span class="body-side patient-right" style="left:${rightX}%;top:${labelY}%">Right</span>
      <span class="body-side patient-left" style="left:${leftX}%;top:${labelY}%">Left</span>
      ${BODY_HOTSPOTS.map(h => hitButton(h, area)).join("")}
    </div>
    <p class="body-picked${area ? " on" : ""}" aria-live="polite">${area ? esc(BODY_AREAS[area]) : ""}</p>
    <p class="muted small body-hint" id="ev-body-hint">Tap where it happened</p>
    <p class="muted small body-hint">Left and Right are this person's own sides.</p>
  </div>`;
}
