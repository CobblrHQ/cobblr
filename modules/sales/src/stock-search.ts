// What a sales line can be sold from: every record a fulfilment can draw,
// in every collection this workspace keeps stock in. The picker searched the
// one kind `inventory:part`, whose list is the default collection only, so a
// record in Home Inventory or any other named collection was never offered
// and could only be sold as unlinked text (#5825). The kinds come from the
// workspace's scannable registry, never a fixed list, so a collection added
// later is searched the day it exists.
import { platform, type EntityViewer, type ScannableKind } from "@cobblr/platform-contract";
import { DRAW_ACTION } from "./fulfilment.js";

export interface StockOption {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  /** The collection it is in, as the workspace names it. */
  collection: string;
}

/** The kinds this workspace keeps stock in that a fulfilment can draw from. */
export async function stockedKinds(orgId: string): Promise<ScannableKind[]> {
  return (await platform().entities.listScannableForOrg(orgId)).filter((k) => k.qtyField && k.adjustAction === DRAW_ACTION);
}

function rank(title: string, q: string): number {
  const t = title.toLowerCase();
  const n = q.toLowerCase();
  return t === n ? 0 : t.startsWith(n) ? 1 : 2;
}

/** Search every stocked kind for `q`, best matches first. An empty `q`
 *  lists the first records of each, for a picker opened before typing. */
export async function searchStock(orgId: string, q: string, viewer: EntityViewer, limit = 20): Promise<StockOption[]> {
  const out: Array<StockOption & { rank: number }> = [];
  for (const k of await stockedKinds(orgId)) {
    const r = await platform().entities.list(orgId, k.kind, { ...(q ? { q } : {}), limit }, viewer);
    const collection = k.record.display_name_plural || k.record.display_name;
    for (const e of r.items) out.push({ id: e.id, kind: k.kind, title: e.title, ...(e.subtitle ? { subtitle: e.subtitle } : {}), collection, rank: rank(e.title, q) });
  }
  return out.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title)).slice(0, limit).map(({ rank: _, ...o }) => o);
}
