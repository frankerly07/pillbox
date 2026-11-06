import { BODY_AREAS, esc } from "./model.js";

/**
 * Front-facing body dummy for the log-event sheet.
 *
 * The figure faces the viewer, so the patient's left is on the viewer's right.
 * "Left" and "Right" are labeled on those sides. Every hotspot stores a key that
 * already exists in BODY_AREAS — taps do not invent area ids.
 *
 * Nose and mouth/gums are labeled buttons beside the jaw, not drawn on the face.
 * A target on the face itself would be too small to tap and would cover Head.
 * "Other" stays in the list only. Muscle (thigh), muscle (calf), and muscle (arm)
 * have no left/right id, so each one is drawn on both limbs and either tap stores
 * that same key.
 */

const TAP = 44;
const GAP = 4;
const STEP = TAP + GAP;
const VB_W = 300;
const MID = VB_W / 2;

const ARM_X = { right: 46, left: VB_W - 46 };
const LEG_X = { right: 114, left: VB_W - 114 };

function spot(area, side, cx, cy, hw, hh, shape, text = "") {
  return { area, side, cx, cy, hw, hh, shape, text };
}

const head = spot("head", null, MID, 72, 64, 64, "circle");
// Beside the jaw: large enough to tap, and clear of the Head button.
const nose = spot("nose", null, 74, 86, 60, TAP, "round", "Nose");
const mouth = spot("mouth", null, VB_W - 74, 86, 60, TAP, "round", "Mouth");

const armParts = [
  ["Shoulder", "circle", "Shoulder"],
  ["muscleArm", "round", "Arm"],
  ["Elbow", "circle", "Elbow"],
  ["Wrist", "circle", "Wrist"],
  ["Hand", "circle", "Hand"],
];
const legParts = [
  ["Hip", "circle", "Hip"],
  ["muscleThigh", "round", "Thigh"],
  ["Knee", "circle", "Knee"],
  ["muscleCalf", "round", "Calf"],
  ["Ankle", "circle", "Ankle"],
  ["Foot", "circle", "Foot"],
];

function stack(parts, side, cx, yTop) {
  return parts.map(([part, shape, text], i) => spot(
    part.startsWith("muscle") ? part : side + part,
    side, cx, yTop + TAP / 2 + i * STEP, TAP, TAP, shape, text,
  ));
}

const armTop = Math.max(nose.cy + nose.hh / 2, mouth.cy + mouth.hh / 2, head.cy + head.hh / 2) + 16;
const arms = ["right", "left"].flatMap(side => stack(armParts, side, ARM_X[side], armTop));
const hand = arms.find(h => h.area === "rightHand");
// Hips share a row with the hands, so the legs do not add another gap under the arms.
const legs = ["right", "left"].flatMap(side => stack(legParts, side, LEG_X[side], hand.cy - TAP / 2));

const shoulder = arms.find(h => h.area === "rightShoulder");
const hip = legs.find(h => h.area === "rightHip");
const stomachTop = shoulder.cy + TAP / 2 + GAP;
const stomachBottom = hip.cy - TAP / 2 - GAP;
const stomach = spot(
  "stomach", null, MID, (stomachTop + stomachBottom) / 2,
  112, stomachBottom - stomachTop, "round", "Stomach",
);

const foot = legs.find(h => h.area === "rightFoot");

export const FIGURE = { w: VB_W, h: Math.ceil(foot.cy + foot.hh / 2 + 14), midX: MID };

/** Reading order: top to bottom, then the viewer's left to right. */
export const BODY_HOTSPOTS = [head, nose, mouth, ...arms, stomach, ...legs]
  .sort((a, b) => a.cy - b.cy || a.cx - b.cx);

const ARM_AREAS = new Set(["rightShoulder", "leftShoulder", "muscleArm", "rightElbow", "leftElbow", "rightWrist", "leftWrist", "rightHand", "leftHand"]);
const LEG_AREAS = new Set(["rightHip", "leftHip", "muscleThigh", "rightKnee", "leftKnee", "muscleCalf", "rightAnkle", "leftAnkle", "rightFoot", "leftFoot"]);

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

