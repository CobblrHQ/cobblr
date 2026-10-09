// Diff a parsed BrickLink wanted-list against the workspace's
// Lego inventory.
//
// The walk:
//   1. Find the rebrickable-parts catalog (semantic_type "lego.part").
//   2. Fetch the catalog entries whose payload.part_num matches a
//      wanted item_id — one query, externalIdIn batch.
//   3. Fetch every record matched to those entries via the "matches"
//      pairing, whatever table it is on (Parts, the Lego bundle's
//      Bricks, any inventory instance: #5434) — one query.
//   4. Pull each matched record's qty + color.
//   5. Bucket each wanted item: have / partial / need.
//
// Wanted-list color matters but inventory doesn't have to. We
// always aggregate stock across colors and surface the breakdown
// per matched part, so the UI can present "you have 12 of part
// 3001 but only 3 in the red the wanted-list asks for."

import { platform } from "@cobblr/platform-contract";
import type { ParsedWantedItem } from "./wanted-list.js";

export type DiffStatus = "have" | "partial" | "need" | "no-catalog-match";

export interface DiffEntry {
  /** The wanted line as the user gave it. */
  wanted: ParsedWantedItem;
  /** Status bucket. */
  status: DiffStatus;
  /** Total qty of this part_num across all colors. */
  total_in_stock: number;
  /** Per-color breakdown: { [color_id]: qty }. -1 = unknown color. */
  by_color: Record<string, number>;
  /** Ids of the records that contribute to the stock. */
  part_ids: string[];
  /** The same records with their kinds (inventory:part, bricks:item…). */
  records: Array<{ kind: string; id: string }>;
  /** The Rebrickable catalog entry id that backs the match, if any. */
  catalog_entry_id: string | null;
  /** Rebrickable's canonical name for the part (when matched). */
  catalog_name: string | null;
  /** True when the user wants color C and at least one inventory
   *  row is in color C. False when stock exists but only in other
   *  colors. Null when wanted color is unspecified (-1) or no match. */
  color_satisfied: boolean | null;
}

export interface DiffResult {
  entries: DiffEntry[];
  counts: {
    have: number;
    partial: number;
    need: number;
    unmatched: number;
  };
}

interface InventoryPartLite {
  id: string;
  qty: number;
  color_id: number;
}

// Loader for the matched records, of whatever kind each is. Injected so
// the unit test doesn't have to spin up a tenant DB; the api caller reads
// them through the entity registry.
export type LoadInventoryParts = (
  orgId: string,
  refs: Array<{ kind: string; id: string }>,
) => Promise<InventoryPartLite[]>;

