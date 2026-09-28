// A saved view's records, ALL of them, and the count the server gave.
//
// The view endpoint walks every page when asked without a limit, so almost
// every view arrives whole in one answer. Past the walk's cap the answer says
// `complete: false`, and this pages on from where it stopped, visibly, when
// the surface asks (`loadMore`). The count is the server's `total`: a view
// that counted what it had loaded read "50 3D printers" with 56 on file.
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, type ViewDataResponse } from "./api";

const MORE_PAGE = 500;

export interface ViewData {
  items: ViewDataResponse["items"];
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
  const enabled = opts.enabled ?? true;
  const text = opts.q?.trim() || undefined;
  const q = useInfiniteQuery({
    // The view's kind rides in the key, so an action on one of its records
    // refreshes it wherever it is shown (platform-web run-action).
    queryKey: ["view-data", slug, viewId, kind ?? "", text ?? ""],
    ...(kind === null ? { meta: { kinds: "*" as const } } : {}),
    queryFn: ({ pageParam }) =>
      pageParam === 0
        ? api.viewData(slug!, viewId!, { q: text })
        : api.viewData(slug!, viewId!, { q: text, offset: pageParam, limit: MORE_PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const first = pages[0];
      if (!first || last.items.length === 0) return undefined;
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      if (first.total !== null && loaded >= first.total) return undefined;
      return last.complete && pages.length === 1 ? undefined : loaded;
    },
    enabled: enabled && !!slug && !!viewId,
  });
  const pages = q.data?.pages ?? [];
  const first = pages[0];
  const items = pages.flatMap((p) => p.items);
  const complete = !q.hasNextPage && !!first;
  return {
    items,
    total: first?.total ?? (complete ? items.length : null),
    complete,
    isLoading: q.isLoading,
    isError: q.isError,
    refetch: () => void q.refetch(),
    collectionEmpty: first?.collection_empty,
    unapplied: first?.unapplied,
    loadMore: q.hasNextPage ? () => void q.fetchNextPage() : undefined,
    loadingMore: q.isFetchingNextPage,
    view: first?.view,
  };
}
