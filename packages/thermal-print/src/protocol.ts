// Phomemo thermal-label protocol — the pure, isomorphic core.
//
// Phomemo M-series printers (M110 / M120 / M220 / M22x) are Bluetooth-only and
// speak a variant of EPSON ESC/POS: a header (speed / density / media), a
// `GS v 0` raster bit-image body, and a feed/present footer. This module turns a
// 1-bit bitmap into that byte stream and back-pressures it into BLE-sized chunks.
//
// It is deliberately dependency-free and free of any I/O or DOM/Web-Bluetooth
// reference, so the SAME file drives every transport:
//   • the standalone printer self-test site (Web Bluetooth, characteristic 0xff02),
//   • in-app label printing later (same Web Bluetooth path), and
//   • a future edge/Pi helper (Node).
//
// Command framing reverse-engineered by vivier/phomemo-tools
// (https://github.com/vivier/phomemo-tools). The M220's write characteristic is
// the classic Phomemo 0xff02 (service 0xff00), confirmed against real hardware.
//
// NOTE: `speed` / `density` / `media` / `init` DEFAULTS below are provisional;
// they are being pinned against a real M220 via the self-test flow (and the dev
// harness at core/_tmp/phomemo-test.html). The raster framing itself is stable.

export type PhomemoMedia = "continuous" | "gaps" | "marks";

/** Media-type byte written after `1F 11`. `continuous` prints the raster onto
 *  whatever is loaded without gap/mark registration — the safe default when the
 *  loaded stock is unknown (it never does a calibration feed that ejects a blank). */
export const MEDIA_BYTE: Record<PhomemoMedia, number> = {
  gaps: 0x0a, // die-cut labels with gaps
  continuous: 0x0b, // continuous roll
  marks: 0x26, // labels with black registration marks
};

/** 203 dpi ≈ 8 dots/mm — the M-series head resolution. */
export const PHOMEMO_DPI = 203;

/** Convert a millimetre media width to raster dots (dots-per-line). The correct
 *  width is MEDIA-dependent, not a fixed printer constant: 40 mm → 320, the
 *  M220's ~72 mm max printable → 576. */
export function mmToDots(mm: number, dpi: number = PHOMEMO_DPI): number {
  return Math.round((mm / 25.4) * dpi);
}

/** Inverse of mmToDots: raster dots back to millimetres. Used to reconstruct a
 *  media width from a pre-D3 printer that stored only `widthDots`. dots→mm→dots is
 *  an exact identity for integer dots (the 25.4 and dpi cancel), so a synthesized
 *  media reprojects to the same widthDots — keep the result UNrounded to preserve
 *  that (round only for display). */
export function dotsToMm(dots: number, dpi: number = PHOMEMO_DPI): number {
  return (dots / dpi) * 25.4;
}

/** Millimetres to inches, for the DISPLAY affordance on the mm-native settings UI
 *  (label media is often spec'd in inches: 1.5", 2", 4x6"). Geometry stays mm
 *  internally (spec section 7); this is presentation only. */
export function mmToInch(mm: number): number {
  return mm / 25.4;
}

export interface PhomemoOptions {
  /** Print speed 1..5. */
  speed?: number;
  /** Print density / darkness 1..15. */
  density?: number;
  /** Loaded media type. */
  media?: PhomemoMedia;
  /** Prepend `ESC @` (1B 40) to reset the printer before the job. */
  init?: boolean;
}

const DEFAULTS: Required<PhomemoOptions> = {
  speed: 3,
  density: 8,
  media: "continuous",
  init: true,
};

export interface MonoBitmap {
  /** Width in dots. MUST match the loaded media width or the image clips/mis-packs. */
  width: number;
  /** Height in dots (feed direction). */
  height: number;
  /** ceil(width / 8) — bytes per raster line. */
  bytesPerLine: number;
  /** 1 bpp, MSB-first, row-major, `bytesPerLine * height` bytes. Bit set = black dot. */
  rows: Uint8Array;
}

/**
 * Pack an RGBA pixel buffer (e.g. a canvas `ImageData.data`) into a 1-bpp,
 * MSB-first bitmap. A pixel prints (bit = 1) when it is sufficiently opaque AND
 * darker than `threshold` (0..255). Left-most pixel of each byte is the high bit,
 * matching how `GS v 0` clocks dots out of the head.
 */
export function packMonoBitmap(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  threshold = 128,
): MonoBitmap {
  if (width <= 0 || height <= 0) throw new Error("packMonoBitmap: width and height must be positive");
  const bytesPerLine = Math.ceil(width / 8);
  const rows = new Uint8Array(bytesPerLine * height);
  for (let y = 0; y < height; y++) {
    const rowBase = y * bytesPerLine;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if ((rgba[i + 3] ?? 0) <= 10) continue; // transparent → white
      const lum = 0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0);
      if (lum < threshold) {
        const bi = rowBase + (x >> 3);
        rows[bi] = (rows[bi] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return { width, height, bytesPerLine, rows };
}

/** Max raster lines per `GS v 0` block. The height field is 16-bit, but firmware
 *  is happiest with modest blocks, so tall labels are split. */
const BLOCK_LINES = 255;

/**
 * Encode a bitmap as the full Phomemo command stream:
 *   header  → 1B 4E 0D <speed> · 1B 4E 04 <density> · 1F 11 <media>   (+ optional 1B 40 init)
 *   body    → one or more `GS v 0` (1D 76 30 00) raster blocks, height-chunked
 *   footer  → 1F F0 05 00 · 1F F0 03 00   (feed / present)
 * Pure — returns bytes, performs no I/O.
 */
export function encodePhomemo(bmp: MonoBitmap, opts: PhomemoOptions = {}): Uint8Array {
  const { speed, density, media, init } = { ...DEFAULTS, ...opts };
  const { bytesPerLine, rows, height } = bmp;
  const out: number[] = [];

  if (init) out.push(0x1b, 0x40); // ESC @  — reset
  out.push(0x1b, 0x4e, 0x0d, speed & 0xff); // print speed
  out.push(0x1b, 0x4e, 0x04, density & 0xff); // print density
  out.push(0x1f, 0x11, MEDIA_BYTE[media]); // media type

  for (let y0 = 0; y0 < height; y0 += BLOCK_LINES) {
    const h = Math.min(BLOCK_LINES, height - y0);
    // GS v 0, mode 0, bytesPerLine (16-bit LE), height (16-bit LE)
    out.push(0x1d, 0x76, 0x30, 0x00, bytesPerLine & 0xff, (bytesPerLine >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff);
    const start = y0 * bytesPerLine;
    for (let i = 0; i < h * bytesPerLine; i++) out.push(rows[start + i] ?? 0);
  }

  out.push(0x1f, 0xf0, 0x05, 0x00); // feed / present
  out.push(0x1f, 0xf0, 0x03, 0x00);
  return Uint8Array.from(out);
}

/** Split a byte stream into ≤`size` chunks for sequential BLE characteristic
 *  writes (0xff02 is write-without-response; the caller paces the writes). */
export function chunkForBle(bytes: Uint8Array, size = 180): Uint8Array[] {
  if (size <= 0) throw new Error("chunkForBle: size must be positive");
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  return chunks;
}
