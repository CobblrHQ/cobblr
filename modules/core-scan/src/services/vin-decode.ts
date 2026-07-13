// VIN decoder — the first NEW member of the identifier-decoder registry.
//
// A VIN is a pure IDENTIFIER: 17 characters that reference a vehicle NHTSA
// knows about, carrying no attributes on their own. Turning it into fields
// takes an HTTP call to the free, keyless NHTSA vPIC service plus the
// ErrorCode-based classification below — logic, not data, so it belongs next to
// the barcode resolver (which does the same job for a different code), NOT in a
// declarative scan-URL manifest. See docs/design-decisions/vin-decode.md §3.
//
// Caching discipline mirrors barcode-lookup.ts EXACTLY: a VIN → vehicle mapping
// is effectively immutable, so a hit/partial is cached forever and a durable
// miss gets a TTL, but a timeout / 5xx / outage is `unavailable` and is NEVER
// cached (same invariant as a barcode rate-limit — a throttle is not a durable
// miss). The caching itself lives in the endpoint (api/decode.ts) with the
// tenant db; this file is the pure lookup + classifier, like lookupBarcode.

import {
  registerDecoder,
  type DecodeResult,
  type IdentifierDecoder,
} from "./identifier-registry.js";

const PROVENANCE = "NHTSA vPIC";
const VPIC_URL = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues";
// vPIC is quick; the 12s budget matches the scan enrichment deadline pattern.
const VPIC_TIMEOUT_MS = 12_000;

// ── shape + check digit (ISO 3779) ───────────────────────────────────────────

// 17 chars from the VIN alphabet: A–Z and 0–9 EXCEPT I, O, Q (excluded to avoid
// confusion with 1/0). Uppercased first.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function normalizeVin(code: string): string {
  return code.trim().toUpperCase();
}

/** Pure shape test — the decoder's `matches()`. Does NOT validate the check
 *  digit (vPIC decodes many check-digit-fail VINs; a bad check digit is a
 *  warning, not a hard reject — see checkDigitValid + §7 of the spec). */
export function isShapeValidVin(code: string): boolean {
  return VIN_RE.test(normalizeVin(code));
}

// ISO 3779 transliteration: letters → a digit; I/O/Q have no value (never
// appear in a shape-valid VIN). Digits map to themselves.
const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
// Positional weights (position 9 — the check digit itself — has weight 0).
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * The ISO 3779 weighted-sum check digit for a shape-valid VIN, as it SHOULD
 * appear at position 9. Returns "0".."9" or "X", or null if the VIN isn't
 * shape-valid.
 */
export function computeCheckDigit(code: string): string | null {
  const vin = normalizeVin(code);
  if (!isShapeValidVin(vin)) return null;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]!;
    const val = /[0-9]/.test(ch) ? Number(ch) : TRANSLIT[ch];
    if (val === undefined) return null; // unreachable for a shape-valid VIN
    sum += val * WEIGHTS[i]!;
  }
  const rem = sum % 11;
  return rem === 10 ? "X" : String(rem);
}

/** Does the VIN's position-9 check digit calculate correctly? A `false` here is
 *  a WARNING, not a reason to skip decode (vPIC still decodes many of them). */
export function checkDigitValid(code: string): boolean {
  const vin = normalizeVin(code);
  const expected = computeCheckDigit(vin);
  return expected !== null && expected === vin[8];
}

// ── vPIC response → semantic fields + four-way classification ─────────────────

/** The subset of vPIC's ~140-field flat result we read. Everything else stays
 *  in `raw`. `[k: string]: unknown` keeps the full bag typed-loose. */
export interface VpicResult {
  ErrorCode?: string;
  ErrorText?: string;
  ModelYear?: string;
  Make?: string;
  Model?: string;
  Trim?: string;
  Series?: string;
  BodyClass?: string;
  FuelTypePrimary?: string;
  VehicleType?: string;
  [k: string]: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Map a vPIC result to the flat SEMANTIC field bag (year/make/model/body/
 *  fuel_type/trim). Only keys that actually decoded are included. Values pass
 *  through verbatim (e.g. Make "HONDA") — the auto-fill chips ask the user to
 *  double-check, so we stay faithful to the source rather than guess casing or
 *  remap fuel to a bundle's choice vocabulary (that normalization is deferred,
 *  spec §6 / open question #2). */
export function mapVpicFields(r: VpicResult): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  const yearNum = Number(str(r.ModelYear));
  if (str(r.ModelYear) && Number.isFinite(yearNum)) fields.year = yearNum;
  const make = str(r.Make);
  if (make) fields.make = make;
  const model = str(r.Model);
  if (model) fields.model = model;
  const body = str(r.BodyClass);
  if (body) fields.body = body;
  const fuel = str(r.FuelTypePrimary);
  if (fuel) fields.fuel_type = fuel;
  const trim = str(r.Trim) || str(r.Series);
  if (trim) fields.trim = trim;
  return fields;
}

