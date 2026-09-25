// An item's destination: the ONE answer every door and every grouping reads.
//
// The card resolves a row through the contract's scanDestination over the
// workspace's menu: a person's stored choice first (#3062, #3587), else the
// router's top route, replaced by a better table the workspace gained since
// (#3136). Everything else read the raw top candidate. So the dashboard's
// scanner queue grouped a vinegar the card sent to Groceries under Inventory,
// and "Add all 54 to Inventory" would have filed it where nobody chose
// (#3618); File N, File all and a put-away plan each had the same gap.
//
// This builds the row the card sees (offers judged against the tables that
// exist, the person's name, the person's table first, their typed values
// merged) and asks the contract. The answer is the candidate to file with:
// the chosen table's own candidate when one names it (its extracted fields),
// else a bare one for that table. `lint:capabilities` (scan:an-items-
// destination) refuses a second reader of the raw candidates.

import {
  scanDestination,
  scanResolverTables,
  type ScanMenuTableEntry,
  type ScanMergeTarget,
  type ScanResolverTable,
  type ScanTriageRow,
} from "@cobblr/platform-contract/scan-triage";
import { candidatesWithUserFields } from "./user-fields.js";
import { withPersonName } from "./user-name.js";
import { resolveOffers, type LiveTable, type OfferLike } from "./resolve-offers.js";

/** A stored candidate list, from the jsonb column or its string form. */
export function candidateList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export interface DestinationCandidate {
  module: string;
  instance: string | null;
  kind?: string;
  label?: string;
  bundle_external_id?: string | null;
  fields?: Record<string, unknown>;
  category?: string;
  /** The record filing adds to instead of creating (a re-purchase). */
  updates?: ScanMergeTarget;
  [k: string]: unknown;
}

export type DestinationRow = ScanTriageRow & { suggested_candidates?: unknown; suggested_metadata?: unknown };

/** The workspace's tables as the resolver reads them, from its scan menu. */
export function destinationTables(menu: ReadonlyArray<ScanMenuTableEntry> | null | undefined): ScanResolverTable[] {
  return scanResolverTables(menu);
}

/** The tables that exist now, for judging an install offer, from the same
 *  menu (a bundle entry is an offer, not a table). */
function liveOf(tables: readonly ScanResolverTable[]): LiveTable[] {
  return tables
    .filter((t) => !t.bundle_external_id)
    .map((t) => ({ module: t.module_name ?? t.instance_name, instance: t.instance_name === (t.module_name ?? t.instance_name) ? null : t.instance_name, label: t.display_name ?? t.instance_name }));
}

/** The candidates as the card sees them: offers judged against the tables
 *  that exist, the person's table first, their values merged. */
export function cardCandidates(row: DestinationRow, tables: readonly ScanResolverTable[], liveNow?: readonly LiveTable[]): DestinationCandidate[] {
  const raw = candidateList(row.suggested_candidates) as DestinationCandidate[];
  // Whether an offered table exists is judged against the workspace NOW
  // when the caller has it (the instance list, read per request); the menu
  // the fit rule reads may be a few seconds old, and an app installed in
  // between must stop reading as an offer at once.
  const live = liveNow ? [...liveNow] : liveOf(tables);
  const resolved = live.length ? resolveOffers(raw as unknown as Array<OfferLike & DestinationCandidate>, live) : raw;
  return candidatesWithUserFields(resolved, row.suggested_metadata) as DestinationCandidate[];
}

/** The table ONE candidate names: for a pass stamping or describing the
 *  suggestion it just made (the matchmaker's field provenance), never for
 *  deciding where an item goes, which is filingDestination's. */
export function candidateTableOf(c: unknown): { module: string | null; instance: string | null } {
  const o = (c ?? {}) as { module?: unknown; instance?: unknown };
  return { module: typeof o.module === "string" ? o.module : null, instance: typeof o.instance === "string" && o.instance ? o.instance : null };
}

/** Where this item goes, as the card says it, and the candidate to file
 *  with. Null when nothing routes it. */
export function filingDestination(row: DestinationRow, tables: readonly ScanResolverTable[], liveNow?: readonly LiveTable[]): DestinationCandidate | null {
  const cands = cardCandidates(row, tables, liveNow);
  const served = withPersonName({ ...row, suggested_name: row.suggested_name ?? null, suggested_candidates: cands });
  const d = scanDestination(served, { tables });
  if (!d) return null;
  const same = (c: DestinationCandidate) => c.module === d.module && (c.instance ?? null) === (d.instance ?? null);
  const own = cands.find(same);
  // A re-purchase files onto the record it matched: the door adds to it
  // rather than creating a second one in the same table (#3707).
  const updates = d.updates ? { updates: d.updates } : {};
  if (own) return { ...own, ...updates };
  return {
    module: d.module,
    instance: d.instance,
    ...(d.kind ? { kind: d.kind } : {}),
    label: d.label,
    ...(d.bundle_external_id ? { bundle_external_id: d.bundle_external_id } : {}),
    fields: {},
    ...updates,
  };
}
