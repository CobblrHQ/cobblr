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

export function recordDecode(ms: number, found: boolean): void {
  attempts += 1;
  if (found) hits += 1;
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
  firstAt = null;
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

  return {
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
    `decode       : ${s.attempts} attempts, ${s.hits} hits, ${s.perSec}/s`,
    `decode ms    : p50 ${s.p50}, p95 ${s.p95}, worst ${s.worst}`,
    `ua           : ${navigator.userAgent}`,
  ].join("\n");
}
