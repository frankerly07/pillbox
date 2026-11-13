import { BODY_AREAS, esc } from "./model.js";
import chart from "./assets/body-map/points.json";
import maleSvg from "./assets/body-map/male.svg?raw";
import femaleSvg from "./assets/body-map/female.svg?raw";

/**
 * Front-facing body diagram for the log-event sheet.
 *
 * The outlines and tap points are Zella Design's figures
 * (src/assets/body-map). viewBox is 0 0 200 520. Left and right in the
 * point file are the figure's own sides, so the figure's left is on the
 * viewer's right. Male and female use the same area ids and different
 * coordinates.
 *
 * The shin dots keep the leftCalf / rightCalf ids. Older logs stay
 * readable: the neck was saved as Head, the forearm as the wrist, and the
 * shin as Muscle (calf). The unsided muscle ids light up both new sides
 * when that side is on the chart. Nose, mouth, upper arm, and lower stomach
 * stay in the list; this chart has no dot for them.
 *
 * Each dot is a button of at least 44px. The outline and the chest line
 * do not receive taps.
 */

const BODY_W = 200;
const BODY_H = 520;
/** Room beside the outline so the short labels are not clipped. */
const PAD_X = 30;

export const FIGURE = { w: BODY_W + PAD_X * 2, h: BODY_H, midX: BODY_W / 2, minX: -PAD_X };

const SHORT = {
  head: "Head", neck: "Neck", chest: "Chest", stomach: "Stomach", groin: "Groin",
  shoulder: "Shoulder", elbow: "Elbow", forearm: "Forearm", wrist: "Wrist",
  hand: "Hand", hip: "Hip", thigh: "Thigh", knee: "Knee", shin: "Shin",
  ankle: "Ankle", foot: "Foot",
};

const AREA_ID = {
  head: "head", neck: "neck", chest: "chest", stomach: "stomach", groin: "groin",
  shoulder: { left: "leftShoulder", right: "rightShoulder" },
  elbow: { left: "leftElbow", right: "rightElbow" },
  forearm: { left: "leftForearm", right: "rightForearm" },
  wrist: { left: "leftWrist", right: "rightWrist" },
  hand: { left: "leftHand", right: "rightHand" },
  hip: { left: "leftHip", right: "rightHip" },
  thigh: { left: "leftThigh", right: "rightThigh" },
  knee: { left: "leftKnee", right: "rightKnee" },
  shin: { left: "leftCalf", right: "rightCalf" },
  ankle: { left: "leftAnkle", right: "rightAnkle" },
  foot: { left: "leftFoot", right: "rightFoot" },
};

function pathById(svg, id) {
  const m = svg.match(new RegExp(`id="${id}"[\\s\\S]*?d="([^"]+)"`));
  if (!m) throw new Error("body map svg is missing #" + id);
  return m[1];
}

const ART = {
  male: { outline: pathById(maleSvg, "outline"), chest: pathById(maleSvg, "chest-line") },
  female: { outline: pathById(femaleSvg, "outline"), chest: pathById(femaleSvg, "chest-line") },
};

export const BODY_FIGURES = ["male", "female"];

