// ImageSearchPicker — a universal "pick a photo from the web" strip. Searches
// DuckDuckGo images for a query, ranks them by catalog quality, and shows a
// scrollable strip of candidates; clicking one calls onPick(url). Used anywhere
// an entity needs a photo (the scan inbox's catalog photos, a 3D printer's
// product shot, …) — the ONE web-image selector for the whole app.
//
// Two modes:
//   • query/brand — fetches candidates for that query (generic; printers, etc.)
//   • items/loading — render a caller-supplied ranked list (the scan inbox keeps
//     its item-derived query + server ranking and just feeds the result in).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ImageOption } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function ImageSearchPicker({
  query,
  brand,
  items: itemsProp,
  loading: loadingProp,
  onPick,
  busy,
  label,
  enabled = true,
}: {
  /** Generic mode: build candidates from this query. */
  query?: string;
  brand?: string;
  /** Pre-fetched mode: render a caller-supplied ranked list instead of fetching. */
  items?: ImageOption[];
  loading?: boolean;
  /** Called with the chosen image's full-size url. The caller applies it. */
  onPick: (url: string) => void;
  /** Disable tiles while the caller is saving the pick. */
  busy?: boolean;
  label?: string;
  enabled?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const usesQuery = itemsProp === undefined;
  const fetched = useQuery({
    queryKey: ["image-options", activeSlug, query, brand],
    queryFn: () => api.imageOptions(activeSlug, query ?? "", brand),
    enabled: enabled && usesQuery && !!activeSlug && !!query && query.trim().length >= 2,
    staleTime: 5 * 60_000,
  });
  const loading = usesQuery ? fetched.isFetching : !!loadingProp;
  const source = itemsProp ?? fetched.data?.items ?? [];

  // Drop options whose thumbnail won't load (dead hotlink / 404) so the strip
  // never shows a broken tile.
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const opts = source.filter((o) => !broken.has(o.url));

  if (loading) return <div className="text-[11px] text-faint animate-pulse">finding photo options…</div>;
  if (opts.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
        {label ?? "photo options"} <span className="text-faint normal-case">· DuckDuckGo</span>
      </div>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
        {opts.map((o) => (
          <button
            key={o.url}
            type="button"
            disabled={busy}
            onClick={() => onPick(o.url)}
            title={`${o.title} — ${o.source}`}
            className="w-14 h-14 shrink-0 rounded border border-line dark:border-slate-700 overflow-hidden bg-white hover:border-cobble-400 transition disabled:opacity-50"
          >
            <img
              src={o.thumb}
              alt={o.title}
              className="w-full h-full object-cover"
              loading="lazy"
              onError={() => setBroken((s) => new Set(s).add(o.url))}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
