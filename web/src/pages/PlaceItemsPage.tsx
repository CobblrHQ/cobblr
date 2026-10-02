// Place items: the floor plan and the things to put on it, side by side
// (#3986). The space open is the address's `space`, the same one the
// Locations page's Floor Plan tab reads (useSelectedSpace); a collection can
// open it filtered to its own things (/locations/place?collection=<kind>).
//
// What a person is carrying lives HERE, above the plan, not in the plan: the
// plan is drawn afresh for each space, and a thing picked up in the toolbox
// to be put in Drawer 2 must still be in hand when Drawer 2 opens (#4561).

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Boxes, MapPin } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { api, type Location } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { PlaceItemsView, usePlaceSession } from "../components/placeItems/PlaceItemsView";
import { floorPlanHref, useSelectedSpace } from "../components/placeItems/useSelectedSpace";

export function PlaceItemsPage() {
  usePageTitle("Place items");
  const { activeSlug } = useActiveOrg();
  const [params] = useSearchParams();
  const locs = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const items: Location[] = useMemo(() => locs.data?.items ?? [], [locs.data]);
  const { spaces, active, choose } = useSelectedSpace(items);
  const collection = params.get("collection");
  const session = usePlaceSession(collection);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={floorPlanHref(active?.id)} className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent">
          <ArrowLeft size={14} /> Locations
        </Link>
        <h1 className="font-display text-xl font-bold text-content dark:text-mortar-100">Place items</h1>
      </div>
      {spaces.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          {spaces.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => choose(l.id)}
              aria-pressed={l.id === active?.id}
              className={
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition " +
                (l.id === active?.id
                  ? "border-accent text-accent bg-cobble-50 dark:bg-cobble-900/30"
                  : "border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:border-accent hover:text-accent")
              }
            >
              {l.kind === "container" ? <Boxes size={13} /> : <MapPin size={13} />}
              {l.name}
            </button>
          ))}
        </div>
      )}
      {locs.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : active ? (
        <PlaceItemsView key={active.id} slug={activeSlug} space={active} locations={items} session={session} />
      ) : (
        <div className="rounded-xl border border-dashed border-line dark:border-slate-700 p-6 text-sm text-muted" data-testid="place-no-plan">
          <p className="font-medium text-content dark:text-mortar-100">No floor plan yet: draw your rooms</p>
          <p className="mt-1">Add a room or a container on the Locations page and draw its layout, then come back to place things.</p>
          <Link to="/locations" className="mt-3 inline-flex rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5">
            Go to Locations
          </Link>
        </div>
      )}
    </div>
  );
}
