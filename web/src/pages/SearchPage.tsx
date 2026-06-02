// /search?q=… — full results page for the global search bar.
// Same backend as the header dropdown but no result cap; results are
// grouped by kind so the page reads like a faceted browse.
//
// Filters expose ?q (free text), ?tag (single tag chip), ?kinds
// (comma-separated kind ids) — all editable in-page so users don't
// have to know the URL syntax.

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { EntityThumb, usePageTitle } from "@cobblr/platform-web";
import { api, type SearchHit } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function SearchPage() {
  usePageTitle("Search");
  const { activeSlug } = useActiveOrg();
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const kindsParam = params.get("kinds") ?? "";
  const kinds = kindsParam || undefined;
  const tag = (params.get("tag") ?? "").trim() || undefined;

  const entityKinds = useQuery({
    queryKey: ["entity-kinds-for-search", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug),
    enabled: !!activeSlug,
    staleTime: 5 * 60_000,
  });

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

  function setParam(name: string, value: string | null) {
    if (value === null || value === "") params.delete(name);
    else params.set(name, value);
    setParams(params, { replace: true });
  }

  const selectedKinds = new Set(kindsParam.split(",").filter(Boolean));
  function toggleKind(id: string) {
    const next = new Set(selectedKinds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setParam("kinds", next.size === 0 ? null : Array.from(next).join(","));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3 flex-wrap">
        <Search size={20} className="text-accent" />
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100">
          Search
        </h1>
        <span className="text-sm text-muted dark:text-slate-400">
          {results.data ? `${results.data.items.length} results` : ""}
        </span>
        <div className="flex-1" />
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <input
            type="text"
            value={q}
            onChange={(e) => setParam("q", e.target.value || null)}
            placeholder="search…"
            className="input !py-1 !pl-7 !text-xs !w-56"
            autoFocus
          />
        </div>
      </div>

      {/* Active filter chips — clear individually with the × button. */}
      {(tag || selectedKinds.size > 0 || q) && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-mono uppercase tracking-wider text-faint text-[10px]">
            filters
          </span>
          {q && (
            <Chip onClear={() => setParam("q", null)}>
              q: "<span className="font-mono">{q}</span>"
            </Chip>
          )}
          {tag && (
            <Chip onClear={() => setParam("tag", null)}>#{tag}</Chip>
          )}
          {Array.from(selectedKinds).map((k) => (
            <Chip key={k} onClear={() => toggleKind(k)}>
              <span className="font-mono">{k}</span>
            </Chip>
          ))}
        </div>
      )}

      {/* Kind picker — list each registered kind as a toggleable chip. */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="font-mono uppercase tracking-wider text-faint text-[10px]">
          kinds
        </span>
        {(entityKinds.data?.items ?? []).map((k) => {
          const on = selectedKinds.has(k.id);
          return (
            <button
              key={k.id}
              type="button"
              onClick={() => toggleKind(k.id)}
              className={
                "px-2 py-0.5 rounded text-[11px] border transition " +
                (on
                  ? "bg-cobble-600 text-white border-cobble-600"
                  : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-accent hover:text-accent")
              }
            >
              {k.display_name}
            </button>
          );
        })}
      </div>

      {/* Tag input — narrow to entities carrying a tag, no view required. */}
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono uppercase tracking-wider text-faint text-[10px]">
          tag
        </span>
        <input
          type="text"
          value={tag ?? ""}
          onChange={(e) => setParam("tag", e.target.value || null)}
          placeholder="filter by tag name…"
          className="input !py-1 !text-xs !w-48"
        />
      </div>

      {!q && !tag && (
        <p className="text-sm text-muted dark:text-slate-400 italic mt-6">
          Type a query above, or filter by tag, or pick a kind — results
          appear as you type.
        </p>
      )}

      {results.isLoading && (
        <div className="text-sm text-muted">Searching…</div>
      )}

      {(q || tag) && !results.isLoading && grouped.length === 0 && (
        <div className="text-sm text-muted italic">
          No results{q ? ` for "${q}"` : ""}
          {tag ? ` tagged #${tag}` : ""}. Try a different keyword, a different
          tag, or relax the kind filters.
        </div>
      )}

      {grouped.map(([kind, items]) => (
        <section key={kind} className="space-y-2">
          <h2 className="text-sm font-medium text-content dark:text-slate-300 sticky top-0 bg-subtle dark:bg-slate-950 py-1 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
              {kind}
            </span>
            <span className="text-xs text-faint">{items.length}</span>
          </h2>
          <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800 bg-surface dark:bg-slate-900">
            {items.map((h) => (
              <li key={`${h.kind}:${h.id}`} className="px-3 py-2 text-sm">
                <Link
                  to={detailRoute(h.kind, h.id)}
                  className="flex items-center gap-3 hover:text-accent"
                >
                  <EntityThumb src={h.image_path} alt={h.title} size={36} />
                  <span className="font-medium truncate">{h.title}</span>
                  {h.subtitle && (
                    <span className="text-xs text-muted truncate">
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

function Chip({
  children,
  onClear,
}: {
  children: React.ReactNode;
  onClear: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-cobble-50 dark:bg-cobble-900/30 text-accent dark:text-cobble-300 border border-cobble-200 dark:border-cobble-700">
      {children}
      <button
        type="button"
        onClick={onClear}
        className="hover:text-ember-500 transition"
        title="Clear"
      >
        <X size={10} />
      </button>
    </span>
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
