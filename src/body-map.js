import { BODY_AREAS, esc } from "./model.js";

/**
 * Front-facing body diagram for the log-event sheet.
 *
 * The figure faces the viewer, so the patient's left is on the viewer's right.
 * "Left" and "Right" sit beside the shoulders. Every hotspot stores a key that
 * already exists in BODY_AREAS — taps do not invent area ids.
 *
 * The head is a plain oval. Nose and mouth/gums are a compact chip row directly
 * under it, with a 44px hit area and a smaller visible label. "Other" stays in
 * the list only. Muscle (thigh), muscle (calf), and muscle (arm) have no
 * left/right id, so each one is a soft region on both limbs and either tap
 * stores that same key.
 *
 * Joints are small dots. The selected joint is a smaller marker with a soft
 * halo, and the zone behind it is only tinted, so the outline stays visible.
 * A bleed uses the danger color; other event types use the accent color.
 * The outline is one half, mirrored, so the two sides match.
 */

const VB_W = 280;
const MID = VB_W / 2;
const TAP_W = 46;
const TAP_H = 44;

function spot(area, side, cx, cy, hw, hh, shape, text = "", tilt = 0) {
  return { area, side, cx, cy, hw, hh, shape, text, tilt };
}

function sided(part, y, xRight, shape, hw = TAP_W, hh = TAP_H, tilt = 0) {
  const area = part.startsWith("muscle") ? part : "right" + part;
  const leftArea = part.startsWith("muscle") ? part : "left" + part;
  return [
    spot(area, "right", xRight, y, hw, hh, shape, "", -tilt),
    spot(leftArea, "left", VB_W - xRight, y, hw, hh, shape, "", tilt),
  ];
}

// Plain face. The chip row sits in the gap under the chin, not out in empty space.
const head = spot("head", null, MID, 50, 56, 52, "plain");
const nose = spot("nose", null, 112, 104, 48, TAP_H, "chip", "Nose");
const mouth = spot("mouth", null, VB_W - 112, 104, 48, TAP_H, "chip", "Mouth");

// Arms hang just clear of the hips. Muscles fill the segment between joints.
const arms = [
  ...sided("Shoulder", 160, 102, "joint"),
  ...sided("muscleArm", 210, 86, "zone", TAP_W, TAP_H, 16),
  ...sided("Elbow", 260, 74, "joint"),
  ...sided("Wrist", 310, 66, "joint"),
  ...sided("Hand", 360, 60, "joint", 48, TAP_H),
];
const legs = [
  ...sided("Hip", 376, 116, "joint", 44, TAP_H),
  ...sided("muscleThigh", 426, 114, "zone", 48, TAP_H, 3),
  ...sided("Knee", 476, 110, "joint"),
  ...sided("muscleCalf", 526, 108, "zone", TAP_W, TAP_H, 2),
  ...sided("Ankle", 576, 106, "joint"),
  ...sided("Foot", 626, 100, "joint", 54, TAP_H),
];
const foot = legs.find(h => h.area === "rightFoot");
const shoulder = arms.find(h => h.area === "rightShoulder");
const stomach = spot("stomach", null, MID, 248, TAP_H, 60, "quiet", "Stomach");

export const FIGURE = { w: VB_W, h: Math.ceil(foot.cy + foot.hh / 2 + 18), midX: MID };

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

// Patient's right half, from the center of the neck to the center of the crotch.
// Control points stay close to the curve so the stroke does not wobble.
const NECK = [MID, 74];
const RIGHT_HALF = [
  [[132, 94], [116, 114], [102, 132]],
  [[92, 142], [84, 152], [78, 168]],
  [[70, 198], [62, 232], [58, 262]],
  [[54, 290], [50, 312], [50, 332]],
  [[50, 346], [54, 360], [64, 368]],
  [[74, 376], [86, 370], [90, 354]],
  [[94, 326], [102, 288], [110, 252]],
  [[116, 222], [122, 200], [118, 182]],
  [[116, 204], [110, 232], [112, 260]],
  [[116, 300], [106, 334], [98, 368]],
  [[90, 408], [86, 446], [88, 482]],
  [[90, 518], [92, 556], [98, 586]],
  [[100, 604], [86, 616], [78, 626]],
  [[84, 638], [110, 640], [126, 628]],
  [[124, 596], [122, 554], [120, 514]],
  [[118, 472], [122, 428], [128, 404]],
  [[134, 398], [138, 402], [MID, 400]],
];

function mirrorHalf(segs) {
  const out = [];
  let prev = NECK;
  const ends = [];
  for (const seg of segs) {
    ends.push(prev);
    prev = seg[2];
  }
  for (let i = segs.length - 1; i >= 0; i--) {
    const [c1, c2] = segs[i];
    const end = ends[i];
    out.push([
      [VB_W - c2[0], c2[1]],
      [VB_W - c1[0], c1[1]],
      [VB_W - end[0], end[1]],
    ]);
  }
  return out;
}

function cubics(segs) {
  return segs.map(([c1, c2, p]) => `C ${n(c1[0])} ${n(c1[1])}, ${n(c2[0])} ${n(c2[1])}, ${n(p[0])} ${n(p[1])}`).join(" ");
}

function silhouette() {
  const d = `M ${n(NECK[0])} ${n(NECK[1])} ${cubics(RIGHT_HALF)} ${cubics(mirrorHalf(RIGHT_HALF))} Z`;
  return `<g class="person"><path d="${d}"/><ellipse cx="${MID}" cy="46" rx="28" ry="32"/></g>`;
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
  else if (h.shape === "quiet" && pressed) inner = esc(h.text);
  return `<button type="button" class="body-hit ${h.shape}" data-act="ev-area" data-area="${h.area}" data-side="${h.side || ""}" aria-pressed="${pressed ? "true" : "false"}" aria-label="${esc(hotspotName(h))}" style="${style}">${inner}</button>`;
}

/**
 * Figure, Left/Right labels beside the shoulders, the hint, and the selected name.
 * `tone` is "bad" for a bleed (danger color) and "accent" otherwise.
 */
export function bodyMapHtml(selected, tone = "accent") {
  const area = BODY_AREAS[selected] ? selected : "";
  const toneName = tone === "bad" ? "bad" : "accent";
  const labelY = (shoulder.cy / FIGURE.h * 100).toFixed(2);
  const rightX = ((shoulder.cx - 50) / FIGURE.w * 100).toFixed(2);
  const leftX = ((VB_W - (shoulder.cx - 50)) / FIGURE.w * 100).toFixed(2);
  return `<div class="body-map">
    <div class="body-fig" data-tone="${toneName}" role="group" aria-labelledby="ev-where" style="aspect-ratio:${FIGURE.w} / ${FIGURE.h}">
      <svg viewBox="0 0 ${FIGURE.w} ${FIGURE.h}" aria-hidden="true">${silhouette()}</svg>
      <span class="body-side patient-right" style="left:${rightX}%;top:${labelY}%">Right</span>
      <span class="body-side patient-left" style="left:${leftX}%;top:${labelY}%">Left</span>
      ${BODY_HOTSPOTS.map(h => hitButton(h, area)).join("")}
    </div>
    <p class="body-picked${area ? " on" : ""}" aria-live="polite">${area ? esc(BODY_AREAS[area]) : ""}</p>
    <p class="muted small body-hint" id="ev-body-hint">Tap where it happened</p>
    <p class="muted small body-hint">Left and Right are this person's own sides.</p>
  </div>`;
}
