import { fetchCsv, request } from "./client";
import type { MoneyTotal } from "@cobblr/platform-contract/money";

export interface PlatformResolvedEntity {
  kind: string;
  id: string;
  /** The named collection a record lives in, when it is not its module's
   *  default one ("groceries" for a grocery). */
  instance?: string | null;
  title: string;
  subtitle?: string;
  image_path?: string;
  detailUrl?: string;
  fields: Record<string, unknown>;
}

export interface PlacedThing extends PlatformResolvedEntity {
  slot: string | null;
  position: { x_mm: number; y_mm: number } | null;
}

/** A record that holds things (a Backpack), with where it is itself. */
export interface PlaceHolder {
  kind: string;
  id: string;
  title: string;
  detailUrl: string | null;
  /** "Desk drawer, in Office"; empty when it has no place of its own. */
  line: string;
  /** How many things are inside it. */
  holds: number;
}

export const placementApi = {
  placementContents: (slug: string, containerKind: string, containerId: string) =>
    request<{ items: PlacedThing[] }>(
      "GET",
      `/orgs/${slug}/modules/core-placement/contents?container_kind=${encodeURIComponent(containerKind)}&container_id=${encodeURIComponent(containerId)}`,
    ),
  placementContainerOf: (slug: string, containeeKind: string, containeeId: string) =>
    request<{ container: PlatformResolvedEntity | null }>(
      "GET",
      `/orgs/${slug}/modules/core-placement/of?containee_kind=${encodeURIComponent(containeeKind)}&containee_id=${encodeURIComponent(containeeId)}`,
    ),
  /** Records that hold things and are not places by nature (a Backpack, a
   *  toolbox): offered beside the places wherever a place is picked. */
  placementHolders: (slug: string) =>
    request<{ items: PlaceHolder[] }>("GET", `/orgs/${slug}/modules/core-placement/holders`),
  /** What a kind calls the things inside its records ("Parts"); null word = "Contents". */
  contentsWord: (slug: string, kind: string) =>
    request<{ word: string | null; custom: string | null; default_word: string | null }>(
      "GET",
      `/orgs/${slug}/modules/core-placement/word?kind=${encodeURIComponent(kind)}`,
    ),
  insuranceList: (slug: string, within: { kind: string; id: string }, format: "csv" | "pdf") =>
    fetchCsv(`/orgs/${slug}/modules/core-placement/insurance-list.${format}?within_kind=${encodeURIComponent(within.kind)}&within_id=${encodeURIComponent(within.id)}`),
  /** What everything is worth, each thing once: the workspace, or one place. */
  placementWorth: (slug: string, within?: { kind: string; id: string } | null) =>
    request<{ total: number; records: number; unpriced: number; withheld: boolean; currency?: string; excluded?: Record<string, number>; conversions?: MoneyTotal["conversions"] }>(
      "GET",
      `/orgs/${slug}/modules/core-placement/worth${within ? `?within_kind=${encodeURIComponent(within.kind)}&within_id=${encodeURIComponent(within.id)}` : ""}`,
    ),
  placementPath: (slug: string, containeeKind: string, containeeId: string) =>
    request<{
      path: Array<{ kind: string; id: string; name: string }>;
      line: string;
      /** The thing it sits inside, when that is not a place (a Backpack). */
      inside?: { kind: string; id: string; name: string } | null;
    }>(
      "GET",
      `/orgs/${slug}/modules/core-placement/path?containee_kind=${encodeURIComponent(containeeKind)}&containee_id=${encodeURIComponent(containeeId)}`,
    ),
  placementPlace: (
    slug: string,
    body: {
      containee: { kind: string; id: string };
      container: { kind: string; id: string };
      slot?: string | null;
      /** An exact point inside the container, in mm; null clears it. */
      position?: { x_mm: number; y_mm: number } | null;
      /** Where the move was made, for the activity ("floor plan"). */
      via?: string;
    },
  ) => request<void>("POST", `/orgs/${slug}/modules/core-placement/place`, body),
  placementRemove: (slug: string, containee: { kind: string; id: string }) =>
    request<void>("POST", `/orgs/${slug}/modules/core-placement/remove`, { containee }),
};
