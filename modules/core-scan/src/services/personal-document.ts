import { renewalDocumentTypeIn } from "@cobblr/platform-contract/renewal-document-types";
import { readRenewalPeriod } from "./renewal-draft.js";
import { looksLikeBillOfSale } from "./bill-of-sale.js";
import sharp from "sharp";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { centsFromAmount, formatMoneyPlain } from "@cobblr/platform-contract/money";
import { refusalCodeOf } from "@cobblr/platform-contract/ai-refusal";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "@cobblr/platform-contract";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIELDS_FOR_KIND, type DocumentInput, type PersonalDocumentField, type PersonalDocumentRead } from "@cobblr/platform-contract/personal-documents";
import { checkDigitValid, repairVin } from "./vin-decode.js";
import { ocrImageText } from "./ocr.js";
import { parseCsvReceipt, parseCsvRows } from "./receipt-deterministic.js";

const run = promisify(execFile);
/** The label an AI is asked to answer each field under: the ones
 *  extractPersonalFields reads back. */
const ANSWER_LABEL: Record<PersonalDocumentField, string> = { vin: "VIN", plate: "Plate", expires: "Expires", amount: "Fee", reference: "Confirmation", make: "Make", model: "Model", year: "Year" };
const PERSONAL = /\b(registration|vin|plate|vehicle|bill of sale|certificate of title|odometer|licen[cs]e|passport|social security|ssn|policy number|insurance|medical|patient|tax return|tax form|form w-?2|form 1040|bank statement|account statement|account number|routing number|iban|swift code|diagnosis|prescription|identity|id card|driver information|driver record|date of birth)\b|\b\d{3}-\d{2}-\d{4}\b/i;
const ORDINARY = /\b(receipt|subtotal|sales tax|product|ingredients|nutrition|yarn|cotton|polyester|wool|barcode|isbn|manual|knit(?:ting)?|crochet|sewing|pattern|stitch|upc|ean)\b/i;
function manufacturingTable(text: string, header: string): boolean {
  if (!/\b(?:reference|ref|refdes|designator)\b/i.test(header) || !/\b(?:footprint|package)\b/i.test(header)) return false;
  const rows = parseCsvRows(text).filter((row) => row.some((cell) => cell.trim()));
  const columns = rows[0]?.map((cell) => cell.trim().toLowerCase()) || [];
  const reference = columns.findIndex((cell) => ["reference", "ref", "refdes", "designator"].includes(cell));
  return reference >= 0 && columns.some((cell) => ["footprint", "package"].includes(cell)) && rows.length > 1
    && rows.slice(1).every((row) => row.length === columns.length && /^[A-Z]{1,4}\d+(?:[\s,]+[A-Z]{1,4}\d+)*$/i.test(row[reference]?.trim() || ""));
}
function numericCadSource(lines: string[]): boolean {
  const imported = /^from (?:build123d|cadquery) import (?:\*|[A-Za-z_, ]+)$/;
  const primitive = "(?:Box|Cylinder|Sphere|Hole|Cone|Circle|Rectangle)\\([\\d\\s.,+\\-\\[\\]]+\\)";
  const shape = new RegExp(`^[A-Za-z_]\\w*\\s*=\\s*${primitive}(?:\\s*[-+]\\s*${primitive})*$`);
  return lines.some((line) => imported.test(line)) && lines.some((line) => shape.test(line))
    && lines.every((line) => imported.test(line) || shape.test(line));
}
function recurringInvoice(text: string): boolean {
  return /\b(?:invoice|receipt)\b/i.test(text) && Boolean(readRenewalPeriod(text).billing_cycle);
}
/** Personal indicators always win; renewal alone also names ordinary recurring invoices. */
function personalIn(text: string): boolean {
  return PERSONAL.test(text) || /\b[A-HJ-NPR-Z0-9]{17}\b/i.test(text)
    || (/\brenewal\b/i.test(text) && !recurringInvoice(text));
}
/** The printable text an image's metadata carries (EXIF, XMP, IPTC, comments).
 *  An ICC colour profile is not document text and is not read. */