function limbCapsule(side, areas, pad = 6) {
  const spots = BODY_HOTSPOTS.filter(h => h.side === side && areas.has(h.area));
  const l = Math.min(...spots.map(s => s.cx - s.hw / 2)) - pad;
  const r = Math.max(...spots.map(s => s.cx + s.hw / 2)) + pad;
  const t = Math.min(...spots.map(s => s.cy - s.hh / 2)) - pad;
  const b = Math.max(...spots.map(s => s.cy + s.hh / 2)) + pad;
  const w = r - l;
  return { x: l, y: t, w, h: b - t, rx: w / 2 };
}

function torsoShape() {
  const hips = BODY_HOTSPOTS.filter(h => h.area === "leftHip" || h.area === "rightHip");
  const shoulders = BODY_HOTSPOTS.filter(h => h.area === "leftShoulder" || h.area === "rightShoulder");
  const top = Math.min(...shoulders.map(s => s.cy)) - 16;
  const bottom = Math.max(...hips.map(s => s.cy + s.hh / 2)) + 8;
  const w = 118;
  return { x: MID - w / 2, y: top, w, h: bottom - top, rx: 42 };
}

function rect(box) {
  return `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" rx="${n(box.rx)}"/>`;
}

function silhouette() {
  const headS = BODY_HOTSPOTS.find(h => h.area === "head");
  const torso = torsoShape();
  const neckW = 28;
  const neckTop = headS.cy + headS.hh / 2 - 6;
  const neck = { x: MID - neckW / 2, y: neckTop, w: neckW, h: torso.y + 18 - neckTop, rx: 12 };
  const rightArm = limbCapsule("right", ARM_AREAS);
  const leftArm = limbCapsule("left", ARM_AREAS);
  const shoulderY = BODY_HOTSPOTS.find(h => h.area === "rightShoulder").cy;
  // Same fill as the limbs, tucked under the arm and torso strokes.
  const bridge = (x1, x2) => {
    const l = Math.min(x1, x2), w = Math.abs(x2 - x1), h = 22;
    return rect({ x: l, y: shoulderY - h / 2, w, h, rx: 11 });
  };
  return `<g style="fill:var(--sunk);stroke:currentColor" stroke-width="2">
    ${bridge(rightArm.x + rightArm.w - 8, torso.x + 10)}
    ${bridge(torso.x + torso.w - 10, leftArm.x + 8)}
    ${rect(limbCapsule("right", LEG_AREAS))}
    ${rect(limbCapsule("left", LEG_AREAS))}
    ${rect(torso)}
    ${rect(rightArm)}
    ${rect(leftArm)}
    ${rect(neck)}
    <circle cx="${n(headS.cx)}" cy="${n(headS.cy)}" r="${n(headS.hw / 2 + 5)}"/>
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
  const inner = h.area === "head"
    ? `<span class="face" aria-hidden="true"><i></i><i></i></span>`
    : esc(h.text);
  return `<button type="button" class="body-hit ${h.shape}" data-act="ev-area" data-area="${h.area}" data-side="${h.side || ""}" aria-pressed="${pressed ? "true" : "false"}" aria-label="${esc(hotspotName(h))}" style="${style}">${inner}</button>`;
}

/** Figure, Left/Right labels, and the line that names the current area. */
export function bodyMapHtml(selected) {
  const area = BODY_AREAS[selected] ? selected : "";
  const rightX = ((ARM_X.right + LEG_X.right) / 2 / FIGURE.w * 100).toFixed(2);
  const leftX = ((ARM_X.left + LEG_X.left) / 2 / FIGURE.w * 100).toFixed(2);
  const picked = area ? "Selected: " + BODY_AREAS[area] : "Tap where it happened";
  return `<div class="body-map">
    <p class="muted small body-hint" id="ev-body-hint">Left and Right are this person's own sides. Tap a spot again to clear it.</p>
    <div class="body-fig" role="group" aria-labelledby="ev-where" style="aspect-ratio:${FIGURE.w} / ${FIGURE.h}">
      <svg viewBox="0 0 ${FIGURE.w} ${FIGURE.h}" aria-hidden="true">${silhouette()}</svg>
      <span class="body-side patient-right" style="left:${rightX}%">Right</span>
      <span class="body-side patient-left" style="left:${leftX}%">Left</span>
      ${BODY_HOTSPOTS.map(h => hitButton(h, area)).join("")}
    </div>
    <p class="body-picked${area ? " on" : " muted"}" aria-live="polite">${esc(picked)}</p>
  </div>`;
}
