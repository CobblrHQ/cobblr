// Declarative DETECTOR manifest — describes how to turn a camera frame (or a
// running detector's own verdict) into a failure probability in [0,1], as DATA.
// Mirrors the machine-driver manifest (../drivers/manifest.ts): header auth, an
// HTTP call, and a small path-extract expression. A new external detector
// (Obico ML API, PrintGuard, an in-house box) ships as one of these + a folder,
// no code.
//
// Two shapes:
//   frame-scorer   — Cobblr hands it a frame (a URL it fetches, or the bytes in
//                    the request body) and it returns per-frame detections.
//   camera-watcher — the service pulls its own camera and keeps a rolling score;
//                    Cobblr reads that score for the mapped camera.
//
// Probability extract expr (over the JSON response): a JSON path producing one
// or more candidate numbers, then `reduce`d:
//   "$.risk"                    — a scalar field
//   "$[*][1]"                   — 2nd element of every item in a top-level array
//                                 (Obico: [["failure", 0.5, [box]], …] → the 0.5s)
//   "$.detections[*].confidence"— a field across an array of detections
// Path tokens: `$` root · `.key` · `[n]` index · `[*]` spread.

import { z } from "zod";

const Method = z.enum(["GET", "POST", "PATCH", "PUT"]).default("GET");

/** A call that yields a probability. EITHER a numeric read (`probability` extract
 *  expr, folded by `reduce`) OR a categorical read (`label` string → 1.0/0.0). */
const ProbCall = z.object({
  method: Method,
  /** Path template; `{frameUrl}` (frame-scorer url mode) / `{deviceCam}`
   *  (camera-watcher) are substituted from the call context. */
  path: z.string(),
  /** Numeric read: an extract expr producing candidate numbers. */
  probability: z.string().min(1).optional(),
  /** How to fold multiple candidates:
   *  - "max": the highest (an array of detections; EMPTY array ⇒ 0.0, a clean
   *    frame) — the frame-scorer default (Obico).
   *  - "first": the first candidate; empty ⇒ null (no reading).
   *  - omitted: a single scalar; missing ⇒ null (no reading) — camera-watcher. */
  reduce: z.enum(["max", "first"]).optional(),
  /** Divide the raw value before clamping — for services that report 0..100
   *  instead of 0..1 (set 100). Default 1. */
  divisor: z.number().positive().optional(),
  /** Categorical read: a string verdict at this extract path, mapped to a
   *  probability. For services that report a CLASS not a number — e.g.
   *  PrintGuard's `last_result.prediction` ("failure"/"success"/"unknown").
   *  `failureValues` → 1.0, `successValues` → 0.0, anything else ⇒ no reading. */
  label: z.string().min(1).optional(),
  failureValues: z.array(z.string()).optional(),
  successValues: z.array(z.string()).optional(),
});
export type ProbCall = z.infer<typeof ProbCall>;

export const DetectorManifest = z
  .object({
    id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
    name: z.string().min(1).max(120),
    version: z.string().max(32).optional(),
    /** Header auth: send `header: <prefix?><apiKey>` (e.g. "Bearer " + token). */
    auth: z
      .object({
        kind: z.literal("header"),
        header: z.string(),
        from: z.literal("apiKey"),
        prefix: z.string().optional(),
      })
      .nullable()
      .optional(),
    shape: z.enum(["frame-scorer", "camera-watcher"]),
    /** Optional health probe for the test button. */
    health: z.object({ method: Method, path: z.string() }).optional(),
    /** How to read the running service's version (a semver string) — so Cobblr
     *  can enforce `minServiceVersion`. `extract` runs against the response. */
    serviceVersion: z.object({ method: Method, path: z.string(), extract: z.string().min(1) }).optional(),
    /** The lowest service version this package works against (e.g. "2.3.0" for a
     *  capability that only exists from that release). Compared semver-style. */
    minServiceVersion: z.string().optional(),
    /** frame-scorer: how a frame is delivered + scored. */
    detect: ProbCall.extend({
      /** "url": pass a snapshot URL the detector fetches (Obico `/p/?img=`).
       *  "body": POST the JPEG bytes (works with a relayed snapshot too). */
      frameRef: z.enum(["url", "body"]),
      /** body only: multipart form part (default) or raw bytes. */
      bodyType: z.enum(["multipart", "raw"]).optional(),
      bodyField: z.string().optional(),
      contentType: z.string().optional(),
    }).optional(),
    /** camera-watcher: read the service's rolling risk for a mapped camera. */
    status: ProbCall.optional(),
    /** camera-watcher: list the service's own cameras, so Cobblr can present a
     *  picker instead of a hand-typed id (the "import" half of the link flow).
     *  `map` extract-exprs run against each array item. */
    listCameras: z
      .object({
        method: Method,
        path: z.string(),
        /** Where the array lives in the response ($ root if the body IS the array). */
        arrayPath: z.string().optional(),
        map: z.object({
          id: z.string().min(1),
          name: z.string().optional(),
          online: z.string().optional(),
          /** The id of the printer that owns this camera, if any (for auto-linking
           *  a monitor after registering a printer). */
          printerId: z.string().optional(),
        }),
      })
      .optional(),
    // ── full-mode management (optional; only connectors that own their own
    //    printers, like PrintGuard, declare these) ──────────────────────────────
    /** The provider types a printer can be registered under, + each one's config
     *  form (a JSON Schema). `schema` extracts the schema object off each item. */
    listProviders: z
      .object({
        method: Method,
        path: z.string(),
        arrayPath: z.string().optional(),
        map: z.object({ id: z.string().min(1), label: z.string().optional(), schema: z.string().optional() }),
      })
      .optional(),
    /** Register a printer (the caller supplies the body). */
    createPrinter: z.object({ method: Method, path: z.string() }).optional(),
    /** Bind a monitor (camera + printer) so the service actually watches. */
    createMonitor: z.object({ method: Method, path: z.string() }).optional(),
    /** List the service's printers with their live print state (for Cobblr to
     *  consume when the service owns the printer). */
    listPrinters: z
      .object({
        method: Method,
        path: z.string(),
        arrayPath: z.string().optional(),
        map: z.object({
          id: z.string().min(1),
          name: z.string().optional(),
          status: z.string().optional(),
          progress: z.string().optional(),
        }),
      })
      .optional(),
    /** Generic mirror: how a Cobblr digifab connection maps to this detector's
     *  providers — DATA, not code, so any connection type is supported by adding
     *  an entry. `from` is the connection's driver type; `config` fills each
     *  provider field from an extract-expr over the connection CONTEXT
     *  `{ base_url, apiKey, username, password, device? }`. `perDevice` = the
     *  config is per-printer (needs a device id/serial, e.g. Bambu), so `device`
     *  carries that printer's per-device creds. */
    connectionMappings: z
      .array(
        z.object({
          from: z.string().min(1),
          provider: z.string().min(1),
          perDevice: z.boolean().optional(),
          config: z.record(z.string().min(1)),
        }),
      )
      .optional(),
  })
  .refine((m) => (m.shape === "frame-scorer" ? !!m.detect : !!m.status), {
    message: "frame-scorer needs `detect`; camera-watcher needs `status`",
  });

