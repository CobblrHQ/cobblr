// Shared camera + decode tuning for the live barcode scanner.
//
// A scanner design that earned the "fast on an
// iPhone without moving the phone" feel through two levers that have
// nothing to do with the decode library and everything to do with the
// CAMERA: (1) lock to a *plain* wide rear lens — never the ultra-wide
// (can't focus close) or the virtual "triple/dual" composite (it
// auto-switches lenses mid-scan and ruins the read); (2) ask the track
// for continuous autofocus so the barcode stays sharp as the phone
// moves. No zoom / focusDistance needed.

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

/** Formats for the native `BarcodeDetector` (string names, same set). */
export const NATIVE_FORMATS = [
  "upc_a",
  "upc_e",
  "ean_13",
  "ean_8",
  "code_128",
  "code_39",
  "qr_code",
  "data_matrix",
];

/**
 * A ZXing reader tuned for snappy live scanning. ZXing's default is
 * 500ms between decode attempts — far too sluggish; ~110ms makes the
 * reader feel near-instant.
 */
/** Idle between decode attempts.
 *
 *  Was 110ms, chosen blind. ?diag=1 on the reference iPhone (2026-08-05) measured a
 *  166ms cycle at 6 attempts/sec — and since that interval is decode PLUS this
 *  delay, the decode itself is only ~56ms: two thirds of every cycle was
 *  deliberate idle while he held the phone still waiting for a read.
 *
 *  40ms roughly doubles the attempt rate (~10/s). Not zero: each attempt is
 *  real CPU on a phone, and pinning the main thread at ~100% duty for a whole
 *  shelf-walk costs battery and heat for reads that arrive a few ms sooner.
 *  Override with ?scandelay=N to A/B on a real shelf without a deploy. */
const DEFAULT_SCAN_DELAY_MS = 40;

/** A positive integer query override, else the default. Shared by the scan
 *  tuning knobs so an experiment never needs a deploy. */
export function numericOverride(
  name: string,
  fallback: number,
  max: number,
  /** The query string. Defaults to the live location — passed explicitly by the
   *  test, because the web unit env has no DOM and a `window` reference here
   *  would make this rule untestable (the same trap as scanQuantity's timer). */
  search?: string,
): number {
  try {
    const s = search ?? (typeof window === "undefined" ? "" : window.location.search);
    const raw = new URLSearchParams(s).get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > max) return fallback;
    return n;
  } catch {
    return fallback;
  }
}

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

/** The idle our own loop waits between attempts (?scandelay overrides). The
 *  reader's own delay options are unused now that we drive the loop, so this is
 *  the single source of cadence. */
export const SCAN_ATTEMPT_DELAY_MS = numericOverride("scandelay", DEFAULT_SCAN_DELAY_MS, 2000);

export function createBarcodeReader(): BrowserMultiFormatReader {
  return new BrowserMultiFormatReader(HINTS, {
    delayBetweenScanAttempts: SCAN_ATTEMPT_DELAY_MS,
    delayBetweenScanSuccess: 800,
  });
}

/** Force a lens for an experiment: ?lens=triple|ultrawide|wide|tele.
 *  Matched against the device LABEL, so it degrades to the normal pick on a
 *  browser that doesn't expose that lens.
 *
 *  "wide" is an EXACT match on "back camera" on purpose. The first version
 *  used /back camera|wide/ — and on an iPhone "Back Dual Wide Camera" and
 *  "Back Ultra Wide Camera" both contain "wide" and enumerate BEFORE "Back
 *  Camera", so the control arm of a lens A/B silently became a virtual
 *  composite while the report printed lens=wide (review, 2026-08-05). No
 *  exact match → null → the default scorer, which already picks the plain
 *  wide, so nothing is lost on other label schemes. */
