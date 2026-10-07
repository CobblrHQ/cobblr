// Every record that can be put somewhere, from every collection that keeps
// things in places, read once and shared: the floor plan draws them, the
// place-items rail lists them, and the per-place counts are counted from them,
// so the three cannot disagree about where a thing is.
//
// PLACEABLE KINDS come from the entity-kind registry: a kind that declares its
// own list and update endpoints (the manifest seam) and is physically
// tangible. Any module joins with one manifest line; nothing is named here.
// A kind whose rows carry no location_id never shows as placed.

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, type PlatformEntityKind } from "./api";

/** Rows a declared list endpoint returns (the manifest's row-shape contract). */
interface ListedRow {
  id: string;
  name?: string;
  title?: string;
  /** The record's own short name, when its kind has one ("P1S"). */
  short_name?: string | null;
  image_path?: string | null;
  location_id?: string | null;
  metadata?: Record<string, unknown>;
  qty?: number | string | null;
  holdings?: Array<{ id: string; location_id: string | null; location_name?: string | null; qty: number }>;
  rollup?: { qty: number; places: number };
}

/** One place a thing is kept, when it is kept in several. */
export interface PlacedHolding {
  id: string;
  location_id: string | null;
  location_name: string | null;
  qty: number;
}

export interface PlaceableRecord {
  kind: string;
  id: string;
  name: string;
  /** Its short name, when it has one: what a small drawing of it says. */
  short_name: string | null;
  image_path: string | null;
  location_id: string | null;
  metadata: Record<string, unknown>;
  /** The collection it belongs to, as a person names it ("Groceries"). */
  collection: string;
  /** The instance whose door its writes go through ("inventory" for the base). */
  instance: string | null;
  module: string;
  /** How many, when the collection counts. */
  qty: number | null;
  /** Its places, when it is kept in more than one (#3798). */
  holdings: PlacedHolding[] | null;
}

function traitAxis(t: unknown): string | null {
  if (t == null) return null;
  if (typeof t === "string") return t;
  const v = (t as { trait?: unknown }).trait;
  return typeof v === "string" ? v : null;
}

export function isPlaceableKind(k: PlatformEntityKind): boolean {
  return !!k.endpoints?.list && !!k.endpoints?.update && traitAxis((k as { traits?: Record<string, unknown> }).traits?.tangibility) === "physical";
}

/** Every place a record is in: its holdings' places when it is kept in several,
 *  else its own location. Empty when it has no place. */
export function placesOf(r: PlaceableRecord): string[] {
  if (r.holdings && r.holdings.length > 1) return [...new Set(r.holdings.map((h) => h.location_id).filter((x): x is string => !!x))];
  return r.location_id ? [r.location_id] : [];
}

export function isUnplaced(r: PlaceableRecord): boolean {
  return placesOf(r).length === 0;
}

/** `fresh`: ask again whenever the surface opens (the place-items view, where
 *  a thing listed a moment ago on another page must be there to place). */
export function usePlaceableRecords(slug: string, opts: { fresh?: boolean } = {}): {
  kinds: PlatformEntityKind[];
  records: PlaceableRecord[];
  isLoading: boolean;
} {
  const kindsQ = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });
  const kinds = useMemo(() => (kindsQ.data?.items ?? []).filter(isPlaceableKind), [kindsQ.data]);
  const lists = useQueries({
    queries: kinds.map((k) => ({
      queryKey: ["kind-list", slug, k.id],
      queryFn: () =>
        api.request<{ items: ListedRow[] }>(
          "GET",
          `/orgs/${slug}/${k.instance_name ? `instances/${k.instance_name}` : `modules/${k.module_name}`}${k.endpoints!.list}`,
        ),
      staleTime: 30_000,
      // An action on one of these records refreshes the list wherever it is
      // shown (platform-web run-action).
      meta: { kinds: [k.id] },
      ...(opts.fresh ? { refetchOnMount: "always" as const } : {}),
    })),
  });
  const records = useMemo(() => {
    const out: PlaceableRecord[] = [];
    kinds.forEach((k, i) => {
      for (const row of lists[i]?.data?.items ?? []) {
        const n = row.qty === null || row.qty === undefined || row.qty === "" ? NaN : Number(row.qty);
        out.push({
          kind: k.id,
          id: row.id,
          name: row.name ?? row.title ?? "(unnamed)",
          short_name: typeof row.short_name === "string" && row.short_name.trim() ? row.short_name.trim() : null,
          image_path: row.image_path ?? null,
          location_id: row.location_id ?? null,
          metadata: row.metadata ?? {},
          collection: k.display_name_plural || k.display_name,
          instance: k.instance_name ?? null,
          module: k.module_name,
          qty: Number.isFinite(n) ? n : null,
          holdings:
            row.holdings && row.holdings.length > 1
              ? row.holdings.map((h) => ({ id: h.id, location_id: h.location_id, location_name: h.location_name ?? null, qty: Number(h.qty) }))
              : null,
        });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds, ...lists.map((q) => q.data)]);
  return { kinds, records, isLoading: kindsQ.isLoading || lists.some((q) => q.isLoading) };
}
