// The pictures the platform suggested for a collection's records (#3818),
// keyed by record id, for its cards and its record page. Here, not in the web
// app, so a module-owned list (a part gallery) shows them the same way. Polls
// while any is still being looked for, so a record made a moment ago shows
// its suggestion without a reload.

import { useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import type { PhotoSuggestionRow } from "./types";

export function usePhotoSuggestions(kind: string | null | undefined): Map<string, PhotoSuggestionRow> {
  const { api, orgSlug } = usePlatformWeb();
  const q = useQuery({
    queryKey: ["photo-suggestions", orgSlug, kind],
    queryFn: () => api.listPhotoSuggestions!(orgSlug, kind!),
    enabled: !!orgSlug && !!kind && !!api.listPhotoSuggestions,
    staleTime: 5_000,
    refetchInterval: (query) => ((query.state.data?.items ?? []).some((i) => i.status === "queued") ? 4_000 : 15_000),
  });
  return useMemo(() => new Map((q.data?.items ?? []).map((i) => [i.entity_id, i])), [q.data]);
}

/** One record's suggestion, by its id alone: a record page may name the base
 *  kind while the record was saved under its instance's. */
export function usePhotoSuggestionFor(id: string): PhotoSuggestionRow | undefined {
  const { api, orgSlug } = usePlatformWeb();
  const q = useQuery({
    queryKey: ["photo-suggestions", orgSlug, "record", id],
    queryFn: () => api.listPhotoSuggestions!(orgSlug, null, [id]),
    enabled: !!orgSlug && !!id && !!api.listPhotoSuggestions,
    staleTime: 5_000,
    refetchInterval: (query) => ((query.state.data?.items ?? []).some((i) => i.status === "queued") ? 4_000 : 15_000),
  });
  return q.data?.items.find((i) => i.entity_id === id);
}

/** The suggested picture a card shows for a record with none of its own. */
export function suggestedSrcFor(suggestions: Map<string, PhotoSuggestionRow>, id: string, ownSrc: string | null | undefined): string | null {
  if (ownSrc) return null;
  const s = suggestions.get(id);
  return s?.status === "suggested" ? s.image_path : null;
}

/** What a record with no picture of its own shows in place of one, besides a
 *  suggested picture: still being looked for, or looked for and not found. */
export type PictureState = "looking" | "not_found";

export function pictureStateFor(suggestions: Map<string, PhotoSuggestionRow>, id: string, ownSrc: string | null | undefined): PictureState | undefined {
  if (ownSrc) return undefined;
  const status = suggestions.get(id)?.status;
  return status === "queued" ? "looking" : status === "none" ? "not_found" : undefined;
}

/** The words for a picture state, one copy for every card that says it. */
export const PICTURE_STATE_TEXT: Record<PictureState, string> = {
  looking: "Looking for a picture…",
  not_found: "No picture found",
};

// A page that shows the offer beside the record's own picture says so here,
// and the universal panel on the same page stays quiet, so one record never
// offers the same picture twice.
const shownBeside = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
function changed(): void {
  version++;
  for (const l of listeners) l();
}
export function markShownBeside(id: string): () => void {
  shownBeside.add(id);
  changed();
  return () => {
    shownBeside.delete(id);
    changed();
  };
}
export function useShownBeside(id: string): boolean {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
  return shownBeside.has(id);
}