export async function diffWantedList(
  orgId: string,
  wanted: ParsedWantedItem[],
  loadInventoryParts: LoadInventoryParts,
): Promise<DiffResult> {
  const entries: DiffEntry[] = [];

  // Only parts are diffable today. Sets/minifigs aren't matched
  // against the inventory:part catalog. They surface as no-match.
  const partWanted = wanted.filter((w) => w.item_type === "P");
  const otherWanted = wanted.filter((w) => w.item_type !== "P");

  // 1. Find the catalog.
  const catalog = await platform().catalogs.findBySemanticType(orgId, "lego.part");
  if (!catalog || partWanted.length === 0) {
    // No Lego parts catalog installed → nothing to match against.
    // Every wanted item is "need" by default.
    for (const w of wanted) {
      entries.push({
        wanted: w,
        status: "no-catalog-match",
        total_in_stock: 0,
        by_color: {},
        part_ids: [],
        records: [],
        catalog_entry_id: null,
        catalog_name: null,
        color_satisfied: null,
      });
    }
    return summarize(entries);
  }

  // 2. Fetch catalog entries matching the wanted part_nums.
  const wantedPartNums = [...new Set(partWanted.map((w) => w.item_id))];
  const catalogEntries = await platform().catalogs.queryEntries({
    orgId,
    catalogId: catalog.id,
    externalIdIn: wantedPartNums,
    limit: wantedPartNums.length,
  });
  const entriesByPartNum = new Map<string, (typeof catalogEntries)[number]>();
  for (const e of catalogEntries) {
    const partNum = (e.payload?.["part_num"] as string | undefined) ?? e.externalId;
    if (partNum) entriesByPartNum.set(partNum, e);
  }

  // 3. Every record pointing at these catalog entries via the "matches"
  //    pairing, of any kind: a brick on the Lego bundle's Bricks table is
  //    a bricks:item, and asking for inventory:part alone never saw it.
  const catalogEntryIds = catalogEntries.map((e) => e.id);
  const pairings = await platform().pairings.findByTargets({
    orgId,
    targetKind: "core-catalogs:entry",
    targetIds: catalogEntryIds,
    relationshipKind: "matches",
  });
  const refsByEntryId: Record<string, Array<{ kind: string; id: string }>> = {};
  const seen = new Set<string>();
  const allRefs: Array<{ kind: string; id: string }> = [];
  for (const p of pairings) {
    const ref = { kind: p.sourceKind, id: p.sourceId };
    (refsByEntryId[p.targetId] ||= []).push(ref);
    if (!seen.has(`${ref.kind}:${ref.id}`)) {
      seen.add(`${ref.kind}:${ref.id}`);
      allRefs.push(ref);
    }
  }

  // 4. Hydrate the matched records.
  const inventoryRows = await loadInventoryParts(orgId, allRefs);
  const inventoryById = new Map<string, InventoryPartLite>();
  for (const r of inventoryRows) inventoryById.set(r.id, r);

  // 5. Bucket each wanted part.
  for (const w of partWanted) {
    const entry = entriesByPartNum.get(w.item_id);
    if (!entry) {
      entries.push({
        wanted: w,
        status: "no-catalog-match",
        total_in_stock: 0,
        by_color: {},
        part_ids: [],
        records: [],
        catalog_entry_id: null,
        catalog_name: null,
        color_satisfied: null,
      });
      continue;
    }
    const refs = refsByEntryId[entry.id] ?? [];
    const partIds = refs.map((r) => r.id);
    const rows = partIds
      .map((id) => inventoryById.get(id))
      .filter((r): r is InventoryPartLite => !!r);
    const byColor: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      const key = String(r.color_id);
      byColor[key] = (byColor[key] ?? 0) + r.qty;
      total += r.qty;
    }
    let status: DiffStatus;
    if (total === 0) status = "need";
    else if (total >= w.min_qty) status = "have";
    else status = "partial";
    const colorSat =
      w.color_id === -1
        ? null
        : (byColor[String(w.color_id)] ?? 0) > 0;
    entries.push({
      wanted: w,
      status,
      total_in_stock: total,
      by_color: byColor,
      part_ids: partIds,
      records: refs,
      catalog_entry_id: entry.id,
      catalog_name: (entry.payload?.["name"] as string | undefined) ?? null,
      color_satisfied: colorSat,
    });
  }

  // Sets / minifigs / etc. pass through as no-catalog-match (the
  // diff today only knows parts; the workspace would need a
  // rebrickable-sets matching path to bucket sets too).
  for (const w of otherWanted) {
    entries.push({
      wanted: w,
      status: "no-catalog-match",
      total_in_stock: 0,
      by_color: {},
      part_ids: [],
      records: [],
      catalog_entry_id: null,
      catalog_name: null,
      color_satisfied: null,
    });
  }

  return summarize(entries);
}

function summarize(entries: DiffEntry[]): DiffResult {
  let have = 0;
  let partial = 0;
  let need = 0;
  let unmatched = 0;
  for (const e of entries) {
    if (e.status === "have") have++;
    else if (e.status === "partial") partial++;
    else if (e.status === "need") need++;
    else unmatched++;
  }
  return { entries, counts: { have, partial, need, unmatched } };
}
