// Where a part is, and the one way to put it somewhere else.
//
// A shelf and a toolbox are both placement destinations. A move goes through
// one write, so a refusal cannot leave the part between its old and new place.
import type { InventoryApi } from "./api";

export interface PartPlace {
  location_id: string | null;
  inside: { kind: string; id: string } | null;
}

function containerOf(place: PartPlace) {
  return place.inside ?? (place.location_id ? { kind: "core-locations:location", id: place.location_id } : null);
}

// GATED-BY: its callers, a part's Move and the list's bulk Move, ask inventory:update-part.
export async function putPart(api: InventoryApi, id: string, to: PartPlace, expected: PartPlace): Promise<void> {
  const container = containerOf(to);
  const guard = { container: containerOf(expected) };
  if (container) await api.placePart(id, container, guard);
  else await api.unplacePart(id, guard);
}

/** Where a list row is now. A row inside something says only the holder's
 *  name, so its holder is asked for. */
export async function placeOfRow(api: InventoryApi, row: { id: string; location_id: string | null; location_name: string | null }): Promise<PartPlace> {
  if (row.location_id != null || !row.location_name) return { location_id: row.location_id, inside: null };
  const inside = (await api.partPath(row.id)).inside ?? null;
  return { location_id: null, inside: inside ? { kind: inside.kind, id: inside.id } : null };
}
