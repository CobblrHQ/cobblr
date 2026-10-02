// The one answer to "which room or container is open": the `space` in the
// address, read the same way by the Locations page's Floor Plan tab and by
// Place items (#4557).
//
// It used to be two answers. The Floor Plan tab kept its chosen room in its
// own state and Place items read `?space=`; the button between them carried
// nothing, so a person who had just drawn the Garage pressed Place items and
// landed on the first room in the list (Bathroom: "No floor plan yet"). In the
// address, the choice survives the trip both ways, a reload and the back
// button.

import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { Location } from "../../lib/api";
import { hasOwnLayout } from "../../lib/floorplanGeometry";

export const SPACE_PARAM = "space";

/** The rooms and containers that have a plan of their own to show: top-level
 *  areas, and containers that stand alone or have their own layout. */
export function viewableSpaces(items: readonly Location[]): { areas: Location[]; containers: Location[] } {
  const order = (a: Location, b: Location) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name);
  const areas = items.filter((l) => l.kind === "area" && !l.parent_id).sort(order);
  const containers = items.filter((l) => l.kind === "container" && (!l.parent_id || hasOwnLayout(l.metadata))).sort(order);
  return { areas, containers };
}

/** Place items, opened on this room or container (the first one when none). */
export function placeItemsHref(spaceId: string | null | undefined, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (spaceId) p.set(SPACE_PARAM, spaceId);
  const q = p.toString();
  return `/locations/place${q ? `?${q}` : ""}`;
}

/** The Locations page's Floor Plan tab, opened on this room or container. */
export function floorPlanHref(spaceId: string | null | undefined): string {
  const p = new URLSearchParams({ view: "plan" });
  if (spaceId) p.set(SPACE_PARAM, spaceId);
  return `/locations?${p.toString()}`;
}

export function useSelectedSpace(items: readonly Location[]) {
  const [params, setParams] = useSearchParams();
  const { areas, containers } = useMemo(() => viewableSpaces(items), [items]);
  const spaces = useMemo(() => [...areas, ...containers], [areas, containers]);
  const asked = params.get(SPACE_PARAM);
  // A choice that no longer exists (deleted, or another workspace's link)
  // falls back to the first space rather than an empty page.
  const active = spaces.find((l) => l.id === asked) ?? spaces[0] ?? null;
  const choose = useCallback(
    (id: string) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.set(SPACE_PARAM, id);
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );
  return { areas, containers, spaces, active, choose };
}
