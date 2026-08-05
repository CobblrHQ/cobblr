// Where is the barcode pointing? — the measured answer to "read it at any angle".
//
// A 1D barcode is decoded along scan lines, so an angled code cannot be solved
// by guessing rotations: a blind 90° retry covers exactly one extra orientation,
// and every blind attempt is another chance for a diagonal slice through the
// bars to decode as a DIFFERENT, checksum-valid code (a UPC-A yielded a valid
// EAN-8 "33720272" at ~45° — the author, 2026-08-05). Silently wrong beats not-read as
// the worst outcome, so more guessing was the wrong direction.
//
// The correct technique — what commercial scanners do — is to MEASURE the
// orientation and straighten the image once, precisely. Barcodes have a unique
// optical signature: a region whose gradients are strong AND mutually parallel
// (every bar edge points the same way). The structure tensor captures exactly
// that:
//
//   J = [ Σgx²   Σgxgy ]       dominant gradient angle θ = ½·atan2(2Σgxgy, Σgx²−Σgy²)
//       [ Σgxgy  Σgy²  ]       coherence = |λ1−λ2|/(λ1+λ2)  — 1 for perfect stripes
//
// The frame is downscaled (~256px) and split into tiles; tiles that look like
// stripes (high energy, high coherence) vote for their angle; a consistent vote
// is the barcode's axis. Rotating by MINUS that angle puts the scan axis
// horizontal, and ZXing — which is excellent at straight codes — does the rest.
// One aimed attempt, instead of N blind ones.
//
// Everything numeric is pure and DOM-free so it can be tested in node against
// synthetic stripe fields at known angles; the canvas glue lives at the bottom.

export interface GrayFrame {
  data: Uint8ClampedArray | Uint8Array; // luminance, row-major
  width: number;
  height: number;
}

export interface OrientationEstimate {
  /** The code's scan axis, degrees in [0, 180). 0 = already horizontal. */
  angle: number;
  /** 0..1 — how strongly the voting tiles agreed. */
  coherence: number;
  /** Where the voting tiles sit, in FRACTIONS of the frame (0..1) — centre and
   *  half-extent. The locate half of locate-straighten-decode: decoding the
   *  whole rotated frame lets unrelated content (box text landing in the same
   *  row band after rotation) poison ZXing's per-row black-point histogram —
   *  the bisected cause of "right angle, still no read" (2026-08-05). */
  region: { cx: number; cy: number; hw: number; hh: number };
}

/** Tile size for the tensor vote (px on the DOWNSCALED frame). Big enough to
 *  hold several bar periods, small enough that a barcode spans several tiles. */
const TILE = 16;
/** A tile must be this coherent to vote — stripes are high, texture low. Was
 *  0.6: on REAL frames (aliased bars, box text) so few tiles passed that the
 *  vote came from one or two card-edge tiles — agreement was a meaningless
 *  1.0 and the winner flipped with the content (a 60° code measured 152°,
 *  its perpendicular). Looser + clustered beats strict + degenerate. */
const TILE_COHERENCE_MIN = 0.45;
/** ...and carry at least this share of the strongest tile's gradient energy,
 *  so flat background tiles don't vote noise. */
const TILE_ENERGY_FLOOR = 0.06;
/** An angle cluster must hold this share of the coherent weight to be a
 *  candidate — the barcode does not need to OUTVOTE the box text, only to
 *  form its own consistent cluster. */
const CLUSTER_SHARE_MIN = 0.18;
/** Cluster bin width, degrees (mod 180). */
const BIN_DEG = 12;

/** Backwards-compatible single-answer form of dominantStripeAngles. */
export function dominantStripeAngle(frame: GrayFrame): OrientationEstimate | null {
  return dominantStripeAngles(frame)[0] ?? null;
}

/**
 * The stripe-axis CANDIDATES of a grayscale frame, strongest first (up to two),
 * or [] when nothing looks like a barcode (also valuable: skip the second
 * decode entirely).
 *
 * Two candidates rather than one because a real product frame contains
 * competing coherent structures — box text votes for its own axis — and the
 * barcode only has to form a consistent cluster, not win the popular vote.
 * Tiles vote into 12° bins (mod 180); each standing cluster (a peak bin plus
 * its neighbours) yields a candidate angle by doubled-angle vector averaging.
 */
