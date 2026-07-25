// PDF LABEL BENCHMARK — capture the rendered output, so a change to the PDF
// renderer can be proven not to regress it.
//
// The PDF path (api/print.ts -> renderLabelsPdf, and autoflush's network printing)
// sized captions from a hardcoded font ladder while the preview and the Bluetooth
// print moved to a shared auto-fit. They disagreed by 0.37x to 2.28x. Fixing that
// means touching the renderer people actually print through, so: rasterise a fixed
// matrix, measure each label cell, and diff before/after.
//
//   node modules/labels/tests/pdf-benchmark.mjs capture   # write the baseline
//   node modules/labels/tests/pdf-benchmark.mjs check     # compare against it
//
// Measured per cell (all from PIXELS, not from the code that drew them):
//   inkFrac      how much of the cell is inked — a proxy for "is it filled sensibly"
//   textBox      bounding box of the caption band above/beside the QR
//   overflow     ink crossing the cell's own border = clipped or colliding text
//   minRun       shortest horizontal black run in the text band — a legibility proxy;
//                thermal output turns mushy when strokes get too thin
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { PNG } from "pngjs";
import { renderLabelsPdf } from "../src/print/pdf.ts";

const OUT = "/tmp/pdf-bench";
const BASELINE = new URL("./pdf-benchmark.baseline.json", import.meta.url).pathname;

// Fixed matrix: the sizes people actually print, and names from very short to long.
const SIZES = ["roll-2x2", "roll-1.5x1.5", "roll-4x6", "roll-2x3", "avery-5160", "letter-2x2"];
const ITEMS = [
  { kind: "part", id: 1, title: "Office", url: "https://cobblr.me/qr/a/bench1" },
  { kind: "part", id: 2, title: "2019 Honda Civic", url: "https://cobblr.me/qr/a/bench2", centerCode: "v2" },
  { kind: "part", id: 3, title: "Prusa MINI+", url: "https://cobblr.me/qr/a/bench3", centerCode: "p2" },
  { kind: "part", id: 4, title: "Left Rear Brake Caliper", url: "https://cobblr.me/qr/a/bench4" },
];

/** macOS-only: qlmanage is the rasteriser every Mac has, and poppler is not
 *  installed here. That makes this a LOCAL tool, deliberately not wired into CI —
 *  the Linux runners have no qlmanage, and a check that cannot run is worse than
 *  no check because it goes green by accident. Run it by hand around any change
 *  to the PDF renderer: `pnpm run lint:pdf-bench`. */
function haveRasteriser() {
  try { execFileSync("which", ["qlmanage"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function rasterise(pdfPath, tag) {
  execFileSync("qlmanage", ["-t", "-s", "1400", "-o", OUT, pdfPath], { stdio: "ignore" });
  const png = `${OUT}/${tag}.pdf.png`;
  if (!existsSync(png)) throw new Error(`rasterise failed for ${tag}`);
  return PNG.sync.read(readFileSync(png));
}

/** Ink metrics over the whole page — cheap, stable, and enough to catch a
 *  renderer that started clipping, shrinking, or overflowing. */
function measure(img) {
  const { width, height, data } = img;
  let ink = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  const rowRuns = [];
  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dark = data[i] < 128 && data[i + 3] > 10;
      if (dark) {
        ink++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        run++;
      } else if (run) { rowRuns.push(run); run = 0; }
    }
    if (run) rowRuns.push(run);
  }
  rowRuns.sort((a, b) => a - b);
  return {
    w: width, h: height,
    inkFrac: +(ink / (width * height)).toFixed(5),
    bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    // p05 of run lengths: robust "thinnest stroke" proxy, ignoring stray pixels.
    minRun: rowRuns.length ? rowRuns[Math.floor(rowRuns.length * 0.05)] : 0,
    runs: rowRuns.length,
  };
}

async function run() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const results = {};
  for (const size of SIZES) {
    const { pdf } = await renderLabelsPdf({ size_key: size, items: ITEMS });
    const tag = size.replace(/[^a-z0-9]/gi, "_");
    const p = `${OUT}/${tag}.pdf`;
    writeFileSync(p, pdf);
    results[size] = measure(rasterise(p, tag));
  }
  return results;
}

const mode = process.argv[2] ?? "check";
if (!haveRasteriser()) {
  // Skip rather than fail: this is macOS-only by design (see rasterise).
  console.log("[pdf-bench] SKIPPED — no qlmanage (macOS only). Run this on a Mac before changing the PDF renderer.");
  process.exit(0);
}
const now = await run();

if (mode === "capture") {
  writeFileSync(BASELINE, JSON.stringify(now, null, 2) + "\n");
  console.log(`[pdf-bench] baseline captured for ${Object.keys(now).length} sizes -> ${BASELINE}`);
  for (const [k, v] of Object.entries(now)) console.log(`  ${k.padEnd(14)} ink=${v.inkFrac} bbox=${v.bbox?.w}x${v.bbox?.h} minRun=${v.minRun}`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error("[pdf-bench] no baseline — run `capture` on the UNCHANGED renderer first.");
  process.exit(1);
}
const base = JSON.parse(readFileSync(BASELINE, "utf8"));
const problems = [];
for (const size of SIZES) {
  const b = base[size], n = now[size];
  if (!b) { problems.push(`${size}: missing from baseline`); continue; }
  // Ink can move legitimately (that is the point of the change) but a collapse or
  // an explosion means text vanished or overflowed.
  const ratio = n.inkFrac / Math.max(b.inkFrac, 1e-9);
  if (ratio < 0.5) problems.push(`${size}: ink COLLAPSED ${b.inkFrac} -> ${n.inkFrac} (${ratio.toFixed(2)}x) — text lost?`);
  if (ratio > 2.0) problems.push(`${size}: ink EXPLODED ${b.inkFrac} -> ${n.inkFrac} (${ratio.toFixed(2)}x) — text overflowing?`);
  // Legibility floor: strokes must not get thinner than the baseline's.
  if (n.minRun < b.minRun) problems.push(`${size}: strokes THINNER ${b.minRun} -> ${n.minRun}px — mushier on thermal`);
  // The drawn area must not spill past where it was (bbox grows = off-label risk).
  if (b.bbox && n.bbox && (n.bbox.w > b.bbox.w * 1.02 || n.bbox.h > b.bbox.h * 1.02)) {
    problems.push(`${size}: drawn area GREW ${b.bbox.w}x${b.bbox.h} -> ${n.bbox.w}x${n.bbox.h} — may run off the label`);
  }
}
console.log("[pdf-bench] compared", SIZES.length, "sizes against the baseline");
for (const [k, v] of Object.entries(now)) {
  const b = base[k];
  console.log(`  ${k.padEnd(14)} ink ${b?.inkFrac} -> ${v.inkFrac}   minRun ${b?.minRun} -> ${v.minRun}   bbox ${b?.bbox?.w}x${b?.bbox?.h} -> ${v.bbox?.w}x${v.bbox?.h}`);
}
if (problems.length) {
  console.error("\n[pdf-bench] ✗ REGRESSIONS:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("\n[pdf-bench] ✓ no regressions");