export type DetectorManifest = z.infer<typeof DetectorManifest>;

// ── pure extractors (unit-tested) ────────────────────────────────────────────

/** Evaluate a path expr against a JSON value → the candidate RAW values.
 *  Tokens: `$` root · `.key` · `[n]` index · `[*]` spread. Missing candidates
 *  are dropped. Malformed/trailing-garbage expr → []. */
export function extractRaw(expr: string, data: unknown): unknown[] {
  let s = expr.trim();
  if (s.startsWith("$")) s = s.slice(1);
  const re = /\.([A-Za-z_][\w-]*)|\[(\d+)\]|\[\*\]/g;
  const tokens: Array<{ k: "key"; key: string } | { k: "idx"; i: number } | { k: "all" }> = [];
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(s))) {
    if (m.index !== consumed) return []; // non-contiguous garbage → no match
    if (m[1] != null) tokens.push({ k: "key", key: m[1] });
    else if (m[2] != null) tokens.push({ k: "idx", i: Number(m[2]) });
    else tokens.push({ k: "all" });
    consumed = re.lastIndex;
  }
  if (consumed !== s.length) return []; // trailing garbage

  let cur: unknown[] = [data];
  for (const t of tokens) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (t.k === "key") {
        if (v && typeof v === "object" && !Array.isArray(v)) next.push((v as Record<string, unknown>)[t.key]);
      } else if (t.k === "idx") {
        if (Array.isArray(v)) next.push(v[t.i]);
      } else {
        if (Array.isArray(v)) next.push(...v);
      }
    }
    cur = next;
  }
  return cur;
}

/** The numeric candidates at `expr` (raw values coerced to finite numbers). */
export function extractNumbers(expr: string, data: unknown): number[] {
  const out: number[] = [];
  for (const v of extractRaw(expr, data)) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Fold a probability call's numeric candidates into a single [0,1] value (or
 *  null when there's no usable reading). See `reduce` semantics above. */
export function reduceProbability(spec: Pick<ProbCall, "probability" | "reduce" | "divisor">, data: unknown): number | null {
  if (!spec.probability) return null;
  const div = spec.divisor && spec.divisor > 0 ? spec.divisor : 1;
  const nums = extractNumbers(spec.probability, data).map((n) => n / div);
  if (spec.reduce === "max") return clamp01(nums.length ? Math.max(...nums) : 0);
  if (spec.reduce === "first") return nums.length ? clamp01(nums[0]!) : null;
  return nums.length ? clamp01(nums[0]!) : null; // scalar
}

/** Resolve one reading in [0,1] from a call: the categorical `label` mapping
 *  when present, else the numeric `probability`. Null = no usable reading. */
export function resolveReading(spec: ProbCall, data: unknown): number | null {
  if (spec.label) {
    const raw = extractRaw(spec.label, data)[0];
    if (raw == null) return null;
    const v = String(raw);
    if (spec.failureValues?.includes(v)) return 1;
    if (spec.successValues?.includes(v)) return 0;
    return null; // e.g. "unknown" — no verdict
  }
  return reduceProbability(spec, data);
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Parse "X.Y.Z" (leading v + any pre-release/build suffix ignored) → tuple. */
function parseSemver(v: string): [number, number, number] {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0];
}

/** True if `version` >= `min` (semver X.Y.Z). Unknown/empty version ⇒ false. */
export function meetsMinVersion(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const a = parseSemver(version);
  const b = parseSemver(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true; // equal
}
