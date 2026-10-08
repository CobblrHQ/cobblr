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

/** The idle our own loop waits between attempts (?scandelay overrides). The
 *  reader's own delay options are unused now that we drive the loop, so this is
 *  the single source of cadence. */
export const SCAN_ATTEMPT_DELAY_MS = numericOverride("scandelay", DEFAULT_SCAN_DELAY_MS, 2000);


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
/** A browser that offers no camera at all, as opposed to one that refused:
 *  an http address (no secure context, so no `navigator.mediaDevices`) or a
 *  browser without one. Said in words, never as the TypeError reading
 *  `getUserMedia` of undefined, which a person was shown (#4286 role walk).
 *  The fix is not a permission, so the page does not suggest one. */
export class NoCameraHere extends Error {
  readonly noCamera = true;
}

export function noCameraReason(ctx: { isSecureContext?: boolean; mediaDevices?: unknown }): string | null {
  const md = ctx.mediaDevices as { getUserMedia?: unknown } | undefined;
  if (md && typeof md.getUserMedia === "function") return null;
  return ctx.isSecureContext === false
    ? "This address is not secure (http), so the browser offers no camera here. Open Cobblr at its https address, or scan an image file instead."
    : "This browser offers no camera here. Scan an image file instead, or open Cobblr in a browser that has one.";
}

export async function acquireScannerStream(
  preferredDeviceId?: string | null,
): Promise<ScannerStream> {
  const none = noCameraReason({ isSecureContext: window.isSecureContext, mediaDevices: navigator.mediaDevices });
  if (none) throw new NoCameraHere(none);
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
  // Never LIGHT the torch on a backgrounded page. A hidden document still owns
  // the camera, and lighting the lamp on a phone the user just locked and put
  // in a pocket is the one torch action that can never be wanted. Off is always
  // allowed - extinguishing must work from anywhere, including a teardown that
  // runs after the page is already hidden.
  if (on && typeof document !== "undefined" && document.visibilityState !== "visible") {
    return false;
  }
  try {
    await track.applyConstraints({
      advanced: [{ torch: on }],
    } as unknown as MediaTrackConstraints);
    return true;
  } catch {
    return false;
  }
}