/** "female" or "male". Anything else, including a missing value, is male. */
export function normalizeFigure(figure) {
  return figure === "female" ? "female" : "male";
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

/** ViewBox units that equal at least 44px at the narrowest phone the tests check. */
const HIT = 44 * FIGURE.w / figureDisplayWidth(360) + 0.05;

function hotspot(point) {
  const center = point.side === "center";
  return {
    area: center ? AREA_ID[point.label] : AREA_ID[point.label][point.side],
    side: center ? null : point.side,
    cx: point.x,
    cy: point.y,
    hw: HIT,
    hh: HIT,
    text: SHORT[point.label],
    // Limb names sit outside the arm or leg. Chest sits above its dot so it
    // clears the pectoral line. Groin sits above its dot so it clears the hips.
    anchor: point.label === "groin" || point.label === "chest" ? "above" : point.side === "right" ? "start" : "end",
    point: point.label,
  };
}

/** Tap points for one figure, in the design file's order. */
export function hotspotsFor(figure) {
  return chart[normalizeFigure(figure)].points.map(hotspot);
}

/** Male points. Female coordinates differ; use hotspotsFor when the figure matters. */
export const BODY_HOTSPOTS = hotspotsFor("male");

/** Area ids a tap can set. Both figures expose the same ids. */
export function bodyAreasOnFigure() {
  return [...new Set(BODY_HOTSPOTS.map(h => h.area))];
}

/** BODY_AREAS keys with no figure target. Picked from the list. */
export function bodyAreasListOnly() {
  const on = new Set(bodyAreasOnFigure());
  return Object.keys(BODY_AREAS).filter(k => !on.has(k));
}

/**
 * Older unsided muscle marks. A saved value still has its name. Thigh and
 * shin light up both new sides. The upper arm has no dot on this chart, so
 * Muscle (arm) stays readable without a highlighted point. The neck was
 * stored as Head, the forearm as the wrist, and the shin as Muscle (calf).
 */
export const BODY_AREA_ALIASES = {
  muscleArm: ["leftUpperArm", "rightUpperArm"],
  muscleThigh: ["leftThigh", "rightThigh"],
  muscleCalf: ["leftCalf", "rightCalf"],
};

/** Dot ids that should look selected for a stored area, including an older alias. */
export function selectionTargets(area) {
  if (BODY_AREA_ALIASES[area]) return BODY_AREA_ALIASES[area];
  return BODY_AREAS[area] ? [area] : [];
}

/** Spoken name for one hotspot. */
export function hotspotName(h) {
  return BODY_AREAS[h.area] || "";
}

const LABEL_CHAR = 6.4;
const LABEL_H = 12;
const LABEL_GAP = 8;

/** Where the short label sits, in the design's viewBox units. */
export function labelBox(h) {
  const w = Math.max(String(h.text || "").length, 1) * LABEL_CHAR;
  const half = LABEL_H / 2;
  if (h.anchor === "start") return { l: h.cx - LABEL_GAP - w, r: h.cx - LABEL_GAP, t: h.cy - half, b: h.cy + half };
  if (h.anchor === "above") return { l: h.cx - w / 2, r: h.cx + w / 2, t: h.cy - LABEL_GAP - LABEL_H, b: h.cy - LABEL_GAP };
  return { l: h.cx + LABEL_GAP, r: h.cx + LABEL_GAP + w, t: h.cy - half, b: h.cy + half };
}

/**
 * Area after a tap. Tapping the selected area again clears it.
 * Unknown ids are ignored so a bad target cannot be stored.
 */
export function areaAfterTap(current, hit) {
  if (!BODY_AREAS[hit]) return BODY_AREAS[current] ? current : "";
  return current === hit ? "" : hit;
}

/** Hit size in CSS pixels when the figure is `figureCssWidth` wide. */
export function hitCssPx(h, figureCssWidth) {
  const scale = figureCssWidth / FIGURE.w;
  return { w: h.hw * scale, h: h.hh * scale };
}

function flattenCubic(cx, cy, x1, y1, x2, y2, x, y, steps, out) {
  for (let s = 1; s <= steps; s++) {
    const u = s / steps, v = 1 - u;
    out.push([
      v * v * v * cx + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x,
      v * v * v * cy + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y,
    ]);
  }
}

function outlinePoly(d) {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+/g) || [];
  let i = 0, cx = 0, cy = 0, poly = [];
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const t = tokens[i++];
    if (t === "M") { cx = num(); cy = num(); poly.push([cx, cy]); }
    else if (t === "C") {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      flattenCubic(cx, cy, x1, y1, x2, y2, x, y, 10, poly);
      cx = x; cy = y;
    } else if (t === "Z") break;
  }
  return poly;
}

const OUTLINES = {
  male: outlinePoly(ART.male.outline),
  female: outlinePoly(ART.female.outline),
};

function pointIn(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** True when (x, y) lies inside this figure's outline. Coordinates are the design viewBox. */
export function figureContains(figure, x, y) {
  return pointIn(OUTLINES[normalizeFigure(figure)], x, y);
}

function silhouette(figure) {
  const art = ART[normalizeFigure(figure)];
  return `<g class="person"><path class="outline" d="${art.outline}"/><path class="chest" fill="none" d="${art.chest}"/></g>`;
}

function hitButton(h, selectedIds) {
  const pressed = selectedIds.has(h.area);
  const style = [
    `left:${((h.cx - FIGURE.minX) / FIGURE.w * 100).toFixed(2)}%`,
    `top:${(h.cy / FIGURE.h * 100).toFixed(2)}%`,
    `width:${(h.hw / FIGURE.w * 100).toFixed(2)}%`,
    `height:${(h.hh / FIGURE.h * 100).toFixed(2)}%`,
  ].join(";");
  return `<button type="button" class="body-hit dot" data-act="ev-area" data-area="${h.area}" data-side="${h.side || ""}" aria-pressed="${pressed ? "true" : "false"}" aria-label="${esc(hotspotName(h))}" style="${style}"><span class="mark"></span><span class="name pos-${h.anchor}">${esc(h.text)}</span></button>`;
}

/**
 * Figure, short labels beside the dots, the hint, and the selected name.
 * `tone` is "bad" for a bleed and "accent" otherwise. `figure` is "female" or "male".
 */
export function bodyMapHtml(selected, tone = "accent", figure = "male") {
  const area = BODY_AREAS[selected] ? selected : "";
  const targets = new Set(selectionTargets(area));
  const toneName = tone === "bad" ? "bad" : "accent";
  const sex = normalizeFigure(figure);
  const spots = hotspotsFor(sex);
  return `<div class="body-map">
    <div class="body-fig" data-tone="${toneName}" data-figure="${sex}" role="group" aria-labelledby="ev-where" style="aspect-ratio:${FIGURE.w} / ${FIGURE.h}">
      <svg viewBox="${FIGURE.minX} 0 ${FIGURE.w} ${FIGURE.h}" aria-hidden="true">${silhouette(sex)}</svg>
      ${spots.map(h => hitButton(h, targets)).join("")}
    </div>
    <p class="body-picked${area ? " on" : ""}" aria-live="polite">${area ? "Selected: " + esc(BODY_AREAS[area]) : ""}</p>
    <p class="muted small body-hint" id="ev-body-hint">Tap where it happened</p>
    <p class="muted small body-hint">Left and Right are this person's own sides.</p>
  </div>`;
}
