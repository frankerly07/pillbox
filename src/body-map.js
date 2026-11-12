import { BODY_AREAS, esc } from "./model.js";

/**
 * Front-facing body dummy for the log-event sheet.
 *
 * The figure faces the viewer, so the patient's left is on the viewer's right.
 * "Left" and "Right" are labeled on those sides. Every hotspot stores a key that
 * already exists in BODY_AREAS — taps do not invent area ids.
 *
 * Nose and mouth/gums sit beside the jaw as labeled targets. A control drawn on
 * the face itself would cover Head or be too small to tap. "Other" stays in the
 * list only. Muscle (thigh), muscle (calf), and muscle (arm) have no left/right
 * id, so each one is a zone on both limbs and either tap stores that same key.
 *
 * Joints are quiet marks until chosen. The selected zone fills with the accent
 * color, or the danger color for a bleed.
 */

const VB_W = 280;
const MID = VB_W / 2;
const TAP_W = 46;
const TAP_H = 44;

function spot(area, side, cx, cy, hw, hh, shape, text = "") {
  return { area, side, cx, cy, hw, hh, shape, text };
}

function sided(part, y, xRight, shape, hw = TAP_W, hh = TAP_H, text = "") {
  const area = part.startsWith("muscle") ? part : "right" + part;
  const leftArea = part.startsWith("muscle") ? part : "left" + part;
  return [
    spot(area, "right", xRight, y, hw, hh, shape, text),
    spot(leftArea, "left", VB_W - xRight, y, hw, hh, shape, text),
  ];
}

// The whole face. Nose and mouth stay beside the jaw, outside this box.
const head = spot("head", null, MID, 78, 64, 72, "plain");
const nose = spot("nose", null, 72, 108, 52, TAP_H, "label", "Nose");
const mouth = spot("mouth", null, VB_W - 72, 108, 52, TAP_H, "label", "Mouth");

// Arms taper outward toward the hand. Hips share the hand row, inboard of the hands.
const arms = [
  ...sided("Shoulder", 164, 92, "joint"),
  ...sided("muscleArm", 212, 76, "zone"),
  ...sided("Elbow", 260, 62, "joint"),
  ...sided("Wrist", 308, 54, "joint"),
  ...sided("Hand", 356, 48, "joint", 52, TAP_H),
];
const legs = [
  ...sided("Hip", 352, 116, "joint"),
  ...sided("muscleThigh", 400, 112, "zone"),
  ...sided("Knee", 448, 108, "joint"),
  ...sided("muscleCalf", 496, 106, "zone"),
  ...sided("Ankle", 544, 104, "joint"),
  ...sided("Foot", 592, 98, "joint", 58, TAP_H),
];
const foot = legs.find(h => h.area === "rightFoot");
const stomach = spot("stomach", null, MID, 246, 72, 84, "quiet", "Stomach");

export const FIGURE = { w: VB_W, h: Math.ceil(foot.cy + foot.hh / 2 + 16), midX: MID };

/** Reading order: top to bottom, then the viewer's left to right. */
export const BODY_HOTSPOTS = [head, nose, mouth, ...arms, stomach, ...legs]
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

/** Closed smooth outline through [x, y] points. */
function smoothClosed(points) {
  const count = points.length;
  let d = "";
  for (let i = 0; i < count; i++) {
    const p0 = points[(i - 1 + count) % count];
    const p1 = points[i];
    const p2 = points[(i + 1) % count];
    const p3 = points[(i + 2) % count];
    if (i === 0) d += `M ${n(p1[0])} ${n(p1[1])}`;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${n(c1x)} ${n(c1y)}, ${n(c2x)} ${n(c2y)}, ${n(p2[0])} ${n(p2[1])}`;
  }
  return d + " Z";
}

// Patient's right side, from the neck down the outside and back up to the groin.
// The other side is this list mirrored. Tuned so the stroke passes through the joints.
const RIGHT_OUTLINE = [
  [129, 112],
  [112, 132],
  [96, 148],
  [78, 162],
  [64, 188],
  [54, 214],
  [46, 246],
  [42, 278],
  [40, 308],
  [34, 332],
  [30, 352],
  [40, 372],
  [58, 376],
  [68, 360],
  [70, 332],
  [74, 300],
  [82, 268],
  [94, 232],
  [106, 196],
  [116, 184],
  [120, 214],
  [118, 258],
  [114, 300],
  [104, 334],
  [96, 368],
  [92, 404],
  [90, 436],
  [92, 468],
  [96, 500],
  [94, 534],
  [86, 562],
  [72, 582],
  [68, 600],
  [96, 614],
  [124, 610],
  [122, 582],
  [118, 552],
  [120, 516],
  [124, 476],
  [128, 436],
  [132, 396],
  [136, 364],
];

function silhouettePath() {
  const left = [...RIGHT_OUTLINE].reverse().map(([x, y]) => [VB_W - x, y]);
  return smoothClosed([...RIGHT_OUTLINE, ...left]);
}

function silhouette() {
  return `<g class="person">
    <path d="${silhouettePath()}"/>
    <ellipse cx="${MID}" cy="78" rx="36" ry="40"/>
    <g class="face-deco">
      <circle cx="126" cy="74" r="2.4"/>
      <circle cx="154" cy="74" r="2.4"/>
      <path d="M127 98 Q140 106 153 98"/>
    </g>
  </g>`;
}

function hitButton(h, selected) {
  const pressed = h.area === selected;
  const style = [
    `left:${(h.cx / FIGURE.w * 100).toFixed(2)}%`,
    `top:${(h.cy / FIGURE.h * 100).toFixed(2)}%`,
    `width:${(h.hw / FIGURE.w * 100).toFixed(2)}%`,
    `height:${(h.hh / FIGURE.h * 100).toFixed(2)}%`,
  ].join(";");
  return `<button type="button" class="body-hit ${h.shape}" data-act="ev-area" data-area="${h.area}" data-side="${h.side || ""}" aria-pressed="${pressed ? "true" : "false"}" aria-label="${esc(hotspotName(h))}" style="${style}">${h.text ? esc(h.text) : ""}</button>`;
}

/**
 * Figure, Left/Right labels, the "tap where it happened" hint, and the selected name.
 * `tone` is "bad" for a bleed (danger color) and "accent" otherwise.
 */
export function bodyMapHtml(selected, tone = "accent") {
  const area = BODY_AREAS[selected] ? selected : "";
  const toneName = tone === "bad" ? "bad" : "accent";
  const rightX = (92 / FIGURE.w * 100).toFixed(2);
  const leftX = ((VB_W - 92) / FIGURE.w * 100).toFixed(2);
  return `<div class="body-map">
    <div class="body-fig" data-tone="${toneName}" role="group" aria-labelledby="ev-where" style="aspect-ratio:${FIGURE.w} / ${FIGURE.h}">
      <svg viewBox="0 0 ${FIGURE.w} ${FIGURE.h}" aria-hidden="true">${silhouette()}</svg>
      <span class="body-side patient-right" style="left:${rightX}%">Right</span>
      <span class="body-side patient-left" style="left:${leftX}%">Left</span>
      ${BODY_HOTSPOTS.map(h => hitButton(h, area)).join("")}
    </div>
    <p class="body-picked${area ? " on" : ""}" aria-live="polite">${area ? esc(BODY_AREAS[area]) : ""}</p>
    <p class="muted small body-hint" id="ev-body-hint">Tap where it happened</p>
    <p class="muted small body-hint">Left and Right are this person's own sides.</p>
  </div>`;
}