export function lensOverride(search?: string): RegExp | null {
  try {
    const s = search ?? (typeof window === "undefined" ? "" : window.location.search);
    const v = (new URLSearchParams(s).get("lens") || "").toLowerCase();
    if (v === "triple") return /triple|dual/;
    if (v === "ultrawide" || v === "ultra" || v === "macro") return /ultra/;
    if (v === "tele") return /tele/;
    if (v === "wide") return /^back camera$/;
    return null;
  } catch {
    return null;
  }
}

/**
 * Score-pick the best rear lens from enumerated devices.
 *
 * NOTE ON THE RANKING, which was inverted for iPhone (reported 2026-08-05): the
 * "ultra-wide can't focus near" premise is true of most ANDROID ultra-wides
 * (fixed focus) and FALSE on iPhone 13 Pro and later, where the ultra-wide
 * gained autofocus and IS the macro lens (~2cm) while the main wide bottoms out
 * around 15-20cm. His ?diag=1 confirmed Safari exposes all seven lenses
 * individually, so the choice is real — but a bare ultra-wide is 0.5x, which
 * puts FEWER pixels on a barcode at normal distance, so it is only better up
 * close. The virtual triple camera is the one that gets both (iOS hands over to
 * macro when you close in) at the cost of a possible switch mid-decode.
 *
 * Which of those actually feels better is a shelf question, not a code
 * question, so the default is unchanged and ?lens= makes it A/B-able.
 */
export function pickRearCameraId(devices: MediaDeviceInfo[], search?: string): string | null {
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (cams.length === 0) return null;
  if (cams.length === 1) return cams[0]!.deviceId || null;
  const rear = cams.filter((d) => /back|rear|environment/i.test(d.label));
  const pool = rear.length ? rear : cams;

  const forced = lensOverride(search);
  if (forced) {
    const hit = pool.find((d) => forced.test(d.label.toLowerCase()));
    if (hit) return hit.deviceId || null;
  }

  const score = (label: string): number => {
    const l = label.toLowerCase();
    if (/ultra/.test(l)) return 0; // 0.5x — too few pixels on the code except up close
    if (/tele|zoom/.test(l)) return 1; // telephoto — wrong working distance
    if (/triple|dual/.test(l)) return 2; // virtual auto-switching camera
    return 3; // a plain single rear lens ← wins
  };
  return [...pool].sort((a, b) => score(b.label) - score(a.label))[0]!.deviceId || null;
}

/** Resolution we ask for; a sharp 1080p frame decodes small barcodes well. */
const BASE_VIDEO = { width: { ideal: 1920 }, height: { ideal: 1080 } };

export interface ScannerStream {
  stream: MediaStream;
  /** The lens we locked to — reuse on every re-arm so it never switches. */
  deviceId: string | null;
}

/**
 * Acquire a camera stream pinned to the best rear lens with continuous
 * autofocus. Two-phase, because device *labels* aren't readable until
 * permission is granted:
 *   1. grab any rear camera (`facingMode: environment`) → triggers the prompt
 *   2. enumerate, score-pick the best lens, and if it differs, stop the
 *      initial stream and re-acquire LOCKED to that exact deviceId.
 * Pass `preferredDeviceId` on a re-arm to skip the dance and reuse the lens.
 */
export async function acquireScannerStream(
  preferredDeviceId?: string | null,
): Promise<ScannerStream> {
  const finalize = (stream: MediaStream, deviceId: string | null): ScannerStream => {
    const track = stream.getVideoTracks()[0] ?? null;
    enableContinuousAutofocus(track);
    applyZoomOverride(track);
    return { stream, deviceId };
  };

  // Re-arm path: reuse the locked lens so the camera never switches.
  if (preferredDeviceId) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: preferredDeviceId }, ...BASE_VIDEO },
      audio: false,
    });
    return finalize(stream, preferredDeviceId);
  }

  // First open: grab ANY rear camera (this triggers the permission prompt).
  const initial = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, ...BASE_VIDEO },
    audio: false,
  });

  // Now labels are readable → pick the best lens; re-acquire locked if it differs.
  let best: string | null = null;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    best = pickRearCameraId(devices);
  } catch {
    // enumerateDevices can reject in odd contexts; the initial stream is fine.
  }
  const current = initial.getVideoTracks()[0]?.getSettings().deviceId ?? null;
  if (best && best !== current) {
    initial.getTracks().forEach((t) => t.stop());
    const locked = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: best }, ...BASE_VIDEO },
      audio: false,
    });
    return finalize(locked, best);
  }
  return finalize(initial, current);
}