function metadataText(metadata: { exif?: Buffer; xmp?: Buffer; iptc?: Buffer; comments?: Array<{ keyword?: string; text?: string }> }): string {
  const printable = (b?: Buffer) => (b ? b.toString("latin1").replace(/[^\x20-\x7e]+/g, " ") : "");
  return [printable(metadata.exif), printable(metadata.xmp), printable(metadata.iptc), ...(metadata.comments ?? []).map((c) => `${c.keyword ?? ""} ${c.text ?? ""}`)].join(" ");
}
/** A whole photo's privacy from what local OCR read on it. A photo with no
 *  words, or a few label words, is a picture of a thing; personal indicators
 *  or a dense page of writing code cannot place keep it personal (#5243). */
export function photoPrivacy(text: string): "personal" | "normal" {
  if (personalIn(text)) return "personal";
  // A page of writing is mostly words. OCR of a textured thing (yarn, fabric,
  // wood grain) returns as many tokens, but short junk: "Ay", "fad", "ef".
  const tokens = text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t));
  const words = tokens.filter((t) => /^[("']?[A-Za-z][a-z]{2,}[.,:;)'"]?$/.test(t) && /[aeiouy]/i.test(t));
  if (words.length < 30 || words.length < tokens.length * 0.5) return "normal";
  // A screenshot of a shop or marketplace listing is dense with words and is
  // filed as a sale (#3853): its price and its seller say what it is.
  if (LISTING.test(text)) return "normal";
  return classifyPersonalText(text);
}
const LISTING = /\b(?:just listed|listed|listing|message seller|seller|buy it now|add to (?:cart|basket)|free shipping|shipping|delivery|in stock|sold by|condition|marketplace)\b|[$£€]\s?\d/i;
export function classifyPersonalText(text: string, vault = false): "personal" | "normal" {
  if (vault || personalIn(text)) return "personal";
  const header = text.split(/\r?\n/, 1)[0] || "";
  const receiptTable = /\b(?:qty|quantity)\b/i.test(header) && /\bunit\s+(?:price|cost)\b/i.test(header)
    && Boolean(parseCsvReceipt(text)?.items.length);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const machineCode = lines.some((line) => /^[GMT]\d+\b/.test(line)) && lines.every((line) => /^(?:[GMT]\d+\b|;)/.test(line));
  return ORDINARY.test(text) || recurringInvoice(text) || machineCode || receiptTable || manufacturingTable(text, header) || numericCadSource(lines) ? "normal" : "personal";
}
function day(raw: string): string | null {
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  if (match) { y = +match[1]!; m = +match[2]!; d = +match[3]!; }
  else {
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
    if (match) { m = +match[1]!; d = +match[2]!; y = +match[3]!; }
    else {
      const written = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(raw.trim());
      if (!written) return null;
      const name = written[1]!.toLowerCase();
      const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
      m = months.findIndex((month) => month === name || month.slice(0, 3) === name || (name === "sept" && month === "september")) + 1;
      if (!m) return null;
      y = +written[3]!; d = +written[2]!;
    }
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
}
/** A labelled value up to the next label printed on the same row. */
function untilNextLabel(raw: string | undefined): string | undefined {
  return raw?.split(/\s+(?=[A-Za-z][A-Za-z .#/'-]{0,30}?:)/)[0]?.trim();
}
export function extractPersonalFields(text: string): PersonalDocumentRead["fields"] {
  const out: PersonalDocumentRead["fields"] = {};
  const labelledVins = [...text.toUpperCase().matchAll(/\b(?:VIN|VEHICLE IDENTIFICATION NUMBER)(?:[ \t]+(?:NUMBER|NO\.?|#))?[ \t]*[:#-]?[ \t]*([A-Z0-9][A-Z0-9 \t-]{15,30})\b/g)]
    .flatMap((match) => { const read = repairVin(match[1]!); return read?.verified ? [read.vin] : []; });
  const vins = [...text.toUpperCase().matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/g)].map((m) => m[0]).concat(labelledVins).filter(checkDigitValid);
  if (new Set(vins).size === 1) out.vin = vins[0];
  const plate = /\b(?:licen[cs]e\s+)?plate(?:\s+(?:number|no\.?|#))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{1,12})\b/i.exec(text);
  if (plate) out.plate = plate[1]!.trim();
  const expiries = new Set([...text.matchAll(/\b(?:expires|valid until|registration expiration|expiration(?: date)?|expiry(?: date)?)\s*[:#-]?\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/gi)].map((match) => day(match[1]!)));
  const expiry = [...expiries][0];
  if (expiries.size === 1 && expiry) out.expires = expiry;
  const amount = /\b(?:fee|amount(?: paid)?|total(?: paid)?|cost)\s*[:#-]?\s*(?:USD\s*)?\$?\s*(\d+(?:,\d{3})*(?:\.\d{2})?)\b/i.exec(text);
  if (amount) out.amount = formatMoneyPlain(centsFromAmount(Number(amount[1]!.replace(/,/g, ""))));
  const reference = /\b(?:confirmation|reference)(?:\s+(?:number|no\.?|#))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{1,39})\b/i.exec(text);
  if (reference) out.reference = reference[1]!;
  for (const key of ["make", "model", "year"] as const) {
    // A form prints several labels on one row ("Year: 2021   Make: Toyota
    // Model: Tacoma"): a value ends where the next "Label:" begins (#5838).
    const value = untilNextLabel(new RegExp(`\\b${key}\\s*:\\s*([^\\n\\r]+)`, "i").exec(text)?.[1]);
    if (value && (key !== "year" || /^\d{4}$/.test(value))) out[key] = value;
  }
  return out;
}
/** A rendered page with no marks: every channel within a few levels. */
async function blankPage(png: Uint8Array): Promise<boolean> {
  try {
    const stats = await sharp(Buffer.from(png)).stats();
    return stats.channels.every((channel) => channel.max - channel.min <= 8);
  } catch { return false; }
}
/** What a read found written anywhere: a text layer, OCR'd words, or a page
 *  that is not blank. A document with nothing written on it is fully seen. */
export interface Seen { written: boolean; layer?: boolean }
export async function personalDocumentText(input: DocumentInput, incomplete: () => void = () => {}, onPage?: (bytes: Uint8Array) => void, seen: Seen = { written: false }): Promise<string> {
  if (input.mime === "application/pdf" || Buffer.from(input.bytes.subarray(0, 5)).toString() === "%PDF-") {
    if (!input.path) {
      const dir = await mkdtemp(join(tmpdir(), "personal-document-"));
      try {
        const path = join(dir, "original.pdf");
        await writeFile(path, input.bytes, { mode: 0o600 });
        return await personalDocumentText({ ...input, path }, incomplete, onPage, seen);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
    let layer = "";
    try {
      layer = (await run("pdftotext", ["-enc", "UTF-8", "-nopgbrk", input.path, "-"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
      if (layer.trim()) { seen.written = true; seen.layer = true; }
      const info = await run("pdfinfo", [input.path], { timeout: 10_000, maxBuffer: 64 * 1024 });
      layer += `\n${info.stdout}`;
      if (/^Metadata stream:\s+yes\s*$/im.test(info.stdout)) {
        layer += `\n${(await run("pdfinfo", ["-meta", input.path], { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout}`;
      }
      const pages = Number([...info.stdout.matchAll(/^Pages:\s+(\d+)\s*$/gm)].at(-1)?.[1]);
      if (!pages || pages > 50) { incomplete(); return layer; }
      const text = [layer];
      // Ordinary typed documents sample the first two pages' pictures so a
      // long illustrated pattern does not OCR every step's photo. Text and
      // metadata above still cover the whole file; pages without text below
      // are always rendered and read. Explicit personal reads stay complete.
      const picturePages = !input.vault && !input.assist && !onPage && seen.layer && classifyPersonalText(layer) === "normal" ? 2 : undefined;
      const pictures = onPage ? null : await picturesByPage(input.path, picturePages).catch(() => null);
      const pending: Buffer[] = [];
      for (let page = 1; page <= pages; page++) {
        if (pictures) {
          const own = (await run("pdftotext", ["-f", String(page), "-l", String(page), "-enc", "UTF-8", input.path, "-"], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
          if (own.trim()) {
            pending.push(...(pictures.get(page) ?? []));
            continue;
          }
        }
        const rendered = await run("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-scale-to", "1600", "-png", input.path], { encoding: "buffer", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
        onPage?.(rendered.stdout);
        const words = (await ocrImageText(rendered.stdout, { private: true }))?.text || "";
        if (words.trim()) seen.written = true;
        // A page with marks on it that OCR cannot read is not fully seen; a
        // blank page is (an empty PDF said "personal document" about nothing).
        else if (await blankPage(rendered.stdout)) { /* nothing written here */ }
        else { seen.written = true; incomplete(); }
        text.push(words);
      }
      text.push(...(await readPictures(pending, new Set())));
      return text.join("\n");
    } catch { incomplete(); return layer; }
  }
  if (input.mime.startsWith("image/")) return (await ocrImageText(input.bytes, { private: true }))?.text || "";
  if (/^text\//.test(input.mime)) return new TextDecoder().decode(input.bytes);
  return "";
}
/** Pictures embedded in a PDF, by page: JPEGs as they are stored,
 *  anything else as PNG. */
async function picturesByPage(path: string, lastPage?: number): Promise<Map<number, Buffer[]>> {
  const dir = await mkdtemp(join(tmpdir(), "personal-document-pictures-"));
  try {
    await run("pdfimages", ["-png", "-j", "-p", ...(lastPage ? ["-f", "1", "-l", String(lastPage)] : []), path, join(dir, "img")], { timeout: 60_000, maxBuffer: 64 * 1024 });
    const out = new Map<number, Buffer[]>();
    for (const name of (await readdir(dir)).sort()) {
      const page = Number(/^img-(\d+)-\d+\.(?:png|jpg)$/.exec(name)?.[1]);
      if (!page) continue;
      out.set(page, [...(out.get(page) ?? []), await readFile(join(dir, name))]);
    }
    return out;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The words in a page's pictures. A pattern repeats its pictures and
 *  carries dozens, so each distinct one is read once, four at a time (one
 *  engine thread each, see ocr.ts), skipping any too small to hold writing. */
async function readPictures(pictures: Buffer[], read: Set<string>): Promise<string[]> {
  const todo: Array<{ png: Buffer; width: number; height: number }> = [];
  for (const picture of pictures) {
    const key = createHash("sha1").update(picture).digest("hex");
    if (read.has(key)) continue;
    read.add(key);
    const { width = 0, height = 0 } = await sharp(picture).metadata();
    if (!TOO_SMALL_FOR_WRITING(width, height)) todo.push({ png: await sharp(picture).flatten({ background: "#ffffff" }).png().toBuffer(), width, height });
  }
  const sheets = await contactSheets(todo);
  const out: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, sheets.length) }, async () => {
    while (next < sheets.length) out.push((await ocrImageText(sheets[next++]!, { private: true, framePassOnly: true }))?.text || "");
  }));
  return out;
}

/** Pictures tiled at their own size onto a few sheets with white gutters
 *  wide enough that no line of text runs from one picture into the next. One
 *  engine run per sheet instead of per picture: a pattern carries ~60 small
 *  photos, and starting the engine for each, not reading them, was what made
 *  its upload take 20 s. A picture too big to share a sheet is read alone. */
const SHEET = 2400, GUTTER = 64;
async function contactSheets(pictures: Array<{ png: Buffer; width: number; height: number }>): Promise<Buffer[]> {
  const sheets: Buffer[] = [];
  let placed: Array<{ input: Buffer; left: number; top: number }> = [];
  let x = GUTTER, y = GUTTER, row = 0, bottom = 0;
  const flush = async () => {
    if (!placed.length) return;
    sheets.push(await sharp({ create: { width: SHEET, height: bottom + GUTTER, channels: 3, background: "#ffffff" } }).composite(placed).png().toBuffer());
    placed = []; x = GUTTER; y = GUTTER; row = 0; bottom = 0;
  };
  for (const p of [...pictures].sort((a, b) => b.height - a.height)) {
    if (p.width > SHEET - 2 * GUTTER || p.height > SHEET - 2 * GUTTER) { sheets.push(p.png); continue; }
    if (x + p.width + GUTTER > SHEET) { x = GUTTER; y += row + GUTTER; row = 0; }
    if (y + p.height + GUTTER > SHEET) { await flush(); }
    placed.push({ input: p.png, left: x, top: y });
    x += p.width + GUTTER; row = Math.max(row, p.height); bottom = Math.max(bottom, y + p.height);
  }
  await flush();
  return sheets;
}

/** The JPEG markers a picture is built from (frames, tables, scan); APPn
 *  and comment segments are metadata and are read, not refused. */
const JPEG_STRUCTURE = new Set([0xc0, 0xc1, 0xc2, 0xc4, 0xdb, 0xdd, 0xda]);
/** The PNG chunks a picture is built from or that carry metadata; text and
 *  EXIF chunks are read. Any other chunk cannot be inspected. */
const PNG_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "pHYs", "sRGB", "gAMA", "cHRM", "iCCP", "sBIT", "bKGD", "tIME", "eXIf", "tEXt", "iTXt", "zTXt"]);
const PNG_TEXT = new Set(["tEXt", "iTXt", "zTXt", "eXIf"]);
/** The text in bytes that are mostly not text (a picture's segments, the
 *  video after a motion photo): runs of eight printable characters or more,
 *  the way `strings` reads a binary. Every printable byte used to count, so a
 *  random tail spelled "VIN" or "SSN" between two symbols about once in 900
 *  motion photos and made an ordinary photo personal. */
const printable = (b: Uint8Array) => (Buffer.from(b).toString("latin1").match(/[\x20-\x7e]{8,}/g) ?? []).join(" ");
/** A whole file hidden inside a picture: a PDF or a ZIP (which is how an
 *  Office document travels). Unseen, so it keeps the picture personal. */
const EMBEDDED_DOCUMENT = /%PDF-|PK\x03\x04/;

/** What a raster carries beyond its pixels, read without decoding them: the
 *  printable text of every metadata segment and of any bytes after the
 *  picture, and whether it could be walked at all. A phone photo carries
 *  EXIF, XMP, an ICC profile and often a motion-photo video or HDR gain map
 *  after its end marker; refusing any of those made every phone photo
 *  personal (#5243, decision 40397). What decides is what they say. */
function containerOf(bytes: Uint8Array, format: string | undefined): { walked: boolean; text: string; embedded: boolean } {
  const b = Buffer.from(bytes);
  let text = "";
  let embedded = false;
  const read = (part: Uint8Array) => {
    const latin = Buffer.from(part).toString("latin1");
    if (EMBEDDED_DOCUMENT.test(latin)) embedded = true;
    text += ` ${printable(part)}`;
  };
  if (format === "png") {
    let at = 8;
    while (at + 12 <= b.length) {
      const size = b.readUInt32BE(at), type = b.toString("ascii", at + 4, at + 8);
      if (!PNG_CHUNKS.has(type) || at + size + 12 > b.length) return { walked: false, text, embedded };
      if (PNG_TEXT.has(type)) {
        const data = b.subarray(at + 8, at + 8 + size);
        if (type === "zTXt") {
          const nul = data.indexOf(0);
          try { read(Buffer.concat([data.subarray(0, Math.max(0, nul)), inflateSync(data.subarray(nul + 2))])); } catch { return { walked: false, text, embedded }; }
        } else read(data);
      }
      at += size + 12;
      if (type === "IEND") {
        if (at < b.length) read(b.subarray(at));
        return { walked: true, text, embedded };
      }
    }
    return { walked: false, text, embedded };
  }
  if (format === "jpeg") {
    let at = 2;
    while (at < b.length) {
      if (b[at] !== 0xff) return { walked: false, text, embedded };
      while (b[at] === 0xff) at++;
      const marker = b[at++] ?? 0;
      if (marker === 0xd9) {
        if (at < b.length) read(b.subarray(at));
        return { walked: true, text, embedded };
      }
      if (at + 2 > b.length) return { walked: false, text, embedded };
      const size = b.readUInt16BE(at);
      if (size < 2 || at + size > b.length) return { walked: false, text, embedded };
      const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
      if (!metadata && !JPEG_STRUCTURE.has(marker)) return { walked: false, text, embedded };
      if (metadata) read(b.subarray(at + 2, at + size));
      at += size;
      if (marker === 0xda) {
        while (at < b.length) {
          if (b[at] !== 0xff) { at++; continue; }
          const next = b[at + 1];
          if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) { at += 2; continue; }
          break;
        }
      }
    }
    return { walked: false, text, embedded };
  }
  // HEIC (every iPhone photo), WebP, GIF, TIFF, AVIF: sharp has already parsed
  // the container, and its metadata text is read by metadataText. A hidden
  // whole file is still looked for across the bytes.
  if (EMBEDDED_DOCUMENT.test(b.toString("latin1"))) embedded = true;
  return { walked: true, text, embedded };
}
/** Too few pixels to carry legible writing: a thumbnail, a placeholder, a
 *  one-pixel test image. Read from the header, so it holds even when the
 *  pixels cannot be decoded. */
const TOO_SMALL_FOR_WRITING = (width?: number, height?: number) => !!width && !!height && (width < 48 || height < 16 || width * height < 64 * 64);
export async function readPersonalDocumentLocally(input: DocumentInput): Promise<PersonalDocumentRead> {
  let forcePersonal = Boolean(input.vault);
  let needsLocalConnection = false;
  // A whole photo: one decodable page with nothing after its pixels. Only a
  // whole photo can be judged a picture of a thing (decision 40397 on #5243);
  // anything code cannot fully inspect stays personal.
  let wholePhoto = false;
  if (!input.vault && input.mime.startsWith("image/") && input.mime !== "image/svg+xml") {
    try {
      const metadata = await sharp(Buffer.from(input.bytes)).metadata();
      const container = containerOf(input.bytes, metadata.format);
      const said = `${container.text} ${metadataText(metadata)}`;
      // Too small to hold writing, and small enough to read every byte of: no
      // hidden file and nothing personal said anywhere in it means ordinary,
      // even when its container is malformed (the services kit's 1x1 preview).
      const tinyAndClean = TOO_SMALL_FOR_WRITING(metadata.width, metadata.height) && input.bytes.length <= 256 * 1024
        && !EMBEDDED_DOCUMENT.test(Buffer.from(input.bytes).toString("latin1")) && !personalIn(`${printable(input.bytes)} ${said}`);
      if (tinyAndClean && (metadata.pages || 1) === 1) {
        return { privacy: "normal", kind: "ordinary", fields: {}, sources: {}, missing: [], message: "This image is too small to hold a document." };
      }
      if ((metadata.pages || 1) > 1 || !container.walked || container.embedded || personalIn(said)) forcePersonal = true;
      else {
        wholePhoto = true;
        const stats = await sharp(Buffer.from(input.bytes)).stats();
        if (stats.channels.every((channel) => channel.min === channel.max)) {
          return { privacy: "normal", kind: "ordinary", fields: {}, sources: {}, missing: [], message: "This is an ordinary image." };
        }
      }
    } catch {
      // Unreadable images remain personal, unless every byte has been read and
      // the file is too small to hold a legible page (a 70-byte placeholder).
      const bytes = Buffer.from(input.bytes);
      if (bytes.length <= 8 * 1024 && !EMBEDDED_DOCUMENT.test(bytes.toString("latin1")) && !personalIn(printable(bytes))) {
        return { privacy: "normal", kind: "ordinary", fields: {}, sources: {}, missing: [], message: "This file is too small to hold a document." };
      }
      forcePersonal = true;
    }
  }
  let firstPage: Uint8Array | undefined;
  const seen: Seen = { written: false };
  const text = await personalDocumentText(input, () => { forcePersonal = true; }, input.assist ? (bytes) => { if (!firstPage) firstPage = bytes; } : undefined, seen);
  const pdf = input.mime === "application/pdf" || Buffer.from(input.bytes.subarray(0, 5)).toString() === "%PDF-";
  if (pdf && !forcePersonal && !seen.written && !personalIn(text)) {
    return { privacy: "normal", kind: "ordinary", fields: {}, sources: {}, missing: [], message: "This document is blank." };
  }
  const raw = input.mime === "image/svg+xml" ? new TextDecoder().decode(input.bytes) : "";
  const geometry = /^(?:svg|g|path|circle|line|rect|ellipse|polygon|polyline|defs|clipPath|mask|linearGradient|radialGradient|stop)$/;
  const vectorDrawing = !forcePersonal && !text.trim() && /^\s*<svg\b/.test(raw)
    && !/<[!?]|\b(?:href|aria-label|on\w+)\s*=/i.test(raw) && !personalIn(raw)
    && [...raw.matchAll(/<\s*\/?\s*([\w:-]+)/g)].every((tag) => geometry.test(tag[1]!));
  // Source code (Python, OpenSCAD, G-code and the like) is not a document a
  // person's papers arrive as; only what it actually says can make it personal.
  const code = /^text\/x[-.]/.test(input.mime) && !forcePersonal;
  // Text code read in full (a text file, or a PDF whose every page gave text or
  // was blank) is judged on what it says: "when unsure" is about what code
  // could not read (decision 40397 on #5243). A plain note or a datasheet with
  // no personal indicator is not a personal document; refusing every one of
  // them from shared Files was the strict rule's cost.
  // OCR of a scanned page is no full read, so only a real text layer counts.
  const fullyRead = !forcePersonal && (/^text\//.test(input.mime) || (pdf && seen.layer === true));
  const privacy = vectorDrawing ? "normal" : code || fullyRead ? (personalIn(text) ? "personal" : "normal") : wholePhoto && !forcePersonal ? photoPrivacy(text) : classifyPersonalText(text, forcePersonal);
  const fields = privacy === "personal" ? extractPersonalFields(text) : {};
  const sources: PersonalDocumentRead["sources"] = Object.fromEntries(Object.keys(fields).map((key) => [key, "code"]));
  let sentTo: string | null = null;
  const kind: PersonalDocumentRead["kind"] = privacy === "normal" ? "ordinary" : looksLikeBillOfSale(text) ? "bill-of-sale" : /registration/i.test(text) ? "registration" : "personal";
  // Only what this kind of paper carries can be missing, or be asked of an
  // AI: a bill of sale has no plate to check (#5839).
  const wanted = FIELDS_FOR_KIND[kind];
  if (privacy === "personal" && input.assist && wanted.some((field) => !fields[field])) {
    const missing = wanted.filter((field) => !fields[field]);
    try {
      // FREE-TEXT: labelled lines (VIN:, Plate:), read by extractPersonalFields
      const answer = await platform().ai.invoke({ orgId: input.assist.orgId, userId: input.assist.userId,
        privacy: "personal", capability: "personal-document-read", input: {
          prompt: `Copy only these missing fields as printed: ${missing.join(", ")}. Reply as labelled lines (${missing.map((field) => `${ANSWER_LABEL[field]}:`).join(", ")}). Do not guess.\n${text}`,
          ...(firstPage ? { image_b64: Buffer.from(firstPage).toString("base64"), image_media_type: "image/png" } : input.mime.startsWith("image/") ? { image_b64: Buffer.from(input.bytes).toString("base64"), image_media_type: input.mime } : {}),
        } });
      const filled = extractPersonalFields(answer.text);
      // Read by the cloud connection the workspace's owner consented to
      // (#5621), or by a local model: said per field, and in the message.
      // Only a provider known to be a cloud one is named as such: the router
      // reaches one here only with the owner's consent.
      const def = answer.provider_id ? platform().ai.getProvider?.(answer.provider_id) : null;
      const cloud = !!def && def.locality !== "local";
      if (cloud) sentTo = def.company ?? def.label;
      for (const field of missing) if (filled[field]) { fields[field] = filled[field]; sources[field] = cloud ? "cloud-ai" : "local-ai"; }
    } catch (error) { needsLocalConnection = refusalCodeOf(error) === "no_provider"; }
  }
  const missing = wanted.filter((field) => !fields[field]);
  // A bill of sale shows only what a sale carries: its "Fee:" is a
  // documentary fee, not the price, which the purchase filing reads line by
  // line (the review's sale showed "Amount 80.00").
  if (kind === "bill-of-sale") {
    for (const key of Object.keys(fields) as PersonalDocumentField[]) if (!wanted.includes(key)) { delete fields[key]; delete sources[key]; }
  }
  return { privacy, kind, fields,
    ...(privacy === "personal" && renewalDocumentTypeIn(text) ? { renewalType: renewalDocumentTypeIn(text)!.id } : {}),
    sources, missing,
    message: privacy === "normal" ? "This is an ordinary document." : missing.length
      ? `${readWhere(sentTo)} Please check ${missing.join(", ")}; they could not be read.${needsLocalConnection ? " Connect a local AI in Configuration, AI to help with the missing fields." : ""}${sentNote(sentTo)}`
      : `${readWhere(sentTo)} Check these values before using them.${sentNote(sentTo)}` };
}

/** Where a personal document was read, in the words the card shows. */
function readWhere(sentTo: string | null): string {
  return sentTo ? `Read on this server and by ${sentTo}, as this workspace's owner chose.` : "Read on this server.";
}
function sentNote(sentTo: string | null): string {
  return sentTo ? "" : " This document has not been sent to a cloud AI.";
}
