// A split child's group shot: the one place that says which file it is.
//
// The child is served with `group_image_file_id` (the parent's own photo) so
// the pictures resolver (the contract's scan-pictures) lists it beside the
// child's crop without any surface fetching the parent (#3046). The inbox
// routes and the export both need that answer, and until 2026-09-20 only the
// routes had it: the export carried two photo slots per item, the group shot
// was neither, and a moved workspace lost every split child's group shot
// (#3127).
//
// Two sources, in order: the parent row's image, when the parent is here; and
// the id the child carries itself in `suggested_metadata.group_image_file_id`,
// which an import writes because the parent it was cut from is usually not
// pending on the source and so never crossed the wire.
import type { Kysely } from "kysely";
import type { CoreScanDB } from "../db.js";

export type WithGroupImage<T> = T & { group_image_file_id: string | null };

/** The parent a split child was cut from, by the id its metadata carries. */
export function splitParentOf(row: { suggested_metadata?: unknown }): string | null {
  const from = (row.suggested_metadata as { split_from?: unknown } | null)?.split_from;
  return typeof from === "string" && from ? from : null;
}

/** The group shot the child carries itself (written by an import). */
function ownGroupImageOf(row: { suggested_metadata?: unknown }): string | null {
  const own = (row.suggested_metadata as { group_image_file_id?: unknown } | null)?.group_image_file_id;
  return typeof own === "string" && own ? own : null;
}

/** One read for however many rows; a row that is not a split child carries
 *  null, and one whose parent is gone carries the id it brought with it, or
 *  null. */
export async function withGroupImages<T extends { suggested_metadata?: unknown }>(
  db: Kysely<CoreScanDB>,
  rows: T[],
): Promise<WithGroupImage<T>[]> {
  const parents = [...new Set(rows.map(splitParentOf).filter((id): id is string => !!id))];
  const images = new Map<string, string | null>();
  if (parents.length) {
    try {
      const found = await db
        .selectFrom("core_scan_inbox_items")
        .select(["id", "image_file_id"])
        .where("id", "in", parents)
        .execute();
      for (const p of found) images.set(p.id, p.image_file_id);
    } catch (err) {
      console.error("[core-scan] group images read failed:", (err as Error).message);
    }
  }
  return rows.map((r) => {
    const parent = splitParentOf(r);
    const fromParent = parent ? (images.get(parent) ?? null) : null;
    return { ...r, group_image_file_id: parent ? (fromParent ?? ownGroupImageOf(r)) : null };
  });
}