/**
 * Classify a vPIC `Results[0]` object into the four-way outcome, keyed on the
 * `ErrorCode` string (vPIC almost never HTTP-errors; it signals in-band).
 * Mirrors barcode-lookup's discriminated outcome. Pure — no network.
 *
 * Rules (verified against real vPIC responses, 2026-07-13):
 *   - No Make/Model/Year at all           → `miss`   (bad VIN; durable, cache).
 *   - ErrorCode leads with "0"            → `hit`    (clean; check digit valid).
 *   - ErrorCode leads with "1"            → `hit`    (check-digit warning only;
 *                                                     data is good — the Tesla).
 *   - data present but flagged otherwise  → `partial` (incomplete VIN, verify).
 *   - `undefined` result (no Results row) → `unavailable` (never cache).
 */
export function classifyVpic(result: VpicResult | undefined): DecodeResult {
  if (!result) return { outcome: "unavailable", fields: {}, provenance: PROVENANCE };

  const codes = String(result.ErrorCode ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const first = codes[0] ?? "";
  const hasCore = !!(str(result.Make) || str(result.Model) || str(result.ModelYear));
  const fields = mapVpicFields(result);
  const title = vinTitle(fields);

  // Nothing resolved → a durable miss regardless of the (noisy) error codes.
  // The junk VIN "00000000000000000" comes back "1,7,11,400" with empty
  // Make/Model — this branch (not the "1" hit branch) is what catches it.
  if (!hasCore) {
    return { outcome: "miss", fields: {}, provenance: PROVENANCE, raw: result };
  }
  if (first === "0") {
    return { outcome: "hit", fields, provenance: PROVENANCE, title, raw: result };
  }
  if (first === "1") {
    return {
      outcome: "hit",
      fields,
      provenance: PROVENANCE,
      title,
      note: "Check digit did not verify — double-check the VIN.",
      raw: result,
    };
  }
  return {
    outcome: "partial",
    fields,
    provenance: PROVENANCE,
    title,
    note: "Partial VIN match — please verify the filled fields.",
    raw: result,
  };
}

/** vPIC's BodyClass is a verbose slash-joined class ("Hatchback/Liftback/
 *  Notchback", "Sedan/Saloon"); take the first, simplest term for the name. */
function shortBody(body: string): string {
  const first = body.split("/")[0]?.replace(/\(.*?\)/g, "").trim() ?? "";
  return first;
}

/** Synthesize the human display name for a decoded vehicle from its fields —
 *  "2019 Honda Civic Hatchback EX" (year make model body trim, whichever are
 *  present). Title-cases the all-caps make vPIC returns ("HONDA" → "Honda") and
 *  simplifies the verbose body class. Empty string when nothing nameable
 *  decoded. The scan path uses this to name the minted record. */
export function vinTitle(fields: Record<string, string | number>): string {
  const titleCase = (s: string): string =>
    s.replace(/\b([A-Z])([A-Z]+)\b/g, (_m, a: string, b: string) => a + b.toLowerCase());
  const parts = [
    fields.year != null ? String(fields.year) : "",
    typeof fields.make === "string" ? titleCase(fields.make) : "",
    typeof fields.model === "string" ? String(fields.model) : "",
    typeof fields.body === "string" ? shortBody(fields.body) : "",
    typeof fields.trim === "string" ? String(fields.trim) : "",
  ].filter(Boolean);
  return parts.join(" ").trim();
}

// ── the network lookup (pure of caching, like lookupBarcode) ──────────────────

/**
 * Decode one VIN against vPIC. A non-shape-valid code short-circuits to `miss`
 * (should never happen — the registry only routes shape-valid VINs here). A
 * timeout / non-2xx / network error is `unavailable` (retry, do NOT cache).
 * One call per uncached VIN; the endpoint's cache makes it at most once ever.
 */
export async function decodeVin(code: string): Promise<DecodeResult> {
  const vin = normalizeVin(code);
  if (!isShapeValidVin(vin)) return { outcome: "miss", fields: {}, provenance: PROVENANCE };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VPIC_TIMEOUT_MS);
  try {
    const res = await fetch(`${VPIC_URL}/${encodeURIComponent(vin)}?format=json`, {
      headers: { accept: "application/json", "user-agent": "cobblr-core-scan/vin" },
      signal: controller.signal,
    });
    // vPIC down / throttled / 5xx → unavailable (never cached). Also covers a
    // stray 4xx: better to let the user retry than poison the cache.
    if (!res.ok) return { outcome: "unavailable", fields: {}, provenance: PROVENANCE };
    const body = (await res.json().catch(() => null)) as { Results?: VpicResult[] } | null;
    return classifyVpic(body?.Results?.[0]);
  } catch {
    // AbortError (timeout) or any transport failure → unavailable.
    return { outcome: "unavailable", fields: {}, provenance: PROVENANCE };
  } finally {
    clearTimeout(timer);
  }
}

export const vinDecoder: IdentifierDecoder = {
  id: "vin",
  matches: (code) => isShapeValidVin(code),
  decode: (code) => decodeVin(code),
};

/** Register the built-in decoders. Idempotent — safe to call on every router
 *  init. VIN is the first NEW decoder; the barcode retcon is deferred. */
export function registerBuiltinDecoders(): void {
  registerDecoder(vinDecoder);
}
