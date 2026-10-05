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

import { packageLabelDecoder } from "./package-label.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerDecoder,
  type DecodeResult,
  type IdentifierDecoder,
} from "./identifier-registry.js";
import { catalogRecording, catalogReplayDir } from "./catalog-replay.js";

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

// The model year is position 10, a code that repeats every 30 years
// (A..Y without I, O, Q, U, Z, then 1..9). For a car or light truck built for
// North America, a LETTER at position 7 places it in 2010 or later; a digit
// there leaves both cycles possible unless the later one is still in the
// future. Answers only when the year is certain, so an offline read never
// guesses a 1995 car into 2025.
const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";

export function vinModelYear(code: string, now: Date = new Date()): number | null {
  const vin = normalizeVin(code);
  if (!isShapeValidVin(vin)) return null;
  const i = YEAR_CODES.indexOf(vin[9]!);
  if (i < 0) return null;
  const early = 1980 + i;
  const late = early + 30;
  const latest = now.getUTCFullYear() + 1;
  if (/[A-Z]/.test(vin[6]!)) return late <= latest ? late : null;
  if (late > latest) return early;
  return null;
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

// ── scan repair ──────────────────────────────────────────────────────────────
//
// Barcode scanners mangle VIN labels. A real one (2026-07-14, a 2002 Odyssey
// door-jamb label) came back as `I2HKRL18662H580289` — the true VIN with a
// spurious leading `I`. The decoder's shape test wants EXACTLY 17 chars, so it
// declined, the code fell through to the product-barcode lookup, and an 18-char
// alphanumeric string came back as "Reverse Phone" with a photo of an RV.
//
// But a corrupt VIN is one of the rare scans we can fix and PROVE we fixed:
//   • `I`, `O`, `Q` are not in the VIN alphabet at all — they exist nowhere in a
//     real VIN, so a code containing one is corrupt by definition.
//   • the position-9 CHECK DIGIT is a mod-11 over the other 16. A wrong repair
//     fails it ~10 times out of 11.
//
// So: generate candidates, and accept one ONLY when the arithmetic agrees. This
// is a repair, never a guess — the whole point is that we don't have to trust it,
// we can check it. Zero AI, zero network, sub-millisecond.

export interface VinRepair {
  vin: string;
  /** Did we have to change the scanned string to get here? */
  repaired: boolean;
  /** Did the check digit CONFIRM it? True = arithmetic proof. False = the code is
   *  shape-valid but its check digit doesn't compute, which is common and legal
   *  outside North America — so it's a caveat, never a rejection. */
  verified: boolean;
}

/** Every 17-char candidate worth testing, cheapest transformation first. */
function vinCandidates(raw: string): string[] {
  // Scanners emit Code 39 start/stop delimiters, whitespace, and stray dashes.
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const out: string[] = [];
  const push = (c: string) => {
    if (c.length === 17 && !out.includes(c)) out.push(c);
  };

  push(clean);
  // Too long: slide a 17-char window. The real-world case is one junk char on an
  // end, but a window handles junk at either end for free.
  for (let i = 0; i + 17 <= clean.length; i++) push(clean.slice(i, i + 17));
  // Right length but carrying a letter the VIN alphabet forbids: the scanner (or
  // an OCR pass) confused the digit it was invented to disambiguate from.
  if (clean.length === 17 && /[IOQ]/.test(clean)) {
    push(clean.replace(/I/g, "1"));
    push(clean.replace(/[OQ]/g, "0"));
    push(clean.replace(/I/g, "1").replace(/[OQ]/g, "0"));
  }
  return out;
}

/**
 * Recover a VIN from a mangled scan, or null when we can't do it honestly.
 *
 * Precedence:
 *   1. Already shape-valid → use it as-is, check digit or not. Unchanged: vPIC
 *      decodes plenty of check-digit-fail VINs (the digit is only mandatory in
 *      North America), so a bad digit on a WELL-FORMED VIN is a caveat, not a
 *      rejection. We didn't alter the string, so there's nothing to prove.
 *   2. Otherwise, a candidate whose CHECK DIGIT validates → repair. Proof.
 *   3. Otherwise → null. NO UNVERIFIED REPAIRS.
 *
 * Rule 3 is the whole safety property, and I got it wrong the first time: I let a
 * single shape-valid candidate through unverified, reasoning that one reading
 * isn't a guess. It is. `1HGCM82633A00435I` has exactly one reading (I→1) and it
 * yields a VIN that is NOT the real one — the check digit says so. Accepting it
 * would decode somebody else's car, and it would also let the VIN decoder CLAIM
 * codes that belong to other decoders (an ASIN, an FNSKU) by "repairing" them into
 * something VIN-shaped.
 *
 * Altering the string is a claim about reality. Only make it when the arithmetic
 * backs you. Blank beats wrong.
 */
export function repairVin(code: string): VinRepair | null {
  const raw = normalizeVin(code);
  if (isShapeValidVin(raw)) {
    return { vin: raw, repaired: false, verified: checkDigitValid(raw) };
  }
  const verified = vinCandidates(raw).filter(isShapeValidVin).find(checkDigitValid);
  return verified ? { vin: verified, repaired: true, verified: true } : null;
}

// ── OCR repair ───────────────────────────────────────────────────────────────
//
// A VIN read off a scanned form by the OCR engine is not a barcode label: the
// engine swaps characters that look alike (a 5 for an S, an 8 for a B, a 0 for
// a D), and a shape-valid wrong VIN is the dangerous case, because it looks
// fine and decodes somebody else's car. So a VIN from OCR is used only when
// the check digit PROVES it, as read or after swapping look-alikes; a read the
// arithmetic cannot settle is unreadable, never used (#4571). The barcode
// path above keeps its own rule (a well-formed label is trusted as read).

/** Characters the engine confuses, each with what it may really be. I, O and
 *  Q are not in the VIN alphabet, so they always mean their digit. */
const OCR_LOOKALIKES: Record<string, string[]> = {
  "0": ["D"], D: ["0"],
  "1": ["L", "T"], L: ["1"], T: ["1"],
  "2": ["Z"], Z: ["2"],
  "5": ["S"], S: ["5"],
  "6": ["G"], G: ["6"],
  "8": ["B"], B: ["8"],
};

export interface OcrVin {
  vin: string;
  /** Characters changed from what was read to make the check digit agree. */
  changed: number;
}

/**
 * The VIN an OCR read stands for, proved by its check digit, or null.
 *
 * Tries the read as is, then every single look-alike swap, and returns the
 * one candidate that passes the check digit, or null when none or several do
 * (`year`, what the form prints as the model year, breaks a tie when exactly
 * one agrees with position 10). A read longer than 17 is windowed.
 *
 * A swapped candidate is NOT proved. Each swap passes the check digit one time
 * in eleven by chance, and a page with ten look-alike characters offers ten
 * chances: measured on a deliberately wrong read, a two-swap search "repaired"
 * it into a different, valid-looking VIN. So `changed > 0` is a candidate the
 * caller must confirm (the vehicle database decodes it clean, and its make is
 * the one the form prints) before it is used. Pairs of swaps are not tried.
 */
export function repairOcrVin(raw: string, opts: { year?: number | null; now?: Date } = {}): OcrVin | null {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[OQ]/g, "0").replace(/I/g, "1");
  const reads: string[] = [];
  if (clean.length === 17) reads.push(clean);
  else if (clean.length > 17 && clean.length <= 19) for (let i = 0; i + 17 <= clean.length; i++) reads.push(clean.slice(i, i + 17));
  if (!reads.length) return null;
  const pick = (found: string[]): string | null => {
    const unique = [...new Set(found)];
    if (unique.length === 1) return unique[0]!;
    if (unique.length > 1 && opts.year) {
      const agree = unique.filter((v) => vinModelYear(v, opts.now) === opts.year);
      if (agree.length === 1) return agree[0]!;
    }
    return null;
  };
  const passes = (v: string) => isShapeValidVin(v) && checkDigitValid(v);
  for (const changes of [0, 1]) {
    const found: string[] = [];
    for (const read of reads) {
      for (const cand of swaps(read, changes)) if (passes(cand)) found.push(cand);
    }
    if (found.length) {
      const vin = pick(found);
      return vin ? { vin, changed: changes } : null;
    }
  }
  return null;
}

