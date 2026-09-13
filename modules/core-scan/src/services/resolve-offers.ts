// An offer to install a table is judged against the workspace as it is NOW,
// on the way out, never against the workspace as it was when the row was
// matched.
//
// A pending item's candidates are written at match time. One that fits a
// flagship bundle the workspace has not installed carries
// `bundle_external_id`: an offer, "install Yarn and add it there". Nothing
// re-read those against the workspace's current installs, so once Yarn WAS
// installed (from the offer itself, or from Bundles) every other pending row
// that had fitted it still said "Install & add", the dashboard still said "1
// looks like Yarn: install", Waiting to file still said "Create Yarn & file
// all 1", and the planners still planned an install (#2919). The table
// existed, with a record in it, one nav entry over.
//
// One rule, read time, every surface: a candidate carrying an offer whose
// table now exists live becomes a filing into that table. "Exists" is the
// matchmaker's own duplicate rule (assembleMergedMenu drops a bundle entry
// that duplicates a live table by module::instance key OR by display label),
// so the reader and the router can never disagree about whether an offer
// stands. Like the composed title, this is derived, never stored: the row
// keeps what the match wrote, and an uninstall puts the offer back by itself.
//
// The materialize door also rewrites the rows that named its bundle, so a
// row is right even to a reader that forgets to compose; the read-time rule
// is the one that must hold (a bundle installed from the Bundles page runs no
// such rewrite).

import { platform } from "@cobblr/platform-contract";

/** A table the workspace has, as the resolver needs it. */
export interface LiveTable {
  module: string;
  /** Null for a module's default table. */
  instance: string | null;
  label: string;
}

/** The fields of a candidate this rule reads and rewrites. Structural, so
 *  the same function serves the matchmaker's candidates, the rows' stored
 *  jsonb and the planners' shapes without a cast each. */
export interface OfferLike {
  module: string;
  instance: string | null;
  label: string;
  bundle_external_id?: string;
}

const key = (module: string, instance: string | null | undefined) => `${module}::${instance ?? ""}`;
const norm = (s: string) => s.trim().toLowerCase();

/** The live table an offer's bundle now has in this workspace, or null while
 *  it is still an offer. Same two tests the matchmaker uses to drop a bundle
 *  entry that duplicates a live table. */
export function liveTableForOffer(offer: OfferLike, live: LiveTable[]): LiveTable | null {
  if (!offer.bundle_external_id) return null;
  const k = key(offer.module, offer.instance);
  const byKey = live.find((t) => key(t.module, t.instance) === k);
  if (byKey) return byKey;
  const label = norm(offer.label);
  if (!label) return null;
  return live.find((t) => norm(t.label) === label) ?? null;
}

/** The candidate as the workspace should see it now: an offer whose table
 *  exists becomes a filing into that table (its live module, instance and
 *  label, the offer gone); anything else is returned as is, the same object. */
export function resolveOffer<C extends OfferLike>(c: C, live: LiveTable[]): C {
  const t = liveTableForOffer(c, live);
  if (!t) return c;
  const { bundle_external_id: _offer, ...rest } = c;
  return { ...rest, module: t.module, instance: t.instance, label: t.label } as C;
}

export function resolveOffers<C extends OfferLike>(candidates: C[], live: LiveTable[]): C[] {
  if (!live.length || !candidates.some((c) => c.bundle_external_id)) return candidates;
  return candidates.map((c) => resolveOffer(c, live));
}

/** A row's stored candidates, resolved. The row comes back unchanged (the
 *  same object) when nothing on it was an offer or nothing resolved. */
export function withResolvedOffers<R extends { suggested_candidates?: unknown }>(row: R, live: LiveTable[]): R {
  const cands = row.suggested_candidates;
  if (!Array.isArray(cands) || !cands.length || !live.length) return row;
  const next = cands.map((c) => (c && typeof c === "object" && (c as OfferLike).bundle_external_id ? resolveOffer(c as OfferLike, live) : c));
  return next.some((c, i) => c !== cands[i]) ? { ...row, suggested_candidates: next } : row;
}

/** The workspace's tables now, through the platform seam. Empty on failure:
 *  a reader that cannot see the workspace shows what the row says. */
export async function liveTablesOf(orgId: string): Promise<LiveTable[]> {
  try {
    const instances = await platform().instances.list(orgId);
    return instances.map((i) => ({ module: i.module_name, instance: i.is_default ? null : i.instance_name, label: i.display_name }));
  } catch (err) {
    console.warn("[core-scan] could not read the workspace's tables to resolve offers:", (err as Error).message);
    return [];
  }
}
