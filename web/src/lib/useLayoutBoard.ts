// Everything a planning board needs, read once: the places, the things that
// can be put somewhere, where each stands in its place now, and the outer
// size of each through its kind's outer-size field. The planner, a
// comparison and the print all draw from this, so they cannot disagree.

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { fieldKindOf } from "@cobblr/platform-contract/kind-label";
import { EMPTY_PLAN_DRAFT, type PlanDraftBody } from "@cobblr/platform-contract/plan-draft";
import { api, type Location } from "./api";
import { buildBoard, type Board, type BoardRecord } from "./layoutBoard";
import { LOCATION_KIND } from "./placeItems";
import { placesOf, usePlaceableRecords, type PlaceableRecord } from "./placeableRecords";
import { outerSizeOf, sizeFieldNames } from "./planFit";

export function useLayoutBoard(slug: string, roomId: string, draft: PlanDraftBody | null, faceHeightPx = 320, faceWidth?: number) {
  const locs = useQuery({ queryKey: ["core-locations", slug], queryFn: () => api.listLocations(slug), enabled: !!slug });
  const places = useMemo(() => locs.data?.items ?? [], [locs.data]);
  const room = places.find((l) => l.id === roomId) ?? null;
  const { records: placeable, kinds } = usePlaceableRecords(slug);

  // The room, its racks and their shelves: where things stand now, in order.
  const watched = useMemo(() => {
    if (!room) return [] as Location[];
    const racks = places.filter((l) => l.parent_id === room.id);
    return [room, ...racks, ...places.filter((l) => racks.some((r) => r.id === l.parent_id))];
  }, [places, room]);
  const contents = useQueries({
    queries: watched.map((l) => ({
      queryKey: ["location-contents", slug, l.id],
      queryFn: () => api.placementContents(slug, LOCATION_KIND, l.id),
      staleTime: 30_000,
    })),
    combine: (rs) => rs.flatMap((r) => r.data?.items ?? []),
  });
  const positions = useMemo(() => new Map(contents.map((c) => [`${fieldKindOf(c)}:${c.id}`, c.position ?? null])), [contents]);

  const fieldKinds = useMemo(() => [...new Set(placeable.map((r) => fieldKindOf(r)))].sort(), [placeable]);
  const defs = useQueries({
    queries: fieldKinds.map((k) => ({ queryKey: ["field-defs", slug, k], queryFn: () => api.listFieldDefs(slug, k), staleTime: 60_000 })),
    combine: (rs) => rs.flatMap((r) => r.data?.items ?? []),
  });
  const byKey = useMemo(() => new Map(placeable.map((r) => [`${r.kind}:${r.id}`, r])), [placeable]);

  const records: BoardRecord[] = useMemo(
    () => placeable.map((r) => ({ kind: r.kind, id: r.id, name: r.name, shortName: r.short_name, at: placesOf(r)[0] ?? null, collection: r.collection })),
    [placeable],
  );
  const sizeOf = useMemo(() => {
    return (r: { kind: string; id: string }) => {
      const rec = byKey.get(`${r.kind}:${r.id}`);
      if (!rec) return null;
      return outerSizeOf(rec.metadata, sizeFieldNames(defs, fieldKindOf(rec)));
    };
  }, [byKey, defs]);

  const board: Board | null = useMemo(() => {
    if (!room) return null;
    return buildBoard({ room, places, draft: draft ?? EMPTY_PLAN_DRAFT, records, positions, sizeOf, faceHeightPx, faceWidth });
  }, [room, places, draft, records, positions, sizeOf, faceHeightPx, faceWidth]);

  return { board, room, places, placeable, kinds, sizeOf, loading: locs.isLoading, byKey } as {
    board: Board | null;
    room: Location | null;
    places: Location[];
    placeable: PlaceableRecord[];
    kinds: typeof kinds;
    sizeOf: (r: { kind: string; id: string }) => ReturnType<typeof outerSizeOf>;
    loading: boolean;
    byKey: Map<string, PlaceableRecord>;
  };
}
