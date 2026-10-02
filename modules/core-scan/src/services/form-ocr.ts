// Reading a scanned FORM, which is not a receipt (#4571).
//
// The receipt settings in ocr.ts (one column of lines, the page shrunk to
// 1600 px, grey from all three channels) read a dealer's bill of sale scanned
// on yellow carbon paper as "C1yTe WATCU Ey oL 4" for CIVIC HATCH EX, a 2019
// as 2014, and no VIN at all. A form is a different problem: small capitals in
// ruled boxes, each box's label printed small in a corner, a money column
// ruled line by line, all on tinted paper. So a full-page scan is read the way
// a form is:
//
//   1. The paper's tint is removed by reading the ONE channel where the print
//      stands out most from the paper (red or green for yellow carbon, whose
//      blue channel is nearly as dark as the ink), then contrast-stretched.
//   2. The skew a scanner adds is measured (the angle at which the rows of
//      print line up best) and turned back.
//   3. An adaptive threshold: each pixel against its neighbourhood, so uneven
//      light and a faint carbon both come out black on white.
//   4. The ruled lines are taken out (long runs of black, across or down),
//      which otherwise read as underscores and pipes glued to the values.
//   5. The page is read with automatic layout (psm 3) and as sparse text
//      (psm 11), keeping every word's position.
//   6. Each field is re-read on its own: the label is found by position, the
//      box beside it or below it is cut out, enlarged, and read as one line
//      with only the characters that field can hold (a VIN's alphabet, a
//      year's digits, an amount's digits and separators).
//
// What comes out is the page's own lines plus "Label: value" lines for every
// field the re-reads settled, which the bill-of-sale reader already reads by
// label, and the field values themselves for the checks (document-checks.ts).

import { execFile } from "node:child_process";
import sharp from "sharp";
import { ocrAvailable } from "./ocr.js";
import { lineKind, NOT_A_LINE, UNIT_LINE } from "./charge-lines.js";
import { FORM_SUM } from "./bill-of-sale.js";
import { looksLikeWords } from "./document-checks.js";
import { checkDigitValid, isShapeValidVin } from "./vin-decode.js";

const BIN = process.env.COBBLR_TESSERACT_BIN || "tesseract";
const TIMEOUT_MS = 60_000;
/** A scanner's page at 300 dpi is 2550 px wide; reading past that buys
 *  nothing. Never enlarged: a smaller scan is read at its own size. */
const MAX_WIDTH = 2600;