export function dominantStripeAngles(frame: GrayFrame): OrientationEstimate[] {
  const { data, width: w, height: h } = frame;
  if (w < TILE * 2 || h < TILE * 2) return [];

  const tilesX = Math.floor(w / TILE);
  const tilesY = Math.floor(h / TILE);
  const jxx = new Float64Array(tilesX * tilesY);
  const jyy = new Float64Array(tilesX * tilesY);
  const jxy = new Float64Array(tilesX * tilesY);

  // Sobel over the interior; sums accumulate per tile.
  for (let y = 1; y < h - 1; y++) {
    const ty = Math.min(tilesY - 1, Math.floor(y / TILE));
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const gx =
        -data[i - w - 1]! - 2 * data[i - 1]! - data[i + w - 1]! +
        data[i - w + 1]! + 2 * data[i + 1]! + data[i + w + 1]!;
      const gy =
        -data[i - w - 1]! - 2 * data[i - w]! - data[i - w + 1]! +
        data[i + w - 1]! + 2 * data[i + w]! + data[i + w + 1]!;
      const t = ty * tilesX + Math.min(tilesX - 1, Math.floor(x / TILE));
      jxx[t]! += gx * gx;
      jyy[t]! += gy * gy;
      jxy[t]! += gx * gy;
    }
  }

  // Collect the voting tiles (doubled-angle so θ and θ+180 reinforce).
  let maxEnergy = 0;
  for (let t = 0; t < jxx.length; t++) maxEnergy = Math.max(maxEnergy, jxx[t]! + jyy[t]!);
  if (maxEnergy === 0) return [];

  interface Vote { angle: number; weight: number; twoX: number; twoY: number; tx: number; ty: number }
  const votes: Vote[] = [];
  let totalWeight = 0;
  for (let t = 0; t < jxx.length; t++) {
    const energy = jxx[t]! + jyy[t]!;
    if (energy < maxEnergy * TILE_ENERGY_FLOOR) continue;
    const d = jxx[t]! - jyy[t]!;
    const coherence = Math.sqrt(d * d + 4 * jxy[t]! * jxy[t]!) / energy;
    if (coherence < TILE_COHERENCE_MIN) continue;
    const two = Math.atan2(2 * jxy[t]!, d);
    let angle = (two / 2) * (180 / Math.PI);
    if (angle < 0) angle += 180;
    const weight = energy * coherence;
    votes.push({
      angle,
      weight,
      twoX: weight * Math.cos(two),
      twoY: weight * Math.sin(two),
      tx: (t % tilesX) * TILE,
      ty: Math.floor(t / tilesX) * TILE,
    });
    totalWeight += weight;
  }
  if (totalWeight === 0) return [];

  // Cluster by binning (mod 180). A cluster = a peak bin + its two neighbours.
  const bins = Math.ceil(180 / BIN_DEG);
  const binWeight = new Float64Array(bins);
  for (const v of votes) binWeight[Math.min(bins - 1, Math.floor(v.angle / BIN_DEG))]! += v.weight;

  const inCluster = (angle: number, peak: number): boolean => {
    const bin = Math.min(bins - 1, Math.floor(angle / BIN_DEG));
    const diff = Math.abs(bin - peak);
    return Math.min(diff, bins - diff) <= 1; // wrap-around neighbours
  };

  const out: OrientationEstimate[] = [];
  const used = new Set<number>();
  for (let k = 0; k < 2; k++) {
    let peak = -1;
    let peakW = 0;
    for (let b = 0; b < bins; b++) {
      if (used.has(b)) continue;
      let wsum = 0;
      for (let n = -1; n <= 1; n++) wsum += binWeight[(b + n + bins) % bins]!;
      if (wsum > peakW) { peakW = wsum; peak = b; }
    }
    if (peak < 0 || peakW < totalWeight * CLUSTER_SHARE_MIN) break;
    let vx = 0;
    let vy = 0;
    // The cluster's tiles both refine the angle AND locate the code: their
    // weighted bounding box is the region to straighten and decode.
    let minTx = Infinity, maxTx = -Infinity, minTy = Infinity, maxTy = -Infinity;
    for (const v of votes) {
      if (!inCluster(v.angle, peak)) continue;
      vx += v.twoX;
      vy += v.twoY;
      minTx = Math.min(minTx, v.tx); maxTx = Math.max(maxTx, v.tx);
      minTy = Math.min(minTy, v.ty); maxTy = Math.max(maxTy, v.ty);
    }
    if (vx === 0 && vy === 0) break;
    let angle = (Math.atan2(vy, vx) / 2) * (180 / Math.PI);
    if (angle < 0) angle += 180;
    // Tile centres → frame fractions, padded a tile each way for the margin
    // the estimate's coarseness needs.
    const pad = 1.5 * TILE;
    out.push({
      angle,
      coherence: peakW / totalWeight,
      region: {
        cx: ((minTx + maxTx) / 2 + TILE / 2) / w,
        cy: ((minTy + maxTy) / 2 + TILE / 2) / h,
        hw: ((maxTx - minTx) / 2 + pad) / w,
        hh: ((maxTy - minTy) / 2 + pad) / h,
      },
    });
    for (let n = -1; n <= 1; n++) used.add((peak + n + bins) % bins);
  }
  return out;
}

