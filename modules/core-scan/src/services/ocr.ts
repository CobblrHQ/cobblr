// Image to text, with no model: the OCR engine the deterministic receipt
// tiers were specced against (docs/design-decisions/no-ai-receipt-reading.md
// §5) and the pass the receipt-shape check runs before any identify call.
//
// Tesseract, as a short-lived subprocess. Measured against the WASM build
// before this was chosen: 0.2 s a receipt against several times that, a
// separate process against 100-300 MB held in the api's own heap, and a
// system package against language data that would have to be baked into the
// image by hand (the hosted deployment runs the strict egress policy, so a
// runtime download works on staging and fails there). The labels module
// shells out to a purpose-built tool the same way.
//
// The binary is OPTIONAL. A deployment without it (an older image, a dev
// machine without the package) degrades to the behaviour before this file
// existed: every image goes straight to the model. The probe runs once and
// says so on the log, and the ai-status route reports it, so "the receipt
// went to the model" is a fact you can read rather than infer.
//
// Page segmentation mode 4 ("a single column of text of variable sizes") is
// deliberate. The default mode reads a receipt as two columns and returns the
// descriptions and then the prices as separate blocks, which loses the one
// thing the line parser keys on: the amount at the END of its line.
//
// TWO PASSES, because a render and a photograph are different problems. A
// render or a scan (the review pack, an emailed image, a screenshot) reads
// at its native size in one pass. A photograph of a slip on a counter reads
// as NOTHING that way: the paper is a third of the frame, the print is a few
// pixels tall, and the engine's layout analysis gives up on the background
// (measured on the two real receipt photographs in modules/core-scan/tests/
// fixtures/receipts: zero lines, both). So when the first pass finds no text
// worth the name, the second finds the paper (the largest bright band of
// rows and columns), crops to it, upscales it and reads it as one block.
// That pass turned "zero lines" into the line items, the totals and the
// date on both photographs. It costs a second engine run, only on images
// the first pass could not read, which is also every product photo: those
// pay ~0.3 s more before the model is asked, and the model call that follows
// costs seconds.
import { execFile } from "node:child_process";
import sharp from "sharp";

export interface OcrResult {
  text: string;
  /** Milliseconds the engine took, preprocessing included, both passes. */
  ms: number;
  engine: "tesseract";
  /** Which pass produced the text: the whole frame, or the paper cropped
   *  out of a photograph and upscaled. */
  pass: "frame" | "paper";
}

const BIN = process.env.COBBLR_TESSERACT_BIN || "tesseract";
/** Longer than any receipt should take; a photo that hangs the engine must
 *  not hang the identify behind it. */
const TIMEOUT_MS = 30_000;
/** Phone photos are 3000-4000 px wide; the engine gets slower and no more
 *  accurate past the point where the print is legible. Never upscaled: a
 *  small render is already at its native size. */
const MAX_WIDTH = 1600;
/** The paper pass upscales the crop to this; measured on the real photographs
 *  at 900, 1800 and 2600: 900 read the totals, 1800 read the lines too, 2600
 *  read no more and took longer. */
const PAPER_WIDTH = 1800;
/** A frame pass that read fewer lines than this is treated as having read
 *  nothing: a photograph, or a blank. Four is under the shortest receipt. */
const FRAME_ENOUGH_LINES = 4;

let probe: Promise<boolean> | null = null;

function run(args: string[], input?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
    if (input) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });
}

/** Is the engine on this deployment? Probed once; `COBBLR_OCR=0` turns it off
 *  without uninstalling anything (the switch every optional engine here has). */
export function ocrAvailable(): Promise<boolean> {
  if (process.env.COBBLR_OCR === "0" || process.env.COBBLR_OCR === "false") return Promise.resolve(false);
  probe ??= run(["--version"]).then(
    (out) => {
      const v = out.split("\n")[0]?.trim() ?? "";
      console.log(`[core-scan] OCR engine: ${v || "tesseract"}`);
      return true;
    },
    (err: NodeJS.ErrnoException) => {
      console.log(`[core-scan] OCR engine: none (${err.code === "ENOENT" ? `${BIN} not on PATH` : err.message}); images go straight to the model`);
      return false;
    },
  );
  return probe;
}

/** The preprocessing chain, the one the design record maps from Receipt
 *  Wrangler's ImageMagick steps: honour the EXIF rotation, bound the size,
 *  greyscale, stretch the contrast. Exported so the benchmark scores the same
 *  bytes the pipeline reads. */
