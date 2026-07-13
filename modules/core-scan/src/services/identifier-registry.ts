// Identifier-decoder registry — the generic seam for "a code that stands for a
// thing, decoded into fields on a record."
//
// Same driver-registry shape Cobblr already runs elsewhere (farm/print drivers,
// digifab drivers, backup destinations, AI providers): a small closed
// interface, N implementations, discovered by capability (`matches`), never
// hardcoded by name. A scanned or typed IDENTIFIER (a UPC, a VIN, later an ISBN
// or boat HIN) is handed to whichever registered decoder recognizes its shape,
// decoded against an external source, and turned into a flat bag of fields.
//
// This module is DELIBERATELY generic. It knows nothing about vehicles, assets,
// inventory, or any domain — a decoder returns fields by role/name and the
// caller decides where they land. Domain modules never import a decoder; the
// only artifact that knows "there are vehicles" AND "there is a VIN decoder" is
// a bundle, which merely declares fields.
//
// The barcode resolver that ships today (services/barcode-lookup.ts) is, in
// hindsight, this registry's "customer zero" — it does barcode → {name, brand,
// category, image} with the same hit/miss/rate-limited discipline. Retrofitting
// it to implement this interface is a LATER, non-disruptive cleanup (see
// docs/design-decisions/vin-decode.md §2, §11); it is intentionally left
// untouched here. VIN is registered as the first NEW decoder.

/** The four-way outcome, lifted from the barcode resolver's discipline. A
 *  throttle/timeout/outage is `unavailable` — NOT a durable `miss` — so the
 *  caller must never cache it. */
export type DecodeOutcome = "hit" | "partial" | "miss" | "unavailable";

export interface DecodeResult {
  outcome: DecodeOutcome;
  /** Decoded attributes, flat, keyed by SEMANTIC role/name (e.g. `year`,
   *  `make`, `model`, `body`, `fuel_type`) — never by a target field id. The
   *  caller maps these onto a record's fields by role. */
  fields: Record<string, string | number>;
  /** Human-readable source label, e.g. "NHTSA vPIC". Null when no decoder
   *  claimed the code. */
  provenance: string | null;
  /** Optional human display name a decoder synthesizes from its fields (a VIN →
   *  "2003 Honda Accord"). The scan-intake path uses it to NAME the minted item
   *  generically — the registry stays domain-agnostic, the decoder owns the
   *  natural title for its kind of thing. Absent → the caller falls back to the
   *  raw code. */
  title?: string;
  /** Optional caveat to surface to the user (check-digit warning, partial). */
  note?: string;
  /** Full source payload, kept for audit / later re-mapping. Not sent to the
   *  client by default. */
  raw?: unknown;
}

export interface IdentifierDecoder {
  /** Stable id: "upc", "vin", later "isbn", "hin". */
  id: string;
  /** Pure shape test: is this MY kind of code? No I/O, no side effects. */
  matches(code: string): boolean;
  /** Do the external lookup + classify. Pure of persistence — caching is the
   *  caller's job (mirrors lookupBarcode: the lookup is pure, the caller
   *  caches with the tenant db). */
  decode(code: string): Promise<DecodeResult>;
}

// Module-level singleton registry. Registration order + `matches` decides which
// decoder claims a code; no caller ever writes `if (kind === "vehicle")`.
const registry = new Map<string, IdentifierDecoder>();

/**
 * Register a decoder. Idempotent by id: a second registration of the same id is
 * a no-op (keeps the first) and returns false — so re-imports across test files
 * or a hot reload don't throw. Returns true when it actually registered.
 */
export function registerDecoder(decoder: IdentifierDecoder): boolean {
  if (registry.has(decoder.id)) return false;
  registry.set(decoder.id, decoder);
  return true;
}

/** The first registered decoder whose `matches` claims the code, or null. */
export function findDecoder(code: string): IdentifierDecoder | null {
  const norm = code.trim();
  if (!norm) return null;
  for (const decoder of registry.values()) {
    if (decoder.matches(norm)) return decoder;
  }
  return null;
}

/**
 * Dispatch: find the decoder that claims `code` and run it. Returns the decode
 * result stamped with the matching `decoderId`, or null when no decoder
 * matched (nothing to decode — the caller treats that as a no-op, not a miss).
 * Pure of caching; the endpoint layer wraps this with the decode cache.
 */
export async function decodeIdentifier(
  code: string,
): Promise<(DecodeResult & { decoderId: string }) | null> {
  const decoder = findDecoder(code);
  if (!decoder) return null;
  const result = await decoder.decode(code.trim());
  return { ...result, decoderId: decoder.id };
}

/** Test-only: forget all registered decoders. */
export function _resetRegistry(): void {
  registry.clear();
}
