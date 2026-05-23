// /search?q=… — full results page for the global search bar.
// Same backend as the header dropdown but no result cap; results are
// grouped by kind so the page reads like a faceted browse.

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api, type SearchHit } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function SearchPage() {
  const { activeSlug } = useActiveOrg();
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const kinds = params.get("kinds") ?? undefined;
  // `?tag=urgent` (with or without `?q=`) restricts results to
  // entities carrying that tag. core-search forwards it as the D7
  // `_tag` predicate to every list resolver that supports it.
  const tag = (params.get("tag") ?? "").trim() || undefined;

  const results = useQuery({
    queryKey: ["search-full", activeSlug, q, kinds ?? "", tag ?? ""],
    queryFn: () => api.search(activeSlug, { q: q || undefined, kinds, tag }),
    enabled: !!activeSlug && (q.length > 0 || !!tag),
  });

  const grouped = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of results.data?.items ?? []) {
      const arr = m.get(h.kind) ?? [];
      arr.push(h);
      m.set(h.kind, arr);
    }
    return Array.from(m.entries());
  }, [results.data?.items]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-slate-200 dark:border-slate-700 pb-3">
        <Search size={20} className="text-cobble-600" />
        <h1 className="text-2xl font-semibold text-slate-700 dark:text-mortar-100">
          Search
        </h1>
        {q && (
          <span className="text-sm text-slate-500 dark:text-slate-400">
            for "<span className="font-mono">{q}</span>"
          </span>
        )}
        {tag && (
          <span className="text-sm text-slate-500 dark:text-slate-400">
            tag <span className="font-mono">#{tag}</span>
          </span>
        )}
      </div>

      {!q && !tag && (
        <p className="text-sm text-slate-500 dark:text-slate-400 italic">
          Type in the header bar to search across every kind in this workspace,
          or visit{" "}
          <span className="font-mono text-xs">?tag=&lt;name&gt;</span> to list
          everything carrying that tag.
        </p>
      )}

      {results.isLoading && (
        <div className="text-sm text-slate-500">Searching…</div>
      )}

      {(q || tag) && !results.isLoading && grouped.length === 0 && (
        <div className="text-sm text-slate-500 italic">
          No results{q ? ` for "${q}"` : ""}
          {tag ? ` tagged #${tag}` : ""}. Try a different keyword, a different
          tag, or check that the relevant module is enabled.
        </div>
      )}

      {grouped.map(([kind, items]) => (
        <section key={kind} className="space-y-2">
          <h2 className="text-sm font-medium text-slate-600 dark:text-slate-300 sticky top-0 bg-white dark:bg-slate-950 py-1">
            {kind}
            <span className="ml-2 text-xs text-slate-400">{items.length}</span>
          </h2>
          <ul className="border border-slate-200 dark:border-slate-700 rounded divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((h) => (
              <li key={h.id} className="px-3 py-2 text-sm">
                <Link
                  to={detailRoute(h.kind, h.id)}
                  className="flex items-baseline gap-3 hover:text-cobble-600"
                >
                  <span className="font-medium truncate">{h.title}</span>
                  {h.subtitle && (
                    <span className="text-xs text-slate-500 truncate">
                      {h.subtitle}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function detailRoute(kind: string, id: string): string {
  const [moduleName, type] = kind.split(":");
  if (moduleName === "inventory" && type === "part") return `/inventory/parts/${id}`;
  if (moduleName === "machines" && type === "machine") return `/machines/${id}`;
  if (moduleName === "assets" && type === "asset") return `/assets/${id}`;
  if (moduleName === "projects" && type === "project") return `/projects/${id}`;
  if (moduleName === "projects" && type === "task") return `/projects/tasks/${id}`;
  if (moduleName === "purchases" && type === "order") return `/purchases/${id}`;
  return "#";
}