/**
 * Ask the camera track for continuous autofocus — keeps a barcode
 * sharp as the phone moves. Best-effort; not every device exposes it.
 */
/** Apply ?zoom=N when the track supports it. Zoom puts more pixels on a distant
 *  barcode without walking closer — the reference iPhone reports 1-10 available. Off by
 *  default: narrowing the field of view costs aim, and which trade wins is a
 *  shelf question. */
export function applyZoomOverride(track: MediaStreamTrack | null): void {
  if (!track) return;
  const zoom = numericOverride("zoom", 0, 10);
  if (!zoom) return;
  const caps = (track as unknown as { getCapabilities?: () => { zoom?: unknown } }).getCapabilities?.();
  if (!caps || !("zoom" in caps)) {
    console.warn("[scan] ?zoom ignored - this camera reports no zoom capability");
    return;
  }
  track
    .applyConstraints({ advanced: [{ zoom }] } as unknown as MediaTrackConstraints)
    .catch((e: unknown) => console.warn("[scan] zoom refused:", (e as Error)?.name ?? e));
}

export function enableContinuousAutofocus(track: MediaStreamTrack | null): void {
  if (!track) return;
  track
    .applyConstraints({
      advanced: [{ focusMode: "continuous" }],
    } as unknown as MediaTrackConstraints)
    // A swallowed rejection here is a LIE the scanner tells about itself: on a
    // browser that refuses the focusMode constraint the app believes it has
    // continuous autofocus while the user hunts for focus distance by hand, and
    // nothing anywhere says otherwise. Warn — cheap, and it turns a silent
    // capability gap into a visible one. (?diag=1 reports it properly.)
    .catch((e: unknown) => {
      console.warn(
        "[scan] continuous autofocus refused by this browser:",
        (e as Error)?.name ?? e,
      );
    });
}

/** Longest-side cap for uploaded viewfinder captures. Vision pipelines resize
 * to ~1.5k on the long edge anyway, so a full 1080p-4K frame spends cell-plan
 * bytes and upload seconds for zero recognition gain. */
export const CAPTURE_MAX_SIDE = 1600;

/** Pure: dimensions capped at maxSide on the longest edge. Never upscales. */
export function scaledDims(
  w: number,
  h: number,
  maxSide = CAPTURE_MAX_SIDE,
): { w: number; h: number } {
  const scale = Math.min(1, maxSide / Math.max(w || 1, h || 1));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** Grab the current viewfinder frame as an upload-ready JPEG (downscaled). */
export function captureFrame(
  video: HTMLVideoElement,
  maxSide = CAPTURE_MAX_SIDE,
): Promise<Blob | null> {
  if (video.readyState < 2 || !video.videoWidth) return Promise.resolve(null);
  const { w, h } = scaledDims(video.videoWidth, video.videoHeight, maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return Promise.resolve(null);
  g.drawImage(video, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
}

/** Whether this camera track exposes a controllable torch. */
export function cameraHasTorch(track: MediaStreamTrack | null): boolean {
  if (!track) return false;
  const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean };
  return !!caps.torch;
}

/** Toggle the torch on a camera track. Returns true if it took. */
export async function setTorch(
  track: MediaStreamTrack | null,
  on: boolean,
): Promise<boolean> {
  if (!track) return false;
  try {
    await track.applyConstraints({
      advanced: [{ torch: on }],
    } as unknown as MediaTrackConstraints);
    return true;
  } catch {
    return false;
  }
}
