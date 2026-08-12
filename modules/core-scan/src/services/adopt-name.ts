/** May the matchmaker's top candidate RENAME the inbox row?
 *
 *  The matchmaker returns candidates that each carry a name, and for a
 *  web-search / photo item that name is the reconciled one its note describes —
 *  publisher / author-parenthetical / retailer-noise stripped (a book:
 *  "Delmar Cengage Learning … (Whitman)" → "Refrigeration & Air Conditioning
 *  Technology"). Adopting it keeps the header and the note AGREEING, which is
 *  why this exists at all: the note kept claiming a cleanup the name didn't show.
 *
 *  But a rename is destructive, and four kinds of stored name outrank a
 *  candidate's. Each guard below was a real regression, so they live here as one
 *  pure decision with one test rather than as a growing `&&` chain buried in the
 *  match handler. */

/** A size/spec the resolved name carried and must not lose ("1.75 L"). */
const SPEC_RE = /\b\d+(?:\.\d+)?\s?(?:ml|cl|l|fl\.?\s?oz|oz|g|kg|mg|lb|ct|pk|pack|count|gal|qt|pt|proof|%)\b/i;

/** Curated barcode providers — a name from one of these IS the identification. */
const REAL_BARCODE_SOURCES = new Set(["go-upc", "openfoodfacts", "openproductsfacts", "upcitemdb"]);

/** A curated provider already identified this barcode, so the row keeps its
 *  "Resolved via {source}" provenance: the matchmaker's keyword-routing note must
 *  not clobber the identification headline either (the routing still shows via
 *  the candidate chips). Photos/notes have no such provenance, so there the
 *  matchmaker's note IS the identification and it stands. */
export function isCuratedBarcodeIdentification(idSource: string, hasBarcode: boolean, hasStoredName: boolean): boolean {
  return hasBarcode && hasStoredName && REAL_BARCODE_SOURCES.has(idSource);
}

export interface AdoptNameInput {
  /** The row's current `suggested_name`. */
  storedName: string | null;
  /** The top candidate's name, already trimmed. */
  candName: string;
  /** `suggested_metadata.source` — "go-upc", "decoder:vin", "web-search", … */
  idSource: string;
  /** The row carries a scanned barcode. */
  hasBarcode: boolean;
  /** The top candidate came from the KEYWORD FALLBACK, not the AI matchmaker. */
  heuristic: boolean;
}

export function shouldAdoptCandidateName(x: AdoptNameInput): boolean {
  if (!x.candName) return false;

  // 1. A curated PROVIDER already identified this barcode. Its name is the
  //    identification; the matchmaker only did the routing.
  if (isCuratedBarcodeIdentification(x.idSource, x.hasBarcode, !!x.storedName)) return false;

  // 2. A DECODER name is ground truth, not a guess — vPIC's "year make model
  //    body trim". Without this, a match dropped "2019 Honda Civic Hatchback EX"
  //    back to the terser "2019 Honda Civic" on every re-run.
  if (x.idSource.startsWith("decoder:")) return false;

  // 3. The KEYWORD FALLBACK cannot rename anything. Its candidate name is not a
  //    reconciliation — it is a mechanical trim of the name already on the row
  //    (see cleanCaptureName), so adopting it can only ever SUBTRACT. Whenever
  //    the AI is unreachable (no provider, a timeout, a replay that found
  //    nothing cached) every item passing through here would otherwise be
  //    quietly shortened by whatever that trim happened to cut. Reported
  //    2026-08-12: a replay turned "Voron 0.1 3D Printer (partially built)" into
  //    "Voron 0" at 0.60 confidence.
  if (x.heuristic) return false;

  // 4. Nothing to do, and never DROP a spec the stored name carried.
  if (x.candName.toLowerCase() === (x.storedName ?? "").toLowerCase()) return false;
  if (SPEC_RE.test(x.storedName ?? "") && !SPEC_RE.test(x.candName)) return false;

  return true;
}