/** Every string `changes` look-alike swaps away from `read`. */
function swaps(read: string, changes: number): string[] {
  if (changes === 0) return [read];
  const out: string[] = [];
  const at = [...read].map((ch, i) => (OCR_LOOKALIKES[ch] ? i : -1)).filter((i) => i >= 0);
  const swap = (s: string, i: number, ch: string) => s.slice(0, i) + ch + s.slice(i + 1);
  for (let a = 0; a < at.length; a++) {
    for (const x of OCR_LOOKALIKES[read[at[a]!]!]!) {
      const one = swap(read, at[a]!, x);
      if (changes === 1) {
        out.push(one);
        continue;
      }
      for (let b = a + 1; b < at.length; b++) {
        for (const y of OCR_LOOKALIKES[read[at[b]!]!]!) out.push(swap(one, at[b]!, y));
      }
    }
  }
  return out;
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
      note: "Check digit did not verify, double-check the VIN.",
      raw: result,
    };
  }
  return {
    outcome: "partial",
    fields,
    provenance: PROVENANCE,
    title,
    note: "Partial VIN match, please verify the filled fields.",
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
  // Under replay (COBBLR_CATALOG_REPLAY_DIR, the CI api lane), the vehicle
  // database is a cassette like every other catalog: <dir>/vpic/<VIN>.json
  // holds vPIC's first result, recorded once with COBBLR_CATALOG_REPLAY_RECORD.
  // A VIN with no cassette under replay is "unavailable", never a network call.
  const dir = catalogReplayDir();
  if (dir && !catalogRecording()) {
    const file = join(dir, "vpic", `${vin}.json`);
    if (!existsSync(file)) return { outcome: "unavailable", fields: {}, provenance: PROVENANCE };
    try {
      return classifyVpic((JSON.parse(readFileSync(file, "utf8")) as { result?: VpicResult }).result);
    } catch {
      return { outcome: "unavailable", fields: {}, provenance: PROVENANCE };
    }
  }

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
    if (dir && catalogRecording() && body?.Results?.[0]) {
      try {
        mkdirSync(join(dir, "vpic"), { recursive: true });
        writeFileSync(join(dir, "vpic", `${vin}.json`), JSON.stringify({ vin, result: body.Results[0] }, null, 2));
      } catch {
        // a cassette that cannot be written is a cassette missing, not a failed decode
      }
    }
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
  // Claim a REPAIRABLE code, not just a pristine one. A scanner's stray leading
  // character used to drop the code out of the decoder entirely and into the
  // product-barcode lookup, which happily returned a wrong product for it.
  matches: (code) => repairVin(code) !== null,
  decode: async (code) => {
    const fix = repairVin(code);
    if (!fix) return { outcome: "miss", fields: {}, provenance: null };
    const result = await decodeVin(fix.vin);
    if (!fix.repaired) return result;
    // Say what we did, and hand back the CORRECTED code so the caller can fix the
    // identifier it stored — otherwise the record keeps the mangled scan forever,
    // which is a VIN that doesn't exist.
    const how = fix.verified
      ? "the VIN's check digit confirms it"
      : "it's the only reading that's a valid VIN";
    return {
      ...result,
      fields: { ...result.fields, vin: fix.vin },
      note: [`Cleaned up the scan (${code.trim().toUpperCase()} → ${fix.vin}) — ${how}.`, result.note]
        .filter(Boolean)
        .join(" "),
    };
  },
};

/** Register the built-in decoders. Idempotent — safe to call on every router
 *  init. VIN is the first NEW decoder; the barcode retcon is deferred. */
export function registerBuiltinDecoders(): void {
  registerDecoder(packageLabelDecoder);
  registerDecoder(vinDecoder);
}