export async function preprocessForOcr(bytes: Buffer | Uint8Array): Promise<Buffer> {
  return sharp(Buffer.from(bytes))
    .rotate()
    .resize({ width: MAX_WIDTH, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .normalise()
    .png()
    .toBuffer();
}

/** Where the paper is in a photograph, and whether it looks printed.
 *
 *  The paper: the largest band of rows, and of columns, that are mostly
 *  bright, measured on a 200 px thumbnail. Gaps up to 8% of the dimension
 *  are bridged (a dark logo band, a fold). Null when no band covers a
 *  meaningful part of the frame, or when the bright band IS the frame (a
 *  render, a scan: nothing to crop).
 *
 *  Printed: inside that region, the rows' mean brightness alternates between
 *  paper and print as you go down the page. A receipt shows ten to twenty
 *  such bands; a white kettle, a book cover, a blanket show none. This is
 *  the whole-frame statistic the design record measured and rejected
 *  (receipt-from-a-photo.md §4), measured where it works: inside the paper.
 *  It is what keeps the expensive pass off every product photo. */
export interface PaperRegion {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Rows of print alternating with rows of paper, counted top to bottom. */
  bands: number;
}

/** Bands below this: no print to read. Measured: real receipts 10 and 18,
 *  eight product photos and two product close-ups all 0. */
const PRINT_BANDS = 4;

export async function paperRegion(bytes: Buffer | Uint8Array): Promise<PaperRegion | null> {
  const W = 200;
  const img = sharp(Buffer.from(bytes)).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) return null;
  const { data, info } = await img.clone().greyscale().resize({ width: W }).raw().toBuffer({ resolveWithObject: true });
  const H = info.height;
  const bright = (x: number, y: number) => (data[y * W + x] ?? 0) > 150;
  const rows: number[] = [];
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if (bright(x, y)) n++;
    rows.push(n / W);
  }
  const cols: number[] = [];
  for (let x = 0; x < W; x++) {
    let n = 0;
    for (let y = 0; y < H; y++) if (bright(x, y)) n++;
    cols.push(n / H);
  }
  const band = (fr: number[]): [number, number] | null => {
    const gap = Math.max(2, Math.round(fr.length * 0.08));
    let best: [number, number] | null = null;
    let start: number | null = null;
    let lastBright = -1;
    for (let i = 0; i <= fr.length; i++) {
      const on = i < fr.length && (fr[i] ?? 0) > 0.15;
      if (on) {
        start ??= i;
        lastBright = i;
      } else if (start !== null && (i - lastBright > gap || i === fr.length)) {
        const run: [number, number] = [start, lastBright + 1];
        if (!best || run[1] - run[0] > best[1] - best[0]) best = run;
        start = null;
      }
    }
    return best;
  };
  const ys = band(rows);
  const xs = band(cols);
  if (!ys || !xs) return null;
  const fracH = (ys[1] - ys[0]) / H;
  const fracW = (xs[1] - xs[0]) / W;
  // Too small to hold print, or the whole frame already.
  if (fracH < 0.15 || fracW < 0.15) return null;
  if (fracH > 0.92 && fracW > 0.92) return null;
  const sx = meta.width / W;
  const sy = meta.height / H;
  const pad = 6;
  const left = Math.max(0, Math.floor(xs[0] * sx) - pad);
  const top = Math.max(0, Math.floor(ys[0] * sy) - pad);
  const region = {
    left,
    top,
    width: Math.min(meta.width - left, Math.ceil((xs[1] - xs[0]) * sx) + pad * 2),
    height: Math.min(meta.height - top, Math.ceil((ys[1] - ys[0]) * sy) + pad * 2),
  };
  // The print bands, inside the paper, contrast stretched so a dim photo
  // measures like a bright one.
  const crop = await sharp(Buffer.from(bytes)).rotate().extract(region).greyscale().resize({ width: 300 }).normalise().raw().toBuffer({ resolveWithObject: true });
  const cw = crop.info.width;
  const ch = crop.info.height;
  let bands = 0;
  let prev: boolean | null = null;
  for (let y = 0; y < ch; y++) {
    let sum = 0;
    for (let x = 0; x < cw; x++) sum += crop.data[y * cw + x] ?? 0;
    const paper = sum / cw > 200;
    if (prev !== null && paper !== prev) bands += 1;
    prev = paper;
  }
  return { ...region, bands };
}

/** The photograph pass: the paper cropped out of the frame and upscaled so
 *  the print is tall enough for the engine, read as one block (mode 6).
 *  Null when the frame holds no paper with print on it. */
export async function preprocessPaperForOcr(bytes: Buffer | Uint8Array): Promise<Buffer | null> {
  const region = await paperRegion(bytes);
  if (!region || region.bands < PRINT_BANDS) return null;
  const { left, top, width, height } = region;
  return sharp(Buffer.from(bytes))
    .rotate()
    .extract({ left, top, width, height })
    .greyscale()
    .resize({ width: PAPER_WIDTH, kernel: "lanczos3" })
    .normalise()
    .png()
    .toBuffer();
}

/** Lines with a letter or a digit on them: the measure of "read something". */
function readLines(text: string): number {
  return text.split(/\r?\n/).filter((l) => /[a-z0-9]/i.test(l)).length;
}

/**
 * Read the text off an image. Null when there is no engine, when it failed,
 * or when it read nothing at all; the caller treats every null the same way
 * (ask the model), so none of them is an error worth throwing.
 */
export async function ocrImageText(bytes: Buffer | Uint8Array): Promise<OcrResult | null> {
  if (!(await ocrAvailable())) return null;
  const t0 = performance.now();
  try {
    const frame = await run(["stdin", "stdout", "--psm", "4", "-l", "eng"], await preprocessForOcr(bytes));
    if (readLines(frame) >= FRAME_ENOUGH_LINES) {
      return { text: frame, ms: Math.round(performance.now() - t0), engine: "tesseract", pass: "frame" };
    }
    const paper = await preprocessPaperForOcr(bytes);
    const cropped = paper ? await run(["stdin", "stdout", "--psm", "6", "-l", "eng"], paper) : "";
    const ms = Math.round(performance.now() - t0);
    if (readLines(cropped) > readLines(frame)) return { text: cropped, ms, engine: "tesseract", pass: "paper" };
    if (!frame.trim()) return null;
    return { text: frame, ms, engine: "tesseract", pass: "frame" };
  } catch (err) {
    console.warn(`[core-scan] OCR failed: ${(err as Error).message}`);
    return null;
  }
}
