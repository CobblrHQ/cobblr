// Stock, wherever this workspace keeps it.
//
// A module that offers a record to draw from or add to (a sales line, a
// build's component, what a build makes) searched the one kind
// `inventory:part`, whose list is the default collection only. A record in
// Home Inventory or any other named collection was never offered (#5825),
// and a build told "an existing part with this name is used" quietly made a
// second one in the default collection (#5892). The kinds come from the
// workspace's scannable registry, never a fixed list, so a collection added
// later is searched the day it exists. Only a kind whose count moves through
// the caller's stock action is stock to that caller.

import { platform, type EntityViewer, type ScannableKind } from "@cobblr/platform-contract";

export interface StockOption {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  /** The collection it is in, as the workspace names it. */
  collection: string;
  /** The unit its count is kept in ("each", "m", "kg"), or null when the
   *  kind keeps none: how much of it a line or a recipe may ask for. */
  unit: string | null;
}

/** The kinds this workspace keeps stock in whose count `adjustAction` moves. */
export async function stockedKinds(orgId: string, adjustAction: string): Promise<ScannableKind[]> {
  return (await platform().entities.listScannableForOrg(orgId)).filter((k) => k.qtyField && k.adjustAction === adjustAction);
}

function collectionOf(k: ScannableKind): string {
  return k.record.display_name_plural || k.record.display_name;
}

function rank(title: string, q: string): number {
  const t = title.toLowerCase();
  const n = q.toLowerCase();
  return t === n ? 0 : t.startsWith(n) ? 1 : 2;
}

/** Search every stocked kind for `q`, best matches first. */
export async function searchStock(orgId: string, q: string, viewer: EntityViewer | undefined, opts: { adjustAction: string; limit?: number }): Promise<StockOption[]> {
  const limit = opts.limit ?? 20;
  const out: Array<StockOption & { rank: number }> = [];
  for (const k of await stockedKinds(orgId, opts.adjustAction)) {
    const r = await platform().entities.list(orgId, k.kind, { ...(q ? { q } : {}), limit }, viewer);
    const collection = collectionOf(k);
    for (const e of r.items) {
      const unit = k.unitField ? e.fields?.[k.unitField] : null;
      out.push({ id: e.id, kind: k.kind, title: e.title, ...(e.subtitle ? { subtitle: e.subtitle } : {}), collection, unit: typeof unit === "string" && unit.trim() ? unit.trim() : null, rank: rank(e.title, q) });
    }
  }
  return out.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title)).slice(0, limit).map(({ rank: _, ...o }) => o);
}

/** Every stocked record named exactly `name` (case and edge spaces aside),
 *  in whichever collection holds it. */
export async function stockNamed(orgId: string, name: string, viewer: EntityViewer | undefined, opts: { adjustAction: string }): Promise<StockOption[]> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return [];
  const found = await searchStock(orgId, name.trim(), viewer, { adjustAction: opts.adjustAction, limit: 200 });
  return found.filter((o) => o.title.trim().toLowerCase() === wanted);
}

/** "Inventory and Home Inventory": the collections a set of records is in. */
export function collectionsSentence(options: readonly StockOption[]): string {
  const names = [...new Set(options.map((o) => o.collection))];
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
