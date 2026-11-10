// Every write the place-items view makes, in one place, each through the door
// that owns it: a thing in one place moves through the kernel's placement door
// (it works for any collection, and keeps the record's location in step); a
// thing kept in several places moves through the holdings door, which writes
// the ledger. Every move says it came from the floor plan, so the activity
// reads "moved via floor plan", and each hands back how to undo it.

import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { PlacementExpected } from "../../lib/api/placement";
import { LOCATION_KIND } from "../../lib/placeItems";
import type { PlaceableRecord } from "../../lib/placeableRecords";
import type { Pin } from "./placing";

export const VIA = "floor plan";

export type Undo = () => Promise<void>;

export function usePlaceActions(slug: string) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["kind-list", slug] });
    void qc.invalidateQueries({ queryKey: ["stock-at", slug] });
    void qc.invalidateQueries({ queryKey: ["location-contents", slug] });
  };
  const containee = (r: PlaceableRecord) => ({ kind: r.kind, id: r.id });
  const placeIn = (r: PlaceableRecord, locationId: string, position?: Pin | null, expected?: PlacementExpected) =>
    api.placementPlace(slug, {
      containee: containee(r),
      container: { kind: LOCATION_KIND, id: locationId },
      ...(position ? { position } : {}),
      via: VIA,
      ...(expected ? { expected } : {}),
    });
  /** Where a move left the thing: its Undo moves it only while it is still there (#9422). */
  const leftIn = (locationId: string | null, position?: Pin | null): PlacementExpected => ({
    container: locationId ? { kind: LOCATION_KIND, id: locationId } : null,
    position: position ?? null,
  });
  const instanceOf = (r: PlaceableRecord) => r.instance ?? "inventory";

  return {
    refresh,
    /** Put a thing kept in one place (or none) in `locationId`, at the exact
     *  spot on its plan when there is one. */
    async move(r: PlaceableRecord, locationId: string, position?: Pin | null): Promise<Undo> {
      const before = r.location_id;
      await placeIn(r, locationId, position);
      // UNDO: back where it was only while it is still where this move left it; a teammate's later move is kept (#9422)
      return async () => {
        if (before) await placeIn(r, before, null, leftIn(locationId, position));
        else await api.placementRemove(slug, containee(r), leftIn(locationId, position));
      };
    },
    /** Take a thing out of its place: back to the things without one. */
    async unplace(r: PlaceableRecord): Promise<Undo> {
      const before = r.location_id;
      await api.placementRemove(slug, containee(r));
      // UNDO: back in its place only while it is still in none; one a teammate placed since stays (#9422)
      return async () => {
        if (before) await placeIn(r, before, null, leftIn(null));
      };
    },
    /** Every place of a thing kept in several, into one. */
    async moveAll(r: PlaceableRecord, locationId: string) {
      await api.holdingsMoveAll(slug, instanceOf(r), r.id, { to_location_id: locationId, via: VIA });
    },
    /** Some of one place's count, into `locationId`. */
    async moveSome(r: PlaceableRecord, fromHoldingId: string, fromLocationId: string | null, locationId: string, qty: number): Promise<Undo | null> {
      const out = await api.holdingTransfer(slug, instanceOf(r), fromHoldingId, { to_location_id: locationId, qty, via: VIA });
      if (!fromLocationId) return null;
      return async () => {
        await api.holdingTransfer(slug, instanceOf(r), out.to_id, { to_location_id: fromLocationId, qty, via: VIA });
      };
    },
    /** One more place for a thing, with `qty` counted there. */
    async addPlace(r: PlaceableRecord, locationId: string, qty: number) {
      await api.holdingAdd(slug, instanceOf(r), r.id, { location_id: locationId, qty, via: VIA });
    },
  };
}
