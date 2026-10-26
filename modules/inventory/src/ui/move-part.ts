// Where a part is, and the one way to put it somewhere else.
//
// A part is either at a place (its location) or inside something that holds
// things (a Backpack), never both: inside something, it has no place of its
// own. So moving it to a place takes it out first, and moving it inside
// something goes through placement. The part's own page and the list's bulk
// Move both put a part through here, and an Undo is the same move backwards.
import { editOf } from "@cobblr/platform-web";
import type { InventoryApi } from "./api";

export interface PartPlace {
  location_id: string | null;
  inside: { kind: string; id: string } | null;
}

// GATED-BY: its callers, a part's Move and the list's bulk Move, ask inventory:update-part.
export async function putPart(api: InventoryApi, id: string, to: PartPlace, from: PartPlace): Promise<void> {
  if (to.inside) {
    await api.placePart(id, to.inside);
    return;
  }
  if (from.inside) await api.unplacePart(id);
  await api.updatePart(id, editOf({ location_id: from.location_id }, { location_id: to.location_id }));
}

/** Where a list row is now. A row inside something says only the holder's
 *  name, so its holder is asked for. */
export async function placeOfRow(api: InventoryApi, row: { id: string; location_id: string | null; location_name: string | null }): Promise<PartPlace> {
  if (row.location_id != null || !row.location_name) return { location_id: row.location_id, inside: null };
  const inside = (await api.partPath(row.id)).inside ?? null;
  return { location_id: null, inside: inside ? { kind: inside.kind, id: inside.id } : null };
}
