// A saved view's records, ALL of them, and the count the server gave.
//
// The view endpoint walks every page when asked without a limit, so almost
// every view arrives whole in one answer. Past the walk's cap the answer says
// `complete: false`, and this pages on from where it stopped, visibly, when
// the surface asks (`loadMore`). The count is the server's `total`: a view
// that counted what it had loaded read "50 3D printers" with 56 on file.
import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ViewDataResponse } from "./api";

const MORE_PAGE = 500;

export interface ViewData {
  items: ViewDataResponse["items"];
  groups?: ViewDataResponse["groups"];
  totals?: ViewDataResponse["totals"];
  loadGroup?: (keys: Array<string | null>, offset: number) => void;
  loadingGroup?: string;
  /** The collection's count. Null only when it could not say. */
  total: number | null;
  /** Every record is in `items`. */
  complete: boolean;
  isLoading: boolean;
  isError?: boolean;
  refetch?: () => void;
  collectionEmpty?: boolean;
  unapplied?: ViewDataResponse["unapplied"];
  /** Load the next page, when there is one. */
  loadMore?: () => void;
  loadingMore: boolean;
  /** The view as the server named it (its kind, for a caller that did not know it). */
  view?: ViewDataResponse["view"];
}

/** `kind` is the view's entity kind when the caller knows it; a caller that
 *  holds only a view id passes null and any action re-reads it. `q` narrows
 *  the view to records whose text contains it. */
export function useViewData(
  slug: string | null | undefined,
  viewId: string | null | undefined,
  kind: string | null,
  opts: { enabled?: boolean; q?: string } = {},
): ViewData {
  const qc = useQueryClient();
  const [loadingGroup, setLoadingGroup] = useState<string>();
  const [groupError, setGroupError] = useState(false);
  const enabled = opts.enabled ?? true;
  const text = opts.q?.trim() || undefined;
  const q = useInfiniteQuery({
    // The view's kind rides in the key, so an action on one of its records
    // refreshes it wherever it is shown (platform-web run-action).
    queryKey: ["view-data", slug, viewId, kind ?? "", text ?? ""],
    ...(kind === null ? { meta: { kinds: "*" as const } } : {}),
    queryFn: ({ pageParam }) =>
      pageParam.offset === 0 && pageParam.group_offset === 0
        ? api.viewData(slug!, viewId!, { q: text })
        : api.viewData(slug!, viewId!, { q: text, offset: pageParam.offset, group_offset: pageParam.group_offset, limit: MORE_PAGE }),
    initialPageParam: { offset: 0, group_offset: 0 },
    getNextPageParam: (last, pages) => {
      const first = pages[0];
      if (!first) return undefined;
      if (first.groups) {
        const groups = pages.flatMap((p) => p.groups ?? []);
        const depth = Math.max(0, ...groups.map((g) => g.keys.length));
        const loaded = new Set(groups.filter((g) => g.keys.length === depth).map((g) => JSON.stringify(g.keys))).size;
        return loaded < (first.group_total ?? 0) ? { offset: 0, group_offset: loaded } : undefined;
      }
      if (last.items.length === 0) return undefined;
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      if (first.total !== null && loaded >= first.total) return undefined;
      return last.complete && pages.length === 1 ? undefined : { offset: loaded, group_offset: 0 };
    },
    enabled: enabled && !!slug && !!viewId,
  });
  const pages = q.data?.pages ?? [];
  const first = pages[0];
  const items = [...new Map(pages.flatMap((p) => p.items).map((r) => [r.id, r])).values()];
  const groupMap = new Map<string, NonNullable<ViewDataResponse["groups"]>[number]>();
  for (const g of pages.flatMap((p) => p.groups ?? [])) {
    const key = JSON.stringify(g.keys);
    const previous = groupMap.get(key);
    groupMap.set(key, { ...g, item_ids: [...new Set([...(previous?.item_ids ?? []), ...g.item_ids])] });
  }
  const complete = !q.hasNextPage && !!first && (!first.groups || [...groupMap.values()].every((g) => !g.item_ids.length || g.item_ids.length >= g.count));
  return {
    items,
    groups: first?.groups ? [...groupMap.values()] : undefined,
    totals: first?.totals,
    loadingGroup,
    loadGroup: first?.groups ? async (keys, offset) => {
      if (loadingGroup) return;
      setLoadingGroup(JSON.stringify(keys));
      setGroupError(false);
      try {
        const page = await api.viewData(slug!, viewId!, { q: text, group_keys: keys, offset, limit: 50 });
        qc.setQueryData<typeof q.data>(["view-data", slug, viewId, kind ?? "", text ?? ""], (previous) => previous ? { ...previous, pages: [...previous.pages, page], pageParams: [...previous.pageParams, { offset, group_offset: 0 }] } : previous);
      } catch { setGroupError(true); } finally { setLoadingGroup(undefined); }
    } : undefined,
    total: first?.total ?? (complete ? items.length : null),
    complete,
    isLoading: q.isLoading,
    isError: q.isError || groupError,
    refetch: () => void q.refetch(),
    collectionEmpty: first?.collection_empty,
    unapplied: first?.unapplied,
    loadMore: q.hasNextPage ? () => void q.fetchNextPage() : undefined,
    loadingMore: q.isFetchingNextPage,
    view: first?.view,
  };
}
