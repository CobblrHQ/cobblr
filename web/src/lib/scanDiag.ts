// Scan diagnostics — the facts you cannot get by reading the code.
//
// Four separate scan investigations (bug-queue items 3, 4, 5) all dead-ended on
// the same wall: what the CODE does is knowable, what the author's iPhone does is not.
// Which decode engine is live, whether the focus constraint was accepted, which
// lenses Safari exposes, how long a decode actually takes — every one of those
// is a device fact, and guessing at them would mean changing decode logic on a
// hunch. This collects them in one pass so a single scan on the shelf settles
// all three at once.
//
// Off unless asked for: `?diag=1` on the camera URL. It never renders, times,
// or enumerates anything for a normal user.

import { numericOverride } from "./barcodeScanner";

const DIAG_KEY = "cobblr.scan-diag";

/** On when the URL says ?diag=1, and sticky after that so a re-arm (which
 *  rebuilds the URL) doesn't lose it mid-investigation. ?diag=0 clears. */
export function scanDiagEnabled(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get("diag");
    if (q === "1") {
      sessionStorage.setItem(DIAG_KEY, "1");
      return true;
    }
    if (q === "0") {
      sessionStorage.removeItem(DIAG_KEY);
      return false;
    }
    return sessionStorage.getItem(DIAG_KEY) === "1";
  } catch {
    return false;
  }
}

// ── decode timings ────────────────────────────────────────────────
// A ring buffer, because a scan session is minutes long and only the recent
// shape matters. Timings are recorded around the DECODE call only — not the
// frame grab — so the number answers "is decoding the bottleneck?".
const RING = 120;
const times: number[] = [];
let attempts = 0;
let hits = 0;
let firstAt: number | null = null;

let rotAttempts = 0;
let rotHits = 0;
let lastAngle: number | null = null;

/** The most recent measured barcode axis (null = nothing stripe-like seen). */
export function recordOrientation(angle: number | null): void {
  if (angle !== null) lastAngle = angle;
}

/** `rotated` marks the second, quarter-turned pass. Counted separately so a
 *  report can say whether perpendicular codes are actually being read, rather
 *  than leaving it to be inferred. */
export function recordDecode(ms: number, found: boolean, rotated = false): void {
  attempts += 1;
  if (found) hits += 1;
  if (rotated) {
    rotAttempts += 1;
    if (found) rotHits += 1;
  }
  if (firstAt === null) firstAt = Date.now();
  times.push(ms);
  if (times.length > RING) times.shift();
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[i]!);
}

export interface DecodeStats {
  attempts: number;
  hits: number;
  rotAttempts: number;
  rotHits: number;
  lastAngle: number | null;
  p50: number;
  p95: number;
  worst: number;
  perSec: number;
}

export function decodeStats(): DecodeStats {
  const sorted = [...times].sort((a, b) => a - b);
  const elapsed = firstAt ? (Date.now() - firstAt) / 1000 : 0;
  return {
    attempts,
    hits,
    rotAttempts,
    rotHits,
    lastAngle,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    worst: sorted.length ? Math.round(sorted[sorted.length - 1]!) : 0,
    perSec: elapsed > 0 ? Math.round((attempts / elapsed) * 10) / 10 : 0,
  };
}

export function resetDecodeStats(): void {
  times.length = 0;
  attempts = 0;
  hits = 0;
  rotAttempts = 0;
  rotHits = 0;
  lastAngle = null;
  firstAt = null;
}

// ── torch (auto-flash) ────────────────────────────────────────────
// What the auto-torch saw and did — a wrong threshold is invisible without
// the measured luma next to the on/off decisions.

let torchLastLuma: number | null = null;
let torchLastFalloff: number | null = null;
let torchLastEvent = "idle";
let torchAutoOns = 0;

export function recordTorchSample(luma: number, falloff?: number): void {
  torchLastLuma = Math.round(luma);
  // The signal that actually survives auto-exposure — worth seeing on the
  // glass, since a brightness reading alone proved misleading in the field.
  if (typeof falloff === "number") torchLastFalloff = Math.round(falloff * 100) / 100;
}

export type TorchEvent = "auto-on" | "auto-off" | "manual-on" | "manual-off" | "apply-failed";

export function recordTorchEvent(e: TorchEvent): void {
  torchLastEvent = e;
  if (e === "auto-on") torchAutoOns += 1;
}

export function torchDiag(): {
  event: string;
  luma: number | null;
  falloff: number | null;
  autoOns: number;
} {
  return { event: torchLastEvent, luma: torchLastLuma, falloff: torchLastFalloff, autoOns: torchAutoOns };
}

// ── auto-zoom ─────────────────────────────────────────────────────

let zoomNow: number | null = null;
let zoomRefused = false;

/** null = the camera refused the constraint (recorded, never swallowed). */
export function recordZoom(z: number | null): void {
  if (z === null) zoomRefused = true;
  else zoomNow = z;
}

export function zoomDiag(): string {
  if (zoomRefused) return "REFUSED by the camera";
  return zoomNow === null ? "auto (not stepped yet)" : `auto ${zoomNow}x`;
}

// ── stream recovery ───────────────────────────────────────────────
// How often the frame-liveness watchdog had to restart a dead camera stream.
// Nonzero after an app-switch is the fix WORKING; nonzero during plain
// scanning means the stream is unstable and worth a look.

let streamRecoveries = 0;

export function recordStreamRecovery(): void {
  streamRecoveries += 1;
}

export function streamRecoveryCount(): number {
  return streamRecoveries;
}

// ── device facts ──────────────────────────────────────────────────