/** Is this axis worth a second decode? Near-horizontal was already tried
 *  upright; anything meaningfully off-axis is the aimed-rotate case. */
export function angleWorthRotating(angle: number, toleranceDeg = 8): boolean {
  return angle > toleranceDeg && angle < 180 - toleranceDeg;
}

/** Bounding box of a w×h image rotated by `deg`. The library bug this whole
 *  file routes around was a forgotten dimension update after rotation, so the
 *  size math stays its own tested function. */
export function rotatedBounds(w: number, h: number, deg: number): { w: number; h: number } {
  const r = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  // ceil so a diagonal never clips — minus an epsilon so cos(90°) = 6e-17
  // doesn't buy a phantom extra pixel at the right angles.
  const up = (v: number) => Math.ceil(v - 1e-9);
  return { w: up(c * w + s * h), h: up(s * w + c * h) };
}

// ── canvas glue (not unit-testable in node; exercised by the browser e2e) ──

/** Downscale a canvas to ~targetW and return its luminance. */
/** 512, not 256: at 256 a UPC module in a 1920px frame is ~0.5px — the bars
 *  alias away entirely and only the card's outline edges survive to vote,
 *  which is how a 60° code measured as its own perpendicular. */
export function grayscaleOf(src: HTMLCanvasElement, targetW = 512): GrayFrame | null {
  if (!src.width || !src.height) return null;
  const scale = Math.min(1, targetW / src.width);
  const w = Math.max(TILE * 2, Math.round(src.width * scale));
  const h = Math.max(TILE * 2, Math.round(src.height * scale));
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const ctx = small.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    // Rec.601 integer luma — cheap and plenty for gradients.
    gray[i] = (rgba[p]! * 77 + rgba[p + 1]! * 150 + rgba[p + 2]! * 29) >> 8;
  }
  return { data: gray, width: w, height: h };
}

/**
 * Straighten the located region: rotate ONLY the candidate's neighbourhood
 * about its own centre and crop to it. Decoding the whole rotated frame lets
 * unrelated content share the code's row band and poison the per-row black
 * point; the crop keeps the rows clean and is ~10x cheaper besides.
 */
export function straightenRegion(
  src: HTMLCanvasElement,
  dst: HTMLCanvasElement,
  est: OrientationEstimate,
): boolean {
  const cx = est.region.cx * src.width;
  const cy = est.region.cy * src.height;
  const rw = Math.max(64, est.region.hw * 2 * src.width);
  const rh = Math.max(64, est.region.hh * 2 * src.height);
  // After straightening, the region's diagonal bounds what can land in view.
  const { w, h } = rotatedBounds(rw, rh, est.angle);
  if (!w || !h) return false;
  dst.width = w;
  dst.height = h;
  const ctx = dst.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.fillStyle = "#808080"; // neutral for the binarizer — never black corners
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((-est.angle * Math.PI) / 180);
  ctx.drawImage(src, -cx, -cy);
  ctx.restore();
  return true;
}

/** Draw `src` rotated by `deg` into `dst` (resized to the rotated bounds). */
export function drawRotatedBy(src: HTMLCanvasElement, dst: HTMLCanvasElement, deg: number): boolean {
  const { w, h } = rotatedBounds(src.width, src.height, deg);
  if (!w || !h) return false;
  dst.width = w;
  dst.height = h;
  const ctx = dst.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  // NEUTRAL-GRAY the corners first. A fresh canvas is transparent, which the
  // luminance source reads as BLACK — and at 45° that is four giant black
  // triangles feeding the binarizer's block averages. The field signature was
  // exact: 90° (bounds swap, no corners) decoded through busy box text while
  // every diagonal failed on the same frame (repro 2026-08-05). Mid-gray is
  // histogram-neutral: it pushes the black point nowhere.
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
  return true;
}
