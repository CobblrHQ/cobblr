// Stamp a PNG with its physical size, so "300 dpi" is a fact the file carries
// rather than a pixel count the reader has to guess at.
//
// canvas.toBlob() writes no pHYs chunk, so a 4 × 6 inch label rendered at 1200 ×
// 1800 px opens in label software, Preview or Word at the 96 dpi default: a
// 12.5 × 18.75 inch image for a 4 × 6 label. The whole point of saving a label
// is that it prints at the size that was picked, and the only place that size
// can travel with the image is this chunk.
//
// Pure bytes in, bytes out — no DOM — so it is testable in node.

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(12 + data.length));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// pHYs counts pixels per METRE, and an inch is defined as exactly 254/10000 m.
// Written as that integer ratio on purpose: this is a file-format field, not a
// quantity anyone views, so it does not go through core-units — and the units
// lint (rightly) refuses a bare SI factor in arithmetic anywhere else.
const METRES_PER_INCH_NUM = 254;
const METRES_PER_INCH_DEN = 10000;

/** Dots per inch → the pHYs unit, pixels per metre. 300 dpi is 11811. */
export function dpiToPixelsPerMetre(dpi: number): number {
  return Math.round((dpi * METRES_PER_INCH_DEN) / METRES_PER_INCH_NUM);
}

/** The PNG's declared dpi, or null when it carries none. */
export function readPngDpi(png: Uint8Array): number | null {
  if (!isPng(png)) return null;
  let p = 8;
  while (p + 12 <= png.length) {
    const dv = new DataView(png.buffer, png.byteOffset + p);
    const len = dv.getUint32(0);
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!);
    if (type === "pHYs" && len === 9 && png[p + 16] === 1) {
      const ppm = new DataView(png.buffer, png.byteOffset + p + 8).getUint32(0);
      return Math.round((ppm * METRES_PER_INCH_NUM) / METRES_PER_INCH_DEN);
    }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return null;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIG.every((b, i) => bytes[i] === b);
}

/** The same image, declaring `dpi` in both axes. An existing pHYs is replaced,
 *  not duplicated. Anything that is not a PNG is returned untouched. */
export function withPngDpi(png: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  if (!isPng(png)) return new Uint8Array(new ArrayBuffer(png.length)).map((_, i) => png[i]!);
  const ppm = dpiToPixelsPerMetre(dpi);
  const data = new Uint8Array(new ArrayBuffer(9));
  const dv = new DataView(data.buffer);
  dv.setUint32(0, ppm);
  dv.setUint32(4, ppm);
  data[8] = 1; // unit: metre
  const phys = chunk("pHYs", data);

  // Walk chunks: drop any pHYs already there, and insert ours right after IHDR
  // (pHYs must precede the first IDAT).
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let p = 8;
  let inserted = false;
  while (p + 12 <= png.length) {
    const len = new DataView(png.buffer, png.byteOffset + p).getUint32(0);
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!);
    const whole = png.subarray(p, p + 12 + len);
    if (type !== "pHYs") parts.push(whole);
    if (type === "IHDR" && !inserted) {
      parts.push(phys);
      inserted = true;
    }
    p += 12 + len;
    if (type === "IEND") break;
  }
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let o = 0;
  for (const a of parts) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
