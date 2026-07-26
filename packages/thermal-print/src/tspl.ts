// TSPL — the second protocol family, for LABEL printers (TSC-style).
//
// Cheap 2-inch label printers frequently speak TSPL rather than the ESC/POS raster
// dialect `protocol.ts` implements. A POLONO PM220S, for instance, is completely
// silent to ESC/POS on every characteristic and prints happily from TSPL over the
// same `ff02` pipe. TSPL is text-based and, critically, renders QR codes and text
// ON THE PRINTER — a label is a few hundred bytes instead of a ~10 KB raster.
//
// Everything here is pure string building: no I/O, browser and Node safe.

/** Where a printer's coordinate origin sits / which way the label prints out.
 *  0 and 1 differ by 180°; which one is "upright" is per-model (a PM220S needs 0,
 *  and defaulting to 1 prints every label upside down). */
export type TsplDirection = 0 | 1;

export interface TsplMedia {
  /** Label size in mm (the printable stock, not the liner). */
  widthMm: number;
  heightMm: number;
  /** Gap between die-cut labels in mm (0 for continuous). */
  gapMm: number;
  direction: TsplDirection;
  /** Feed offset in mm applied after calibration (TSPL OFFSET). */
  offsetMm?: number;
  /** Stop the printer advancing to the tear bar after each label
   *  (TSPL `SET TEAR OFF`).
   *
   *  WHY IT MATTERS: with tear on, the printer feeds a finished label out to be
   *  torn off and is meant to back-feed before printing the next one. A printer
   *  that does not know its media geometry — a roll with no code in it — cannot
   *  back-feed accurately, so it advances a whole label per print and one is
   *  wasted every time. Off keeps the stock where it is; the last label gets fed
   *  by hand. */
  tearOff?: boolean;
  /** 0–15ish; printer-specific darkness. */
  density?: number;
  /** 1–5ish; slower is crisper. */
  speed?: number;
}

const CRLF = "\r\n";

/** Header every TSPL job needs: media geometry + darkness + a cleared buffer. */
export function tsplHeader(m: TsplMedia): string {
  const lines = [
    `SIZE ${m.widthMm} mm,${m.heightMm} mm`,
    `GAP ${m.gapMm} mm,0 mm`,
    `DIRECTION ${m.direction}`,
  ];
  // Only ever emitted to turn tear OFF. Sending "SET TEAR ON" would override a
  // printer whose own default already works, which is the majority.
  if (m.tearOff) lines.push("SET TEAR OFF");
  if (m.offsetMm != null && m.offsetMm !== 0) lines.push(`OFFSET ${m.offsetMm} mm`);
  if (m.density != null) lines.push(`DENSITY ${m.density}`);
  if (m.speed != null) lines.push(`SPEED ${m.speed}`);
  lines.push("CLS");
  return lines.join(CRLF) + CRLF;
}

/** Make a payload safe to embed in a quoted TSPL argument.
 *
 *  TSPL is LINE-based: a CRLF ends the command. So escaping quotes alone is not
 *  enough — a payload containing a newline injects a whole new command (e.g. a
 *  part name carrying `"\r\nPRINT 99,99`). Label content comes from user data, so
 *  strip line breaks and control characters BEFORE escaping the quote/backslash. */
