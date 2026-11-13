import { BODY_AREAS, esc } from "./model.js";

/**
 * Front-facing body diagram for the log-event sheet.
 *
 * The figure faces the viewer, so the patient's left is on the viewer's right.
 * Male and female outlines differ in the shoulders, chest, waist, and pelvis.
 * They share the same hotspot positions and BODY_AREAS keys, so a saved event
 * names the same place on either figure. "Other" stays in the list only.
 *
 * The arms are separate shapes. A gap runs from the armpit to the hand, and
 * the hands hang beside the thighs. Hit boxes cover the head, face, neck,
 * chest, abdomen, and each limb without overlapping, so a tap cannot fall
 * through a gap or be swallowed by a neighbor. The neck selects Head. The
 * forearm is part of the wrist target, and the shin is part of the calf.
 *
 * Decorative layers (the outline, side labels, muscle tints, chip text) do not
 * receive taps. Each hotspot is a button of at least 44px on a phone.
 * The drawing is about 7.5 heads tall, with a jaw rather than a circle.
 */

const VB_W = 300;
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

// Cranium only, so Nose and Mouth can sit on the lower face without covering it.
const head = spot("head", null, MID, 48, 66, 60, "region");
const nose = spot("nose", null, 128, 100, TAP, TAP, "chip", "Nose");
const mouth = spot("mouth", null, VB_W - 128, 100, TAP, TAP, "chip", "Mouth");
const neck = spot("head", null, MID, 146, 50, TAP, "region");

// Arms hang free of the torso. Hands are beside the thighs, not fused to the hip.
const arms = [
  ...sided("Shoulder", 192, 66, "joint", 48, 48),
  ...sided("muscleArm", 254, 56, "zone", 46, 76, 10),
  ...sided("Elbow", 314, 50, "joint"),
  ...sided("Wrist", 372, 48, "joint", TAP, 72),
  ...sided("Hand", 430, 52, "joint", 48, TAP),
];
const legs = [
  ...sided("Hip", 434, 118, "joint", 64, 56),
  ...sided("muscleThigh", 506, 116, "zone", 52, 88, 2),
  ...sided("Knee", 572, 114, "joint"),
  ...sided("muscleCalf", 634, 112, "zone", 48, 80, 1),
  ...sided("Ankle", 696, 110, "joint"),
  ...sided("Foot", 742, 102, "joint", 60, 48),
];
const foot = legs.find(h => h.area === "rightFoot");
const shoulder = arms.find(h => h.area === "rightShoulder");
const chest = spot("chest", null, MID, 236, 100, 120, "region", "Chest");
const stomach = spot("stomach", null, MID, 351, 80, 110, "region", "Stomach");

export const FIGURE = { w: VB_W, h: Math.ceil(foot.cy + foot.hh / 2 + 14), midX: MID };
export const BODY_FIGURES = ["male", "female"];

/** "female" or "male". Anything else, including a missing value, is male. */
export function normalizeFigure(figure) {
  return figure === "female" ? "female" : "male";
}

/** Reading order: top to bottom, then the viewer's left to right. */
export const BODY_HOTSPOTS = [head, nose, mouth, neck, ...arms, chest, stomach, ...legs]
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

