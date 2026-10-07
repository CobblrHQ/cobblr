// The barcode DECODER (ZXing), apart from the camera helpers in
// barcodeScanner.ts. ZXing is about 120 KB gzipped, and the helpers are used
// by sheets the app shell loads up front (the capture sheet asks for a camera
// stream), so while the two lived in one file every first page load carried
// the decoder (#4945). Only a screen that is reading codes imports this, and
// the sheets that can be opened from anywhere import it when they open.

import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

// Narrow the decoder to the formats a real-world label/reel carries —
// retail 1D plus QR/DataMatrix. Fewer formats per frame = faster, with
// fewer false positives. TRY_HARDER trades a little CPU for reads on
// marginal / angled / low-light barcodes.
const FORMATS = [
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
];
const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, FORMATS],
  [DecodeHintType.TRY_HARDER, true],
]);
/** Same formats, no TRY_HARDER — see the sweepReader note. */
const SWEEP_HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.POSSIBLE_FORMATS, FORMATS],
]);

import { SCAN_ATTEMPT_DELAY_MS } from "./barcodeScanner";
import {
  angleWorthRotating,
  dominantStripeAngles,
  drawRotatedBy,
  grayscaleOf,
  straightenRegion,
} from "./barcodeOrientation";

export interface SmartDecodeResult {
  text: string | null;
  /** "upright" — first pass; "aimed" — decoded after rotating by the MEASURED
   *  axis. Reported in ?diag=1 so a field run can say which path is working. */
  via: "upright" | "aimed";
  /** The measured axis when one was found, whether or not it decoded. */
  angle: number | null;
  /** Width of the located barcode region as a FRACTION of the frame — the
   *  free signal auto-zoom needs ("the code is small in view"). Null when the
   *  estimator found nothing code-like. Resolution independent by design. */
  regionWidth: number | null;
}

/**
 * Decode a frame at ANY orientation: try upright, and on a miss MEASURE the
 * barcode's axis (structure tensor — see barcodeOrientation.ts) and decode once
 * more, rotated by exactly that angle.
 *
 * This replaces two failed generations of rotation handling:
 *  · ZXing's own TRY_HARDER retry, which is broken in @zxing/browser
 *    (HTMLCanvasElementLuminanceSource.rotate() swaps the pixels but never
 *    updates width/height, so the rotated buffer is read at the wrong stride
 *    and can never decode);
 *  · our blind 90° retry, which fixed perpendicular codes but covered only one
 *    orientation and DOUBLED the chances of a diagonal slice misreading as a
 *    shorter checksum-valid code (a UPC-A scanned as EAN-8 "33720272" at ~45°,
 *    reported 2026-08-05).
 * Measuring first means ONE aimed attempt, only when something stripe-like is
 * actually in frame — fewer decode passes on junk, not more.
 */
/** The SWEEP reader: same formats, but no TRY_HARDER.
 *
 *  TRY_HARDER triples the cost of a miss (66ms vs 19.5ms on a 1080x1920
 *  frame, measured 2026-08-05) and the effort it buys is mostly its own
 *  rotated retry — the broken one this module routes around by measuring the
 *  angle instead. Every frame with no code in it paid that toll, which is why
 *  the loop fell to 2.2 attempts/sec on the reference phone. The upright sweep runs
 *  lean; the passed-in thorough reader still does the AIMED passes, where a
 *  code has actually been located and maximum effort is worth paying for. */
let sweepReader: BrowserMultiFormatReader | null = null;
export function decodeUpright(frame: HTMLCanvasElement): string | null {
  sweepReader ??= new BrowserMultiFormatReader(SWEEP_HINTS);
  try {
    return sweepReader.decodeFromCanvas(frame).getText();
  } catch {
    return null;
  }
}

/** Misses since the blind-90 guess last ran — see the amortisation note. */
let missesSinceBlind = 0;
/** Run the blind guess on one miss in this many. */
const BLIND_EVERY = 4;

export function decodeCanvasSmart(
  reader: BrowserMultiFormatReader,
  frame: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
): SmartDecodeResult {
  const up = decodeUpright(frame);
  // An upright read needed no measurement, so there is no region to report —
  // and none is needed: a code that decodes is big enough by definition.
  if (up !== null) return { text: up, via: "upright", angle: null, regionWidth: null };

  const tryAt = (deg: number): string | null => {
    if (!drawRotatedBy(frame, scratch, -deg)) return null;
    try {
      return reader.decodeFromCanvas(scratch).getText();
    } catch {
      return null;
    }
  };

  // Up to two MEASURED candidates (a busy product frame has competing coherent
  // structure — box text votes for its own axis, so the runner-up cluster is
  // often the barcode), then a blind 90° floor if nothing near-perpendicular
  // was tried: perpendicular is by far the most common non-upright hold, and
  // the floor restores the guarantee the blind-90 era had.
  const gray = grayscaleOf(frame);
  const all = gray ? dominantStripeAngles(gray) : [];
  // Report the widest located cluster whatever its angle — an upright-but-tiny
  // code is exactly the case auto-zoom exists for, and it never reaches the
  // rotate filter below.
  const regionWidth = all.length ? Math.max(...all.map((c) => c.region.hw * 2)) : null;
  const candidates = all.filter((c) => angleWorthRotating(c.angle));
  let lastAngle: number | null = candidates[0]?.angle ?? null;
  let triedNear90 = false;
  for (const c of candidates) {
    if (Math.abs(c.angle - 90) < 20) triedNear90 = true;
    // Straighten the LOCATED region, not the whole frame — see straightenRegion.
    if (straightenRegion(frame, scratch, c)) {
      try {
        return { text: reader.decodeFromCanvas(scratch).getText(), via: "aimed", angle: c.angle, regionWidth };
      } catch {
        /* this candidate missed — next */
      }
    }
  }
  // The blind 90° floor is a GUESS made when the measurement found nothing —
  // and it is the single most expensive step (a full-frame rotate + decode,
  // ~91ms). Paying it on every miss is what a shelf full of no-barcode frames
  // did. Amortised: one miss in four still covers perpendicular within a few
  // hundred ms, at a quarter of the cost.
  missesSinceBlind += 1;
  if (!triedNear90 && missesSinceBlind >= BLIND_EVERY) {
    missesSinceBlind = 0;
    const text = tryAt(90);
    if (text) return { text, via: "aimed", angle: 90, regionWidth };
  }
  return { text: null, via: candidates.length ? "aimed" : "upright", angle: lastAngle, regionWidth };
}

export function createBarcodeReader(): BrowserMultiFormatReader {
  return new BrowserMultiFormatReader(HINTS, {
    delayBetweenScanAttempts: SCAN_ATTEMPT_DELAY_MS,
    delayBetweenScanSuccess: 800,
  });
}