export function tsplQuote(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")            // never let a payload terminate the command
    .replace(/[\x00-\x1f\x7f]/g, "")     // other control bytes
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

export interface TsplTextOptions {
  x: number;
  y: number;
  /** Built-in bitmap font id: "1"=8x12 "2"=12x20 "3"=16x24 "4"=24x32 "5"=32x48 */
  font?: "1" | "2" | "3" | "4" | "5";
  rotation?: 0 | 90 | 180 | 270;
  xScale?: number;
  yScale?: number;
}

export function tsplText(content: string, o: TsplTextOptions): string {
  const { x, y, font = "2", rotation = 0, xScale = 1, yScale = 1 } = o;
  return `TEXT ${x},${y},"${font}",${rotation},${xScale},${yScale},"${tsplQuote(content)}"` + CRLF;
}

/** Filled rectangle — used for rules, ticks and calibration scales. */
export function tsplBar(x: number, y: number, width: number, height: number): string {
  return `BAR ${x},${y},${width},${height}` + CRLF;
}

export interface TsplQrOptions {
  x: number;
  y: number;
  /** Error correction: L 7% · M 15% · Q 25% · H 30%. H survives thermal wear best. */
  ecc?: "L" | "M" | "Q" | "H";
  /** Module size in dots (2–10). 4 ≈ 0.5 mm modules at 203 dpi. */
  cellWidth?: number;
  rotation?: 0 | 90 | 180 | 270;
}

/** The payoff of TSPL: the PRINTER renders the QR, so a label is a few hundred
 *  bytes and the code is always crisp (no threshold/scaling artefacts). */
export function tsplQr(content: string, o: TsplQrOptions): string {
  const { x, y, ecc = "H", cellWidth = 4, rotation = 0 } = o;
  return `QRCODE ${x},${y},${ecc},${cellWidth},A,${rotation},"${tsplQuote(content)}"` + CRLF;
}

/** TSPL BITMAP — for printers whose firmware lacks QRCODE (a POLONO PM220S
 *  renders TEXT and BAR but silently drops QRCODE). The caller supplies an
 *  already-rasterized 1-bpp bitmap; this package stays QR-library-free, exactly
 *  as the Phomemo path does.
 *
 *  NOTE the bit polarity flip: our MonoBitmap uses 1 = BLACK (what GS v 0 wants),
 *  but TSPL BITMAP treats 0 as the printed dot. Passing our rows through
 *  unchanged prints a photographic negative. */
export function tsplBitmap(
  x: number,
  y: number,
  bmp: { bytesPerLine: number; height: number; rows: Uint8Array },
  opts: { mode?: 0 | 1 | 2; invert?: boolean } = {},
): Uint8Array {
  const { mode = 0, invert = true } = opts;
  const head = new TextEncoder().encode(`BITMAP ${x},${y},${bmp.bytesPerLine},${bmp.height},${mode},`);
  const data = new Uint8Array(bmp.rows.length);
  for (let i = 0; i < bmp.rows.length; i++) data[i] = invert ? (~bmp.rows[i]! & 0xff) : bmp.rows[i]!;
  const tail = new TextEncoder().encode(CRLF);
  const out = new Uint8Array(head.length + data.length + tail.length);
  out.set(head, 0);
  out.set(data, head.length);
  out.set(tail, head.length + data.length);
  return out;
}

/** Assemble a job from mixed text commands and binary blobs (BITMAP data is raw
 *  bytes, so the whole job cannot be built as a string). */
export function encodeTsplParts(media: TsplMedia, parts: (string | Uint8Array)[], sets = 1, copies = 1): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [enc.encode(tsplHeader(media))];
  for (const p of parts) chunks.push(typeof p === "string" ? enc.encode(p) : p);
  chunks.push(enc.encode(tsplPrint(sets, copies)));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function tsplPrint(sets = 1, copies = 1): string {
  return `PRINT ${sets},${copies}` + CRLF;
}

/** Assemble a full job and encode to bytes for the transport. */
export function encodeTspl(media: TsplMedia, body: string, sets = 1, copies = 1): Uint8Array {
  return new TextEncoder().encode(tsplHeader(media) + body + tsplPrint(sets, copies));
}

// ── a standard QR label ─────────────────────────────────────────────────────
export interface QrLabelOptions {
  media: TsplMedia;
  payload: string;
  caption?: string;
  /** Dots to keep clear of the top edge — the calibrated dead zone. */
  topMarginDots?: number;
  qrCellWidth?: number;
}

/** The label Cobblr actually prints: a QR plus an optional caption, positioned
 *  inside the calibrated safe area. */
export function tsplQrLabel(o: QrLabelOptions): Uint8Array {
  const { media, payload, caption, topMarginDots = 0, qrCellWidth = 4 } = o;
  const widthDots = mmToDotsTspl(media.widthMm);
  const y = topMarginDots + 16;
  const qrSizeDots = qrCellWidth * 25;                 // ~25 modules for a short URL
  const x = Math.max(8, Math.round((widthDots - qrSizeDots) / 2));
  let body = tsplQr(payload, { x, y, ecc: "H", cellWidth: qrCellWidth });
  if (caption) body += tsplText(caption, { x, y: y + qrSizeDots + 8, font: "2" });
  return encodeTspl(media, body);
}

/** 203 dpi = 8 dots/mm — the near-universal cheap-thermal head resolution. */
export function mmToDotsTspl(mm: number, dpi = 203): number {
  return Math.round((mm * dpi) / 25.4);
}