function smoothClosed(points) {
  const count = points.length;
  const segs = [];
  for (let i = 0; i < count; i++) {
    const p0 = points[(i - 1 + count) % count];
    const p1 = points[i];
    const p2 = points[(i + 1) % count];
    const p3 = points[(i + 2) % count];
    segs.push([
      [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      p2,
    ]);
  }
  return { start: points[0], segs };
}

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

function pathFrom(start, segs) {
  return `M ${n(start[0])} ${n(start[1])} ${cubics(segs)} Z`;
}

function openSegs(points) {
  const open = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    open.push([
      [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      p2,
    ]);
  }
  return open;
}

function halfPath(points) {
  return `<path d="${pathFrom(points[0], openSegs(points).concat(mirrorHalf(openSegs(points), points[0])))}"/>`;
}

// Patient's right arm, closed. The deltoid overlaps the shoulder; below the
// armpit the inner edge stays clear of the torso, and the hand ends at the thigh.
const RIGHT_ARM = [
  [98, 176], [78, 164], [58, 172], [46, 192],
  [40, 230], [36, 290], [34, 350], [36, 400],
  [42, 424], [58, 438], [74, 428],
  [78, 400], [80, 340], [84, 280], [90, 220], [98, 188],
];

// Torso and legs. The arm is not part of this outline.
const MALE_BODY = [
  [132, 78], [126, 112], [122, 148], [110, 168], [104, 196],
  [110, 230], [114, 280], [116, 330], [106, 370], [98, 410],
  [94, 470], [96, 530], [102, 575], [98, 640], [104, 690],
  [96, 712], [78, 732], [108, 748], [130, 734],
  [120, 690], [116, 630], [118, 560], [122, 490], [128, 430],
  [136, 390], [140, 372],
];
const FEMALE_BODY = [
  [134, 78], [128, 112], [124, 146], [114, 164], [108, 190],
  [100, 214], [108, 245], [122, 285], [116, 325], [98, 365],
  [84, 415], [82, 480], [86, 545], [92, 600], [98, 655], [102, 695],
  [92, 716], [74, 736], [108, 752], [134, 738],
  [126, 695], [128, 630], [130, 570], [132, 490], [134, 430],
  [130, 385], [140, 370],
];

const HEAD = [
  [150, 18], [178, 24], [194, 46], [192, 70], [184, 90],
  [170, 108], [150, 120], [130, 108], [116, 90], [108, 70],
  [106, 46], [122, 24],
];

function closedPath(points) {
  const { start, segs } = smoothClosed(points);
  return `<path d="${pathFrom(start, segs)}"/>`;
}

function mapX(points, fn) {
  return points.map(([x, y]) => [fn(x), y]);
}

function flatten(start, segs, steps = 8) {
  const pts = [[start[0], start[1]]];
  let prev = start;
  for (const [c1, c2, p] of segs) {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      pts.push([
        u * u * u * prev[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p[0],
        u * u * u * prev[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p[1],
      ]);
    }
    prev = p;
  }
  return pts;
}

function pointIn(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function shapePolys(figure) {
  const body = figure === "female" ? FEMALE_BODY : MALE_BODY;
  const bodySegs = openSegs(body).concat(mirrorHalf(openSegs(body), body[0]));
  const arm = smoothClosed(RIGHT_ARM);
  const head = smoothClosed(HEAD);
  const armLeftSegs = arm.segs.map(([c1, c2, p]) => [[VB_W - c1[0], c1[1]], [VB_W - c2[0], c2[1]], [VB_W - p[0], p[1]]]);
  return [
    flatten(body[0], bodySegs),
    flatten(arm.start, arm.segs),
    flatten([VB_W - arm.start[0], arm.start[1]], armLeftSegs),
    flatten(head.start, head.segs),
  ];
}

/** True when (x, y) lies on the head, an arm, or the torso of this figure. */
export function figureContains(figure, x, y) {
  return shapePolys(normalizeFigure(figure)).some(poly => pointIn(poly, x, y));
}

function detail(figure) {
  // One open line. Male marks the pectoral border; female sits lower, under the bust.
  const y = figure === "female" ? 236 : 218;
  const drop = figure === "female" ? 10 : 6;
  const d = `M 116 ${y} C 132 ${y + drop}, 168 ${y + drop}, 184 ${y}`;
  return `<path class="detail" fill="none" stroke="var(--body-stroke)" stroke-width="1.25" d="${d}"/>`;
}

function silhouette(figure) {
  const body = figure === "female" ? FEMALE_BODY : MALE_BODY;
  const arm = closedPath(RIGHT_ARM);
  const armLeft = closedPath(mapX(RIGHT_ARM, x => VB_W - x));
  return `<g class="person">${halfPath(body)}${closedPath(HEAD)}${arm}${armLeft}</g>${detail(figure)}`;
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
  return `<button type="button" class="body-hit ${h.shape}" data-act="ev-area" data-area="${h.area}" data-side="${h.side || ""}" aria-pressed="${pressed ? "true" : "false"}" aria-label="${esc(hotspotName(h))}" style="${style}">${inner}</button>`;
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
  const rightX = ((shoulder.cx - 42) / FIGURE.w * 100).toFixed(2);
  const leftX = ((VB_W - (shoulder.cx - 42)) / FIGURE.w * 100).toFixed(2);
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