export interface CameraFacts {
  engine: string;
  nativeFormats: string[] | null;
  lenses: string[];
  picked: string;
  settings: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  focus: string;
  zoom: string;
  torch: string;
  /** The tuning knobs in force for THIS run, so a copied report says which
   *  configuration produced its numbers. Two A/B runs that silently used the
   *  same settings would otherwise look like a real difference. */
  tuning: string;
}

/** A capability value, flattened for display: ranges become "min-max". */
function brief(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as { min?: number; max?: number; step?: number };
    if (typeof o.min === "number" && typeof o.max === "number") return `${o.min}-${o.max}`;
  }
  if (Array.isArray(v)) return v.join("/");
  return v;
}

/**
 * Everything about the live camera that a code read cannot tell you.
 *
 * `focus` is the load-bearing one: enableContinuousAutofocus swallows its
 * rejection, so on a device where WebKit refuses the constraint the app claims
 * continuous AF while doing nothing — which would explain having to hunt for
 * focus distance. Here we re-apply it and REPORT the outcome.
 */
export async function collectCameraFacts(track: MediaStreamTrack | null): Promise<CameraFacts> {
  const nativeCtor = (window as unknown as {
    BarcodeDetector?: { getSupportedFormats?: () => Promise<string[]> };
  }).BarcodeDetector;

  let nativeFormats: string[] | null = null;
  if (nativeCtor?.getSupportedFormats) {
    nativeFormats = await nativeCtor.getSupportedFormats().catch(() => null);
  }

  let lenses: string[] = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    lenses = devices
      .filter((d) => d.kind === "videoinput")
      .map((d) => d.label || "(unlabelled)");
  } catch {
    lenses = ["(enumerateDevices failed)"];
  }

  const settings = (track?.getSettings?.() ?? {}) as Record<string, unknown>;
  const rawCaps = (
    (track as unknown as { getCapabilities?: () => Record<string, unknown> })?.getCapabilities?.() ?? {}
  ) as Record<string, unknown>;
  const capabilities: Record<string, unknown> = {};
  for (const k of Object.keys(rawCaps)) capabilities[k] = brief(rawCaps[k]);

  // Does the focus constraint actually take? Ask, don't assume.
  let focus = "not attempted";
  if (track) {
    if (!("focusMode" in rawCaps)) {
      focus = "UNSUPPORTED (focusMode absent from getCapabilities)";
    } else {
      try {
        await track.applyConstraints({
          advanced: [{ focusMode: "continuous" }],
        } as unknown as MediaTrackConstraints);
        const after = (track.getSettings?.() ?? {}) as { focusMode?: string };
        focus = `accepted (focusMode now: ${after.focusMode ?? "unreported"})`;
      } catch (e) {
        focus = `REJECTED: ${(e as Error).name}: ${(e as Error).message}`;
      }
    }
  }

  const zoom = "zoom" in rawCaps ? `available (${String(brief(rawCaps.zoom))})` : "UNSUPPORTED";
  const torch = "torch" in rawCaps ? "available" : "UNSUPPORTED";

  const q = (k: string) => {
    try { return new URLSearchParams(window.location.search).get(k); } catch { return null; }
  };
  // EFFECTIVE values, parsed by the same helper the reader uses — not the raw
  // URL. ?scandelay=abc falls back to 40 in the reader; a report that printed
  // "delay=abc" would misdescribe the very run it documents (review 2026-08-05).
  const delayMs = numericOverride("scandelay", 40, 2000);
  const zoomVal = numericOverride("zoom", 0, 10);
  const tuning = [
    `delay=${delayMs}${q("scandelay") === null ? " (default)" : ""}`,
    `lens=${q("lens") ?? "auto"}`,
    `zoom=${zoomVal || "off"}`,
  ].join("  ");

  return {
    tuning,
    engine: nativeCtor ? "native BarcodeDetector" : "ZXing (fallback)",
    nativeFormats,
    lenses,
    picked: String(settings.deviceId ?? "(none)").slice(0, 12) + "…",
    settings,
    capabilities,
    focus,
    zoom,
    torch,
  };
}

/** One pasteable block — the phone has no console, so this is how the facts
 *  travel back. */
export function factsToText(f: CameraFacts, s: DecodeStats): string {
  return [
    "── Cobblr scan diagnostics ──",
    `engine       : ${f.engine}`,
    `native fmts  : ${f.nativeFormats ? f.nativeFormats.join(", ") : "n/a"}`,
    `lenses (${f.lenses.length})  : ${f.lenses.join(" | ")}`,
    `picked       : ${f.picked}`,
    `resolution   : ${String(f.settings.width ?? "?")}x${String(f.settings.height ?? "?")} @${String(f.settings.frameRate ?? "?")}fps`,
    `focus        : ${f.focus}`,
    `zoom         : ${f.zoom}`,
    `torch        : ${f.torch}`,
    `capabilities : ${Object.keys(f.capabilities).join(", ") || "(none reported)"}`,
    `tuning       : ${f.tuning}`,
    `torch auto   : ${torchDiag().event} · luma ${torchDiag().luma ?? "?"} · falloff ${torchDiag().falloff ?? "?"} · fired ${torchDiag().autoOns}x`,
    `stream       : re-acquired ${streamRecoveryCount()}x (frozen-frame watchdog)`,
    `auto zoom    : ${zoomDiag()}`,
    `decode       : ${s.attempts} attempts, ${s.hits} hits, ${s.perSec}/s`,
    `aimed rotate : ${s.rotAttempts} attempts, ${s.rotHits} hits${s.lastAngle !== null ? `, last axis ${Math.round(s.lastAngle)}°` : ""}`,
    `decode ms    : p50 ${s.p50}, p95 ${s.p95}, worst ${s.worst}`,
    `ua           : ${navigator.userAgent}`,
  ].join("\n");
}
