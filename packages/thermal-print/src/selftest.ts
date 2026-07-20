// The escalating printer self-test sequence.
//
// Each step prints something progressively more demanding and asks the user one
// yes/no-ish question; the answers + the raw diagnostics localise the fault:
//   1. alignment  → does the print reach BOTH edges and sit centred?  (pins width)
//   2. patterns   → do fine rules / checkers resolve, is the fill dark enough?
//                   (pins head health + density)
//   3. qr         → does a real QR SCAN?  (the end-to-end success criterion)
//
// The alignment + pattern targets are generated here as pure 1-bpp bitmaps (no
// canvas/DOM), so they are unit-testable and identical everywhere. The QR target
// is rendered by the site (it owns a QR lib + the real payload); this module only
// declares the step.

import type { MonoBitmap } from "./protocol.js";

export type SelfTestStepKind = "alignment" | "patterns" | "qr";

export interface SelfTestStep {
  id: SelfTestStepKind;
  title: string;
  /** What the user should do / look for. */
  instruction: string;
  /** The question whose answer is reported back. */
  question: string;
}

export const SELF_TEST_STEPS: readonly SelfTestStep[] = [
  {
    id: "alignment",
    title: "Alignment & width",
    instruction: "Prints a full-width frame with a centre cross and edge ticks.",
    question: "Does the frame reach both edges of the label and sit centred?",
  },
  {
    id: "patterns",
    title: "Head health & density",
    instruction: "Prints solid, checker, and fine-line bands.",
    question: "Are the fine lines crisp (no gaps/streaks) and the solid band fully black?",
  },
  {
    id: "qr",
    title: "Scan test",
    instruction: "Prints a real QR label.",
    question: "Does your phone camera scan the QR?",
  },
];

// ── a tiny pure 1-bpp raster canvas (MSB-first, matches protocol packing) ──
class MonoCanvas {
  readonly width: number;
  readonly height: number;
  readonly bytesPerLine: number;
  readonly rows: Uint8Array;

  constructor(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("MonoCanvas: dimensions must be positive");
    this.width = width;
    this.height = height;
    this.bytesPerLine = Math.ceil(width / 8);
    this.rows = new Uint8Array(this.bytesPerLine * height);
  }
  set(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const bi = y * this.bytesPerLine + (x >> 3);
    this.rows[bi] = (this.rows[bi] ?? 0) | (0x80 >> (x & 7));
  }
  hline(y: number, x0: number, x1: number, weight = 1): void {
    for (let w = 0; w < weight; w++) for (let x = x0; x <= x1; x++) this.set(x, y + w);
  }
  vline(x: number, y0: number, y1: number, weight = 1): void {
    for (let w = 0; w < weight; w++) for (let y = y0; y <= y1; y++) this.set(x + w, y);
  }
  fillRect(x0: number, y0: number, x1: number, y1: number): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y);
  }
  toBitmap(): MonoBitmap {
    return { width: this.width, height: this.height, bytesPerLine: this.bytesPerLine, rows: this.rows };
  }
}

/**
 * Full-width alignment target: a border frame (so a missing edge = wrong width),
 * a centre crosshair, corner L-marks, and 5 mm edge ticks along the top. Any dot
 * off the paper on the left/right immediately shows the media is narrower than
 * `width`; an off-centre frame shows a head/media offset.
 */
export function alignmentBitmap(width: number, height = 160): MonoBitmap {
  const c = new MonoCanvas(width, height);
  const right = width - 1;
  const bottom = height - 1;
  const t = 2; // line weight

  // border frame
  c.hline(0, 0, right, t);
  c.hline(bottom - t + 1, 0, right, t);
  c.vline(0, 0, bottom, t);
  c.vline(right - t + 1, 0, bottom, t);

  // centre crosshair
  const cx = width >> 1;
  const cy = height >> 1;
  c.vline(cx, cy - 24, cy + 24, t);
  c.hline(cy, cx - 24, cx + 24, t);

  // corner L-marks (heavier, so a clipped corner is obvious)
  const L = 28;
  c.hline(4, 4, 4 + L, 3); c.vline(4, 4, 4 + L, 3);
  c.hline(4, right - 4 - L, right - 4, 3); c.vline(right - 4, 4, 4 + L, 3);
  c.hline(bottom - 4, 4, 4 + L, 3); c.vline(4, bottom - 4 - L, bottom - 4, 3);
  c.hline(bottom - 4, right - 4 - L, right - 4, 3); c.vline(right - 4, bottom - 4 - L, bottom - 4, 3);

  // 5 mm ticks (40 dots at 203 dpi) along the top interior
  for (let x = 0; x <= width; x += 40) c.vline(x, t, t + 14, 1);

  return c.toBitmap();
}

/**
 * Head-health / density target: stacked full-width bands — solid black, a 2-dot
 * checker, then 1/2/3-dot horizontal and vertical rules. Streaks reveal dead
 * nozzles; grey solids reveal low density; blurred fine rules reveal too-high
 * density or speed.
 */
export function patternBandsBitmap(width: number, bandHeight = 40, gap = 8): MonoBitmap {
  const right = width - 1;
  const bands = 6;
  const height = bands * bandHeight + (bands - 1) * gap;
  const c = new MonoCanvas(width, height);

  let y = 0;
  const nextBand = () => { const y0 = y; y += bandHeight + gap; return y0; };

  // 1 · solid
  let y0 = nextBand();
  c.fillRect(0, y0, right, y0 + bandHeight - 1);

  // 2 · 2-dot checkerboard
  y0 = nextBand();
  for (let yy = y0; yy < y0 + bandHeight; yy += 2) for (let xx = ((yy - y0) / 2) % 2 === 0 ? 0 : 2; xx <= right; xx += 4) c.fillRect(xx, yy, Math.min(xx + 1, right), Math.min(yy + 1, y0 + bandHeight - 1));

  // 3 · 1-dot horizontal rules
  y0 = nextBand();
  for (let yy = y0; yy < y0 + bandHeight; yy += 2) c.hline(yy, 0, right, 1);

  // 4 · 2-dot horizontal rules
  y0 = nextBand();
  for (let yy = y0; yy < y0 + bandHeight; yy += 4) c.hline(yy, 0, right, 2);

  // 5 · 1-dot vertical rules
  y0 = nextBand();
  for (let xx = 0; xx <= right; xx += 2) c.vline(xx, y0, y0 + bandHeight - 1, 1);

  // 6 · 2-dot vertical rules
  y0 = nextBand();
  for (let xx = 0; xx <= right; xx += 4) c.vline(xx, y0, y0 + bandHeight - 1, 2);

  return c.toBitmap();
}