function run(args: string[], input: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      BIN,
      args,
      { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: "utf8", env: { ...process.env, OMP_THREAD_LIMIT: process.env.OMP_THREAD_LIMIT?.trim() || "1" } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** Is this picture a full page (a scan of a sheet of paper), as opposed to a
 *  receipt strip or a photograph of a thing? Portrait, letter or legal shaped,
 *  and big enough that the scanner took the whole sheet. */
export function looksLikeFullPage(width: number, height: number): boolean {
  if (width < 1200 || height < 1500) return false;
  const r = height / width;
  return r >= 1.2 && r <= 1.75;
}

export interface PreparedPage {
  /** One channel, black print on white, upright, ruled lines KEPT: the page
   *  read uses them to tell columns apart (without them the fine print and
   *  the money column read as one line). */
  layout: Buffer;
  /** The same with the ruled lines taken out, for the field re-reads, where a
   *  rule glued to a value reads as a 1, a 7 or a pipe. */
  png: Buffer;
  width: number;
  height: number;
  /** Degrees the scan was turned back by. */
  deskew: number;
  /** The page's resolution, for the engine: the PNG carries none, and left
   *  to guess the engine took a 300 dpi scan for 195 and lost the captions
   *  (the smallest print on the form). A page this size is a sheet of
   *  letter or legal paper, so its width says its resolution. */
  dpi: number;
  /** 0 red, 1 green, 2 blue: the channel the print stood out most in. */
  channel: number;
}

/** The channel where print and paper are furthest apart. */
async function bestChannel(img: sharp.Sharp): Promise<0 | 1 | 2> {
  const stats = await img.clone().stats();
  let best: 0 | 1 | 2 = 0;
  let bestDev = -1;
  stats.channels.slice(0, 3).forEach((c, i) => {
    if (c.stdev > bestDev) {
      bestDev = c.stdev;
      best = i as 0 | 1 | 2;
    }
  });
  return best;
}

/** The skew, in degrees, at which rows of print line up best: the angle whose
 *  row profile of dark pixels is most uneven (print rows and gaps sharp). */
function measureSkew(grey: Buffer, w: number, h: number): number {
  const dark: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((grey[y * w + x] ?? 255) < 110) dark.push(x, y);
  if (dark.length < 200) return 0;
  let best = 0;
  let bestScore = -1;
  for (let a = -3; a <= 3.0001; a += 0.1) {
    const t = Math.tan((a * Math.PI) / 180);
    const rows = new Float64Array(h + w);
    for (let i = 0; i < dark.length; i += 2) {
      const y = Math.round(dark[i + 1]! - dark[i]! * t) + w;
      if (y >= 0 && y < rows.length) rows[y]! += 1;
    }
    let s = 0;
    for (let i = 1; i < rows.length; i++) {
      const d = rows[i]! - rows[i - 1]!;
      s += d * d;
    }
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return Math.round(best * 10) / 10;
}

/** How much darker than its neighbourhood a pixel must be to count as print.
 *  Measured on the bench's carbon scan: 18 kept the paper's grain as
 *  stipple across the page, 36 keeps only the strokes. */
const THRESHOLD_MARGIN = 36;

/** Black where a pixel is darker than its neighbourhood by `c`. */
function adaptiveThreshold(grey: Buffer, mean: Buffer, c: number): Buffer {
  const out = Buffer.alloc(grey.length);
  for (let i = 0; i < grey.length; i++) out[i] = grey[i]! < mean[i]! - c ? 0 : 255;
  return out;
}

/** Take out ruled lines: a run of black longer than any letter, across or
 *  down. A faint carbon breaks a rule into dashes, and a dash left behind
 *  reads as a 1 or a 7 glued to the amount beside it, so a run may bridge
 *  small gaps. */
function stripRules(bin: Buffer, w: number, h: number): void {
  const minH = Math.max(80, Math.round(w * 0.035));
  const minV = Math.max(80, Math.round(h * 0.022));
  const GAP = 6;
  const sweep = (len: number, at: (i: number) => number, min: number) => {
    let start = -1;
    let lastOn = -1;
    for (let i = 0; i <= len; i++) {
      const on = i < len && bin[at(i)] === 0;
      if (on) {
        if (start < 0) start = i;
        lastOn = i;
      } else if (start >= 0 && (i - lastOn > GAP || i === len)) {
        if (lastOn - start + 1 >= min) for (let k = start; k <= lastOn; k++) bin[at(k)] = 255;
        start = -1;
      }
    }
  };
  for (let y = 0; y < h; y++) sweep(w, (x) => y * w + x, minH);
  for (let x = 0; x < w; x++) sweep(h, (y) => y * w + x, minV);
}

/** The scan made readable: tint out, upright, black on white, rules out. */
export async function prepareFormPage(bytes: Buffer | Uint8Array): Promise<PreparedPage> {
  const upright = sharp(Buffer.from(bytes)).rotate().resize({ width: MAX_WIDTH, fit: "inside", withoutEnlargement: true });
  const channel = await bestChannel(upright);
  const greyPng = await upright.clone().extractChannel(channel).normalise().png().toBuffer();
  // Skew, measured small and turned back on the full page.
  // greyscale() before raw(): sharp hands back three channels otherwise, and
  // the skew was measured on interleaved RGB as if it were rows.
  const small = await sharp(greyPng).greyscale().resize({ width: 850 }).raw().toBuffer({ resolveWithObject: true });
  const deskew = measureSkew(small.data, small.info.width, small.info.height);
  const straight = deskew ? await sharp(greyPng).rotate(-deskew, { background: "#ffffff" }).png().toBuffer() : greyPng;
  // A median first: paper grain and scanner speckle are single pixels, print
  // strokes are not, and a threshold against the neighbourhood would keep
  // every speck of grain as a dot of "print".
  const smooth = await sharp(straight).greyscale().median(3).png().toBuffer();
  const grey = await sharp(smooth).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = grey.info;
  const mean = await sharp(smooth).greyscale().blur(18).raw().toBuffer();
  const bin = adaptiveThreshold(grey.data, mean, THRESHOLD_MARGIN);
  const layout = await sharp(bin, { raw: { width, height, channels: 1 } }).png().toBuffer();
  stripRules(bin, width, height);
  const png = await sharp(bin, { raw: { width, height, channels: 1 } }).png().toBuffer();
  return { layout, png, width, height, deskew, channel, dpi: Math.max(150, Math.round(width / 8.5)) };
}

export interface FormWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  line: string;
}

/** Tesseract's TSV, word rows only, each tagged with the line it sits on. */
export function parseTsv(tsv: string): FormWord[] {
  const out: FormWord[] = [];
  for (const row of tsv.split("\n").slice(1)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const text = (c[11] ?? "").trim();
    if (!text) continue;
    out.push({
      text,
      left: Number(c[6]),
      top: Number(c[7]),
      width: Number(c[8]),
      height: Number(c[9]),
      conf: Number(c[10]),
      line: `${c[2]}.${c[3]}.${c[4]}`,
    });
  }
  return out;
}

/** The words gathered into lines, top to bottom, each line's words left to right. */
export function linesOf(words: FormWord[]): Array<{ text: string; words: FormWord[] }> {
  const by = new Map<string, FormWord[]>();
  for (const w of words) by.set(w.line, [...(by.get(w.line) ?? []), w]);
  return [...by.values()]
    .map((ws) => ws.sort((a, b) => a.left - b.left))
    .sort((a, b) => a[0]!.top - b[0]!.top || a[0]!.left - b[0]!.left)
    .map((ws) => ({ text: ws.map((w) => w.text).join(" "), words: ws }));
}

/** One field a form prints, how its label reads, and what its value may hold. */
interface FieldSpec {
  key: string;
  /** The captions it is printed under, word by word. Matched loosely: a
   *  caption word of four letters or more may be one letter off, because a
   *  caption is the smallest print on the form and a carbon blurs it. Short
   *  captions (MAKE, YEAR) match exactly: one letter off, MAKE is NAME. */
  captions: string[][];
  /** Where the value sits relative to its label. */
  at: "below" | "right";
  /** The characters the value can contain. */
  whitelist: string;
  /** What a good read of the value looks like. */
  value: RegExp;
  /** A value that must also read as words (a make, a model). */
  words?: boolean;
}

// VOCAB-ENUMERATION OK: the fields a sale form prints, by their printed labels;
// what comes out is a "Label: value" line the label reader reads.
const FIELDS: FieldSpec[] = [
  { key: "VIN", captions: [["VEHICLE", "IDENTIFICATION", "NUMBER"], ["VEHICLE", "IDENTIFICATION"], ["VIN"]], at: "below", whitelist: "ABCDEFGHJKLMNPRSTUVWXYZ0123456789", value: /^[A-HJ-NPR-Z0-9]{17}$/ },
  { key: "Year", captions: [["MODEL", "YEAR"], ["YEAR"]], at: "below", whitelist: "0123456789", value: /^(?:19|20)\d{2}$/ },
  { key: "Make", captions: [["MAKE"]], at: "below", whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ -", value: /^[A-Z]{2,}(?:[ -][A-Z]{2,})*$/, words: true },
  { key: "Model", captions: [["MODEL"]], at: "below", whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -/", value: /^[A-Z0-9][A-Z0-9\-\/]+(?: [A-Z0-9][A-Z0-9\-\/]*)*$/, words: true },
  { key: "Odometer", captions: [["ODOMETER", "READING"], ["ODOMETER"], ["MILEAGE"]], at: "below", whitelist: "0123456789,", value: /^\d[\d,]{0,8}$/ },
  { key: "Date", captions: [["DATE", "OF", "SALE"], ["SALE", "DATE"], ["DATE"]], at: "below", whitelist: "0123456789/-.", value: /^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/ },
];

/** Below this the engine is guessing: a dash of a ruled line read as a 7, a
 *  speck read as a comma. Measured on the bench's carbon scans, where the
 *  junk words sat under 30 and the values over 60. */
const MIN_WORD_CONF = 40;

/** A money row's label: the thing sold, a charge on it, or one of the sums
 *  (charge-lines.ts, the one place every receipt's lines are told apart). */
function isMoneyLabel(label: string): boolean {
  const t = label.trim();
  if (!t || t.length > 40 || !/[A-Za-z]{2,}/.test(t)) return false;
  return UNIT_LINE.test(t) || lineKind(t) === "charge" || NOT_A_LINE.test(t) || FORM_SUM.test(t);
}
const AMOUNT = /^\$?\d{1,3}(?:,\d{3})*\.\d{2}$|^\$?\d+\.\d{2}$/;

/** Read one cut of the page with a whitelist, line by line. A box's cut can
 *  catch the next box's caption under its value, so it is read as a block
 *  (psm 6) and each line comes back on its own; a money row's cut is one
 *  line (psm 7). Words the engine itself is unsure of (a dash of a ruled line
 *  read as a 7) are left out. `scale` enlarges the cut; `psm` overrides the
 *  mode, for reading the same box several ways. */
async function readCut(
  page: PreparedPage,
  box: { left: number; top: number; width: number; height: number },
  whitelist: string,
  mode: "line" | "block" = "line",
  opts: { scale?: number; psm?: number } = {},
): Promise<string> {
  const left = Math.max(0, Math.round(box.left));
  const top = Math.max(0, Math.round(box.top));
  const width = Math.min(page.width - left, Math.round(box.width));
  const height = Math.min(page.height - top, Math.round(box.height));
  if (width < 20 || height < 12) return "";
  // The prepared page is already upright (prepareFormPage turned it), so the
  // cut is taken in the frame the words were found in.
  const cut = await sharp(page.png)
    .rotate()
    .extract({ left, top, width, height })
    .resize({ width: Math.round(width * (opts.scale ?? 2)), kernel: "lanczos3" })
    .extend({ top: 20, bottom: 20, left: 20, right: 20, background: "#ffffff" })
    .png()
    .toBuffer();
  const psm = String(opts.psm ?? (mode === "block" ? 6 : 7));
  const dpi = String(Math.round(page.dpi * (opts.scale ?? 2)));
  const tsv = await run(["stdin", "stdout", "--psm", psm, "--dpi", dpi, "-l", "eng", "-c", `tessedit_char_whitelist=${whitelist}`, "tsv"], cut).catch(() => "");
  const words = parseTsv(tsv).filter((w) => w.conf < 0 || w.conf >= MIN_WORD_CONF);
  const out = linesOf(words).map((l) => l.text.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (process.env.COBBLR_FORM_OCR_DEBUG_DIR) await sharp(cut).toFile(`${process.env.COBBLR_FORM_OCR_DEBUG_DIR}/cut-${left}-${top}.png`).catch(() => {});
  if (process.env.COBBLR_FORM_OCR_DEBUG) console.log(`[form-ocr] cut ${left},${top} ${width}x${height} psm${psm} x${opts.scale ?? 2} [${whitelist.slice(0, 12)}] -> ${JSON.stringify(out)}`);
  return mode === "block" ? out.join("\n") : out.join(" ");
}

/** Is a word read off the page this caption word? Exact for a short word
 *  (MAKE is one letter from NAME), one letter off for six or more (YFAR is not YEAR, but
 *  ODOMETFR is ODOMETER). */
function captionWord(read: string, want: string): boolean {
  const r = read.toUpperCase().replace(/[^A-Z]/g, "");
  if (r === want) return true;
  if (want.length < 6 || Math.abs(r.length - want.length) > 1) return false;
  // One edit apart.
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < r.length && j < want.length) {
    if (r[i] === want[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (r.length > want.length) i++;
    else if (r.length < want.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (r.length - i) + (want.length - j) <= 1;
}

/** A caption's words on the page: the first line where its words follow
 *  each other. */
function findLabel(lines: Array<{ text: string; words: FormWord[] }>, captions: string[][]): { label: FormWord[] } | null {
  for (const caption of captions) {
    for (const line of lines) {
      const ws = line.words;
      for (let i = 0; i + caption.length <= ws.length; i++) {
        if (caption.every((want, k) => captionWord(ws[i + k]!.text, want))) return { label: ws.slice(i, i + caption.length) };
      }
    }
  }
  return null;
}

/** A cut read as a block, its words placed back on the page. A table is cut
 *  from the layout image, rules kept: inside a ruled table each row is a
 *  cell, and the engine (psm 4, a column of lines) read every row of the
 *  bench's money columns right that way, where the rule-stripped cut lost
 *  rows and enlarging it misread amounts. */
async function readCutWords(page: PreparedPage, box: { left: number; top: number; width: number; height: number }, scale: number, opts: { image?: "layout" | "clean"; psm?: number } = {}): Promise<FormWord[]> {
  const left = Math.max(0, Math.round(box.left));
  const top = Math.max(0, Math.round(box.top));
  const width = Math.min(page.width - left, Math.round(box.width));
  const height = Math.min(page.height - top, Math.round(box.height));
  if (width < 20 || height < 12) return [];
  const cut = await sharp(opts.image === "layout" ? page.layout : page.png).rotate().extract({ left, top, width, height }).resize({ width: Math.round(width * scale), kernel: "lanczos3" }).png().toBuffer();
  const tsv = await run(["stdin", "stdout", "--psm", String(opts.psm ?? 6), "--dpi", String(Math.round(page.dpi * scale)), "-l", "eng", "tsv"], cut).catch(() => "");
  return parseTsv(tsv)
    .filter((w) => w.conf < 0 || w.conf >= MIN_WORD_CONF)
    .map((w) => ({ ...w, left: left + w.left / scale, top: top + w.top / scale, width: w.width / scale, height: w.height / scale }));
}

/** The VIN box read several ways (two enlargements, as a line and as a
 *  block), keeping the first reading the check digit proves as read, else
 *  the first well-formed one (which the checks will hold until something
 *  confirms it). A faint carbon swaps a letter for a look-alike in one
 *  reading and not in another; the arithmetic says which reading is right. */
async function readVinBox(page: PreparedPage, box: { left: number; top: number; width: number; height: number }, whitelist: string): Promise<string | null> {
  const seen: string[] = [];
  for (const scale of [2, 3, 1.5]) {
    for (const psm of [6, 7]) {
      const raw = await readCut(page, box, whitelist, psm === 6 ? "block" : "line", { scale, psm });
      for (const line of raw.split("\n")) {
        const run = line.replace(/\s+/g, "");
        for (const cand of run.length === 17 ? [run] : run.length > 17 && run.length <= 19 ? Array.from({ length: run.length - 16 }, (_, i) => run.slice(i, i + 17)) : []) {
          if (isShapeValidVin(cand) && checkDigitValid(cand)) return cand;
          if (isShapeValidVin(cand)) seen.push(cand);
        }
      }
    }
  }
  return seen[0] ?? null;
}

export interface FormRead {
  /** The page's lines and a "Label: value" line per settled field. */
  text: string;
  /** Each field the re-reads settled, by its label key. */
  fields: Record<string, string>;
  /** Money rows: label and amount, in order down the page. */
  money: Array<{ label: string; amount: string }>;
  ms: number;
  deskew: number;
}

/**
 * Read a scanned form. Null when there is no engine on this deployment or it
 * read nothing; the caller falls back to what it does without one.
 */
export async function ocrFormText(bytes: Buffer | Uint8Array): Promise<FormRead | null> {
  if (!(await ocrAvailable())) return null;
  const t0 = performance.now();
  const page = await prepareFormPage(bytes);
  const [auto, sparse] = await Promise.all([
    run(["stdin", "stdout", "--psm", "3", "--dpi", String(page.dpi), "-l", "eng", "tsv"], page.layout).catch(() => ""),
    run(["stdin", "stdout", "--psm", "11", "--dpi", String(page.dpi), "-l", "eng", "tsv"], page.layout).catch(() => ""),
  ]);
  const autoLines = linesOf(parseTsv(auto));
  const sparseLines = linesOf(parseTsv(sparse));
  if (!autoLines.length && !sparseLines.length) return null;

  const allWords = [...autoLines, ...sparseLines].flatMap((l) => l.words);
  const fields: Record<string, string> = {};
  for (const spec of FIELDS) {
    const found = findLabel(autoLines, spec.captions) ?? findLabel(sparseLines, spec.captions);
    if (!found) continue;
    const { label } = found;
    const first = label[0]!;
    const last = label[label.length - 1]!;
    const h = Math.max(...label.map((w) => w.height));
    // The box a caption heads runs to the next caption on its row: the
    // nearest word at the same height to its right, in either read.
    const nextOnRow = allWords
      .filter((w) => Math.abs(w.top - first.top) < h * 0.8 && w.left > last.left + last.width + 20 && /[A-Za-z]{2,}/.test(w.text))
      .sort((a, b) => a.left - b.left)[0];
    const right = nextOnRow ? nextOnRow.left - 8 : first.left + 1250;
    const cuts =
      spec.at === "below"
        ? [
            { left: first.left - 10, top: last.top + h + 2, width: right - first.left + 10, height: Math.min(170, Math.max(60, h * 7)) },
            { left: last.left + last.width + 10, top: first.top - h * 0.6, width: 900, height: h * 2.6 },
          ]
        : [{ left: last.left + last.width + 10, top: first.top - h * 0.6, width: 900, height: h * 2.6 }];
    if (spec.key === "VIN") {
      const vin = await readVinBox(page, cuts[0]!, spec.whitelist);
      if (vin) fields.VIN = vin;
      continue;
    }
    for (const cut of cuts) {
      const raw = await readCut(page, cut, spec.whitelist, "block");
      // A cut that ran into the next box carries its caption too; the value
      // is the first line that looks like one.
      const candidates = raw
        .split("\n")
        .flatMap((l) => [l, l.replace(/\s+/g, "")])
        // A separator the engine hung off the end of a number ("86,402,").
        .map((s) => s.trim().replace(/^[,.\/-]+|[,.\/-]+$/g, ""))
        .filter(Boolean);
      const hit = candidates.find((c) => spec.value.test(c) && (!spec.words || looksLikeWords(c)));
      if (hit) {
        fields[spec.key] = hit;
        break;
      }
    }
  }

  // Money rows: a row whose label names a sale line. The amount is read at
  // the row's right edge on its own, digits only, whether or not the page
  // read kept it beside the label; that re-read is where an 11.05 the page
  // read as 111.05 or 11705 is put right.
  // A label's words are the ones with letters; a number beside them is the
  // amount, or a piece of it the read split off ("18" of 18,820.00).
  const labelOf = (ws: FormWord[]) => ws.filter((w) => /[A-Za-z]{2,}/.test(w.text));
  const textOf = (ws: FormWord[]) => ws.map((w) => w.text).join(" ").replace(/[^A-Za-z .&'\/-]/g, " ").replace(/\s+/g, " ").trim();
  const lines = [...autoLines, ...sparseLines];
  // The shortest run of a line's last words that the vocabulary recognises
  // as a sale line ("PRICE OF UNIT" out of fine print the read ran into it).
  // Then out to the words set close beside it, which are the rest of its
  // caption ("PROCESSING" of PROCESSING FEE); fine print the read ran into
  // it sits across the gap between the columns.
  const knownTail = (ws: FormWord[]): FormWord[] | null => {
    for (let k = ws.length - 1; k >= 0; k--) {
      if (!isMoneyLabel(textOf(ws.slice(k)))) continue;
      let from = k;
      while (from > 0) {
        const prev = ws[from - 1]!;
        const cur = ws[from]!;
        if (cur.left - (prev.left + prev.width) > cur.height * 1.6 || !/^[A-Z][A-Z.&'\/-]*$/.test(prev.text)) break;
        from--;
      }
      return ws.slice(from);
    }
    return null;
  };
  // The money column: where the recognised labels start, and how far down
  // they run. It is read as one block cut from the page (no fine print in
  // it), which a whole-page read cannot do: there the column's rows merge
  // with the fine print beside them, or go missing.
  const tails = lines.map((l) => knownTail(labelOf(l.words))).filter((t): t is FormWord[] => !!t && t.length > 0);
  const rows: Array<{ label: string; amount: string; top: number }> = [];
  if (tails.length >= 2) {
    const lefts = tails.map((t) => t[0]!.left).sort((a, b) => a - b);
    const colLeft = lefts[Math.floor(lefts.length / 2)]!;
    const rowH = Math.max(...tails.map((t) => Math.max(...t.map((w) => w.height))));
    const tops = tails.map((t) => t[0]!.top);
    const pitch = rowH * 4;
    const box = {
      left: colLeft - 30,
      top: Math.max(0, Math.min(...tops) - pitch * 3),
      width: page.width - colLeft - 10,
      height: Math.max(...tops) - Math.min(...tops) + pitch * 6,
    };
    const column = await readCutWords(page, box, 1, { image: "layout", psm: 4 });
    if (process.env.COBBLR_FORM_OCR_DEBUG) console.log("[form-ocr] column", JSON.stringify(box), "\n  " + linesOf(column).map((l) => l.text).join("\n  "));
    for (const line of linesOf(column)) {
      const ws = labelOf(line.words);
      const label = textOf(ws);
      // The amount: the line's numbers after its label, joined ("20, 000.00"
      // read as two words is one amount).
      const tail = line.words.filter((w) => !/[A-Za-z]/.test(w.text)).map((w) => w.text).join("").replace(/[^\d.,]/g, "");
      const inLine = /(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})$/.exec(tail)?.[1] ?? null;
      if (!ws.length || ws.length > 5 || !/^[A-Z][A-Z .&'\/-]+$/.test(label)) continue;
      const top = Math.min(...ws.map((w) => w.top));
      if (rows.some((r) => Math.abs(r.top - top) < rowH * 0.7)) continue;
      let amount = inLine;
      if (!amount) {
        // Not read in line: the amount on its own, digits only, at the row's
        // right edge.
        const h = Math.max(...ws.map((w) => w.height));
        const from = Math.max(...ws.map((w) => w.left + w.width)) + 10;
        const reread = await readCut(page, { left: from, top: top - h * 0.6, width: page.width - from - 40, height: h * 2.4 }, "0123456789.,$");
        amount = /(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})\s*$/.exec(reread.replace(/\s+/g, ""))?.[1] ?? null;
      }
      if (!amount) continue;
      rows.push({ label, amount, top });
    }
  }
  // Down the page, as printed: the lines before tax come first, which the
  // taxable-amount check reads.
  const money = rows.sort((a, b) => a.top - b.top).map(({ label, amount }) => ({ label, amount }));

  const header = autoLines.map((l) => l.text);
  const settled = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  const moneyLines = money.map((m) => `${m.label} ${m.amount}`);
  // The settled fields FIRST: a form's caption row ("YEAR MAKE MODEL BODY
  // COLOR") is also on the page, and a label reader that met it first would
  // read the next caption as the value.
  const text = [...settled, ...header.filter((l) => !money.some((m) => l.startsWith(m.label))), ...moneyLines].join("\n");
  return { text, fields, money, ms: Math.round(performance.now() - t0), deskew: page.deskew };
}
