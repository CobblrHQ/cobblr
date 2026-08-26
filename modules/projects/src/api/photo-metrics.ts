// Is this image a PHOTOGRAPH or a DIAGRAM?
//
// A pattern PDF embeds both: the finished object on page one, and stitch
// charts, schematics and line drawings after it. The extractor ranks by size,
// and size does not know the difference — a full-page schematic outranks a
// half-page photo every time. So "the largest image" was the finished object
// only on PDFs laid out to make it so.
//
// Five numbers are measured here. Two of them make the floor in
// photo-picker.ts, and they were not the two this file was first written for:
//
//   SATURATION   line art, charts, logos and screenshots are grey; every
//                photograph in the corpus has colour in it.
//   SMOOTHNESS   a drawing, coloured or not, is flat runs broken by hard
//                edges; a photograph is grain and shading, so most neighbouring
//                pixels differ by a little.
//
// ENTROPY, FLAT-REGION share and PALETTE size were the first guesses. On the
// corpus a line chart out-scores a real board photo on entropy, a product shot
// on a white sweep is 64% flat, and a coloured schematic has as many colours
// as a photo. They stay as blank-and-tint sanity bounds only.
//
// None of these is a classifier. They are the numbers the scoreboard was
// measured on, and the floor in photo-picker.ts is set from that scoreboard,
// not from taste — see docs/design-decisions/pattern-photo-auto-pull.md.
//
// sharp is resolved dynamically for the same reason pdf-images.ts does it: it
// is hoisted at the repo root, not in this module's static graph.

export interface PhotoMetrics {
  /** Shannon entropy of the 8-bit luminance histogram, 0..8. Photos land
   *  around 6-7.8; line art around 1-4. */
  entropy: number;
  /** Share of pixels within a tight band of the single most common tone,
   *  0..1. Diagrams are 0.5+ (mostly paper); photos are typically < 0.25. */
  flat: number;
  /** Mean chroma (max−min of RGB per pixel, /255), 0..1. Grey line art is
   *  near 0; a colour photo is typically 0.1-0.4. */
  saturation: number;
  /** How many distinct colours carry real weight: 4-bit-per-channel bins that
   *  each hold at least 0.1% of the pixels. Measured hoping a coloured
   *  schematic would land in single digits; it did not (50, the same as a
   *  product shot), so this is reported but not used by the floor. */
  palette: number;
  /** The share of horizontally adjacent pixel pairs that differ by a LITTLE
   *  (1–12 luminance levels): continuous tone. A photograph is gradients and
   *  grain, so most pairs differ slightly; a line drawing, coloured or not, is
   *  flat runs broken by hard edges, so almost no pair does. This is the one
   *  signal that separates a coloured schematic from a photo on a white sweep
   *  — saturation and palette both put them side by side. */
  smooth: number;
}

/** Sample side: the metrics are statistical, so a 96px thumbnail answers the
 *  same as the full image and costs nothing. */
const SAMPLE = 96;

export async function photoMetrics(png: Buffer): Promise<PhotoMetrics> {
  const sharpMod = (await import("sharp")) as unknown as {
    default: (input: Buffer) => {
      resize(w: number, h: number, o: { fit: "inside" }): {
        removeAlpha(): { raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { channels: number; width: number } }> } };
      };
    };
  };
  const { data, info } = await sharpMod
    .default(png)
    .resize(SAMPLE, SAMPLE, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return metricsFromRaw(data, info.channels, info.width);
}

/** The arithmetic, separated so it can be tested on synthetic pixels without
 *  encoding a PNG. `channels` is 1 (grey) or 3 (RGB). */
export function metricsFromRaw(data: Uint8Array, channels: number, width?: number): PhotoMetrics {
  const n = Math.floor(data.length / channels);
  if (n === 0) return { entropy: 0, flat: 1, saturation: 0, palette: 0, smooth: 0 };
  // Row width for the neighbour test. Unknown → treat the raster as one row,
  // which only misclassifies the one pair per row that wraps.
  const w = width && width > 0 ? width : n;
  const lum = new Float32Array(n);

  const hist = new Uint32Array(256);
  // 4 bits per channel → 4096 bins. Coarse on purpose: JPEG noise must not
  // turn one flat fill into twenty "colours".
  const bins = new Uint32Array(4096);
  let chroma = 0;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    let l: number;
    if (channels >= 3) {
      const r = data[o]!, g = data[o + 1]!, b = data[o + 2]!;
      l = (r * 299 + g * 587 + b * 114) / 1000;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      bins[bin] = (bins[bin] ?? 0) + 1;
    } else {
      l = data[o]!;
    }
    const idx = Math.min(255, Math.max(0, Math.round(l)));
    hist[idx] = (hist[idx] ?? 0) + 1;
    lum[i] = l;
  }

  let entropy = 0;
  for (let v = 0; v < 256; v++) {
    const c = hist[v]!;
    if (!c) continue;
    const p = c / n;
    entropy -= p * Math.log2(p);
  }

  // The most common tone plus its immediate neighbours: JPEG noise smears a
  // flat fill across a few adjacent levels, and counting only the exact mode
  // undercounts paper by half.
  let mode = 0;
  let modeCount = hist[0] ?? 0;
  for (let v = 1; v < 256; v++) {
    const c = hist[v] ?? 0;
    if (c > modeCount) {
      mode = v;
      modeCount = c;
    }
  }
  let flatCount = 0;
  for (let v = Math.max(0, mode - 3); v <= Math.min(255, mode + 3); v++) flatCount += hist[v] ?? 0;

  let pairs = 0;
  let gentle = 0;
  for (let i = 1; i < n; i++) {
    if (i % w === 0) continue; // first pixel of a row has no left neighbour
    const d = Math.abs((lum[i] ?? 0) - (lum[i - 1] ?? 0));
    pairs++;
    if (d >= 1 && d <= 12) gentle++;
  }

  const weight = Math.max(1, Math.floor(n / 1000));
  let palette = 0;
  if (channels >= 3) for (let i = 0; i < bins.length; i++) if ((bins[i] ?? 0) >= weight) palette++;

  return {
    entropy,
    flat: flatCount / n,
    saturation: channels >= 3 ? chroma / n / 255 : 0,
    palette,
    smooth: pairs ? gentle / pairs : 0,
  };
}
