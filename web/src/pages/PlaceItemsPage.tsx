// Place items: the floor plan and the things to put on it, side by side
// (#3986). Pick a space up front like the Locations page's Floor Plan tab; a
// collection can open it filtered to its own things
// (/locations/place?collection=<kind>).

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Boxes, MapPin } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { api, type Location } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { viewableSpaces } from "../components/LocationFloorPlanTab";
import { PlaceItemsView } from "../components/placeItems/PlaceItemsView";

export function PlaceItemsPage() {
  usePageTitle("Place items");
  const { activeSlug } = useActiveOrg();
  const [params, setParams] = useSearchParams();
  const locs = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const items: Location[] = useMemo(() => locs.data?.items ?? [], [locs.data]);
  const { areas, containers } = useMemo(() => viewableSpaces(items), [items]);
  const spaces = [...areas, ...containers];
  const asked = params.get("space");
  const active = spaces.find((l) => l.id === asked) ?? spaces[0] ?? null;
  const collection = params.get("collection");

  const choose = (id: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("space", id);
      return n;
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link to="/locations" className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent">
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
        <PlaceItemsView key={active.id} slug={activeSlug} space={active} locations={items} initialCollection={collection} />
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
