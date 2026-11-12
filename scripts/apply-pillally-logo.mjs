/**
 * Build Android launcher, splash, and notification resources plus the web icons
 * from brand/pillally/. Resizes, centers, and (for legacy round icons and
 * previews) masks. It does not redraw or recolor the mark.
 *
 *   node scripts/apply-pillally-logo.mjs
 *   node scripts/apply-pillally-logo.mjs --previews /path/to/dir
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = new URL("..", import.meta.url).pathname;
const brand = join(root, "brand/pillally");
const res = join(root, "android/app/src/main/res");
const NAVY = { r: 0x03, g: 0x04, b: 0x23, alpha: 1 };
const LAUNCHER = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const SPLASHES = [
  ["drawable", 480, 320],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
];

function parseNotification(svg) {
  const m = svg.match(
    /<svg[^>]*viewBox="0 0 24 24"[^>]*>\s*<g transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.eE]+)\) translate\(([-\d.]+) ([-\d.]+)\)">\s*<path d="([^"]+)" fill="white" fill-rule="evenodd"\s*\/>\s*<\/g>\s*<\/svg>\s*$/,
  );
  if (!m) throw new Error("notification.svg structure changed; refusing to redraw the glyph");
  return { tx: m[1], ty: m[2], scale: m[3], ix: m[4], iy: m[5], d: m[6] };
}

function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function group(g, inner) {
  const attrs = [`android:translateX="${g.tx}"`, `android:translateY="${g.ty}"`];
  if (g.sx != null) attrs.push(`android:scaleX="${g.sx}"`, `android:scaleY="${g.sy}"`);
  return `    <group ${attrs.join(" ")}>\n${inner}\n    </group>`;
}

function vectorDrawable({ width, height, viewport, groups, d }) {
  const path = `        <path android:fillColor="#FFFFFF" android:fillType="evenOdd" android:pathData="${xmlEscape(d)}"/>`;
  const body = groups.reduceRight((inner, g) => group(g, inner), path);
  return `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${width}dp"
    android:height="${height}dp"
    android:viewportWidth="${viewport}"
    android:viewportHeight="${viewport}">
${body}
</vector>
`;
}

function adaptiveIcon(monochrome) {
  const mono = monochrome ? `    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>\n` : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
${mono}</adaptive-icon>
`;
}

function colorXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#030423</color>
</resources>
`;
}

async function writePng(file, buf) {
  mkdirSync(dirname(file), { recursive: true });
  await sharp(buf).png({ compressionLevel: 9 }).toFile(file);
}

async function corner(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2], data[3], info.width, info.height];
}

async function assertSameGlyph(notificationSvg, glyph) {
  const direct = await sharp(Buffer.from(notificationSvg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const nested = `
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <g transform="translate(${glyph.tx} ${glyph.ty}) scale(${glyph.scale})">
    <g transform="translate(${glyph.ix} ${glyph.iy})">
      <path d="${glyph.d}" fill="white" fill-rule="evenodd"/>
    </g>
  </g>
</svg>`;
  const rendered = await sharp(Buffer.from(nested)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (direct.info.width !== rendered.info.width || direct.info.height !== rendered.info.height) {
    throw new Error("notification vector transform does not match notification.svg");
  }
  for (let i = 0; i < direct.data.length; i++) {
    if (direct.data[i] !== rendered.data[i]) {
      throw new Error("notification vector transform does not match notification.svg");
    }
  }
}

async function circleMask(size, diameter) {
  const r = diameter / 2;
  const c = size / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="#fff"/></svg>`,
  );
}

async function main() {
  const icon = join(brand, "icon-1024.png");
  const foreground = join(brand, "foreground-1024.png");
  const splash = join(brand, "splash-1080.png");
  const notificationSvg = readFileSync(join(brand, "notification.svg"), "utf8");
  const glyph = parseNotification(notificationSvg);
  await assertSameGlyph(notificationSvg, glyph);

  const [ir, ig, ib, ia] = await corner(icon);
  if (ir !== 3 || ig !== 4 || ib !== 35 || ia !== 255) throw new Error("icon-1024.png background is not #030423");
  const [fr, fg, fb, fa] = await corner(foreground);
  if (fa !== 0) throw new Error("foreground-1024.png is not transparent outside the mark");
  if (fr !== 0 || fg !== 0 || fb !== 0) throw new Error("foreground-1024.png corner is not clear");
  const [sr, sg, sb] = await corner(splash);
  if (sr !== 3 || sg !== 4 || sb !== 35) throw new Error("splash-1080.png background is not #030423");

  for (const [density, size] of Object.entries(LAUNCHER)) {
    const dir = join(res, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    await sharp(icon).resize(size, size, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toFile(join(dir, "ic_launcher.png"));
    const round = await sharp(icon)
      .resize(size, size, { kernel: "lanczos3" })
      .ensureAlpha()
      .composite([{ input: await circleMask(size, size), blend: "dest-in" }])
      .png()
      .toBuffer();
    await writePng(join(dir, "ic_launcher_round.png"), round);
    await sharp(foreground).resize(FOREGROUND[density], FOREGROUND[density], { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toFile(join(dir, "ic_launcher_foreground.png"));
  }

  for (const [folder, w, h] of SPLASHES) {
    const meta = await sharp(splash).metadata();
    const scale = Math.min(w / meta.width, h / meta.height);
    const nw = Math.max(1, Math.round(meta.width * scale));
    const nh = Math.max(1, Math.round(meta.height * scale));
    const resized = await sharp(splash).resize(nw, nh, { kernel: "lanczos3" }).png().toBuffer();
    const canvas = await sharp({
      create: { width: w, height: h, channels: 3, background: NAVY },
    })
      .composite([{ input: resized, left: Math.round((w - nw) / 2), top: Math.round((h - nh) / 2) }])
      .png()
      .toBuffer();
    await writePng(join(res, folder, "splash.png"), canvas);
  }

  const glyphGroups = [
    { tx: glyph.tx, ty: glyph.ty, sx: glyph.scale, sy: glyph.scale },
    { tx: glyph.ix, ty: glyph.iy },
  ];
  writeFileSync(
    join(res, "drawable/ic_stat_pill.xml"),
    vectorDrawable({ width: 24, height: 24, viewport: 24, groups: glyphGroups, d: glyph.d }),
  );
  // The 24-unit glyph sits in the adaptive-icon 66-unit safe zone on the 108 canvas.
  writeFileSync(
    join(res, "drawable/ic_launcher_monochrome.xml"),
    vectorDrawable({
      width: 108,
      height: 108,
      viewport: 108,
      groups: [{ tx: "21", ty: "21", sx: "2.75", sy: "2.75" }, ...glyphGroups],
      d: glyph.d,
    }),
  );

  const v26 = join(res, "mipmap-anydpi-v26");
  const v33 = join(res, "mipmap-anydpi-v33");
  mkdirSync(v26, { recursive: true });
  mkdirSync(v33, { recursive: true });
  for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
    writeFileSync(join(v26, name), adaptiveIcon(false));
    writeFileSync(join(v33, name), adaptiveIcon(true));
  }
  const background = colorXml();
  writeFileSync(join(res, "values/ic_launcher_background.xml"), background);
  writeFileSync(join(root, "android/app/src/caregiver/res/values/ic_launcher_background.xml"), background);

  copyFileSync(join(brand, "mark.svg"), join(root, "public/icon.svg"));
  copyFileSync(join(brand, "master-512.png"), join(root, "public/icon-512.png"));

  for (const obsolete of [
    join(res, "drawable/ic_pill_fg.xml"),
    join(res, "drawable/ic_launcher_background.xml"),
    join(res, "drawable-v24/ic_launcher_foreground.xml"),
  ]) {
    rmSync(obsolete, { force: true });
  }

  const launcherCorner = await corner(join(res, "mipmap-xxxhdpi/ic_launcher.png"));
  if (launcherCorner[0] !== 3 || launcherCorner[1] !== 4 || launcherCorner[2] !== 35) {
    throw new Error("resized launcher background drifted from #030423");
  }
  const roundCorner = await corner(join(res, "mipmap-xxxhdpi/ic_launcher_round.png"));
  if (roundCorner[3] !== 0) throw new Error("round launcher corner is not transparent");
  const splashCorner = await corner(join(res, "drawable-port-xxxhdpi/splash.png"));
  if (splashCorner[0] !== 3 || splashCorner[1] !== 4 || splashCorner[2] !== 35 || splashCorner[4] !== 1280 || splashCorner[5] !== 1920) {
    throw new Error("portrait splash was stretched or recolored");
  }

  const previewDir = process.argv.includes("--previews") ? process.argv[process.argv.indexOf("--previews") + 1] : "";
  if (previewDir) await writePreviews(previewDir, foreground, splash);
  console.log("PillAlly logo resources written from brand/pillally/");
}

async function maskedIcon(foreground, size, mask) {
  const fg = await sharp(foreground).resize(size, size, { kernel: "lanczos3" }).png().toBuffer();
  const composed = await sharp({
    create: { width: size, height: size, channels: 4, background: NAVY },
  })
    .composite([{ input: fg }])
    .png()
    .toBuffer();
  return sharp(composed).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
}

async function onGray(icon, size) {
  const canvas = size + 160;
  return sharp({
    create: { width: canvas, height: canvas, channels: 3, background: { r: 232, g: 234, b: 238 } },
  })
    .composite([{ input: icon, left: 80, top: 80 }])
    .png()
    .toBuffer();
}

async function writePreviews(dir, foreground, splash) {
  mkdirSync(dir, { recursive: true });
  const size = 1024;
  const circle = await maskedIcon(foreground, size, await circleMask(size, (size * 72) / 108));
  const squircle = await maskedIcon(
    foreground,
    size,
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100"><path fill="#fff" d="M50 0C10 0 0 10 0 50C0 90 10 100 50 100C90 100 100 90 100 50C100 10 90 0 50 0Z"/></svg>`),
  );
  await writePng(join(dir, "launcher-adaptive-circle.png"), await onGray(circle, size));
  await writePng(join(dir, "launcher-adaptive-squircle.png"), await onGray(squircle, size));

  copyFileSync(splash, join(dir, "splash-portrait.png"));
  const landW = 1920;
  const landH = 1080;
  const meta = await sharp(splash).metadata();
  const scale = Math.min(landW / meta.width, landH / meta.height);
  const nw = Math.round(meta.width * scale);
  const nh = Math.round(meta.height * scale);
  const resized = await sharp(splash).resize(nw, nh, { kernel: "lanczos3" }).png().toBuffer();
  const landscape = await sharp({ create: { width: landW, height: landH, channels: 3, background: NAVY } })
    .composite([{ input: resized, left: Math.round((landW - nw) / 2), top: Math.round((landH - nh) / 2) }])
    .png()
    .toBuffer();
  await writePng(join(dir, "splash-landscape.png"), landscape);

  // Android 12 splash slot on a 1080x1920 (xxhdpi) screen: 240dp icon, inner circle 160dp.
  const layer = 240 * 3;
  const splashIcon = await maskedIcon(foreground, layer, await circleMask(layer, (layer * 72) / 108));
  const android12 = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: NAVY } })
    .composite([{ input: splashIcon, left: Math.round((1080 - layer) / 2), top: Math.round((1920 - layer) / 2) }])
    .png()
    .toBuffer();
  await writePng(join(dir, "splash-android12.png"), android12);

  const note = await sharp(Buffer.from(readFileSync(join(brand, "notification.svg"))), { density: 72 * 12 })
    .resize(288, 288)
    .png()
    .toBuffer();
  const noteCard = await sharp({
    create: { width: 448, height: 448, channels: 4, background: { r: 3, g: 4, b: 35, alpha: 1 } },
  })
    .composite([{ input: note, left: 80, top: 80 }])
    .png()
    .toBuffer();
  await writePng(join(dir, "notification-glyph.png"), noteCard);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
