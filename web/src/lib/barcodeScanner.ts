// Shared camera + decode tuning for the live barcode scanner.
//
// Ported from the companion app scanner, which earned the "fast on an
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
const HINTS = new Map<DecodeHintType, unknown>([
  [
    DecodeHintType.POSSIBLE_FORMATS,
    [
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.DATA_MATRIX,
    ],
  ],
  [DecodeHintType.TRY_HARDER, true],
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
export function createBarcodeReader(): BrowserMultiFormatReader {
  return new BrowserMultiFormatReader(HINTS, {
    delayBetweenScanAttempts: 110,
    delayBetweenScanSuccess: 800,
  });
}

/**
 * Score-pick the best rear lens from enumerated devices. A *plain* wide
 * rear lens wins; ultra-wide / telephoto / virtual composite cameras are
 * penalised. Returns a deviceId, or null if nothing useful is found.
 */
export function pickRearCameraId(devices: MediaDeviceInfo[]): string | null {
  const cams = devices.filter((d) => d.kind === "videoinput");
  if (cams.length === 0) return null;
  if (cams.length === 1) return cams[0]!.deviceId || null;
  const rear = cams.filter((d) => /back|rear|environment/i.test(d.label));
  const pool = rear.length ? rear : cams;
  const score = (label: string): number => {
    const l = label.toLowerCase();
    if (/ultra/.test(l)) return 0; // ultra-wide — can't focus near
    if (/tele|zoom/.test(l)) return 1; // telephoto — wrong for close work
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
    enableContinuousAutofocus(stream.getVideoTracks()[0] ?? null);
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
export function enableContinuousAutofocus(track: MediaStreamTrack | null): void {
  if (!track) return;
  track
    .applyConstraints({
      advanced: [{ focusMode: "continuous" }],
    } as unknown as MediaTrackConstraints)
    .catch(() => {});
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
