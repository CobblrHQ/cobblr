// /search?q=… — full results page for the global search bar.
// Same backend as the header dropdown, grouped by kind so the page reads like
// a faceted browse. Each group shows its first PAGE and, when the server says
// that kind has more (more_kinds), a "Show more" that asks for the next page
// of that kind alone. The box waits 200 ms after the last key before it asks,
// as the header bar and the palette do: a query per keystroke was a query per
// letter of every word anybody typed.
//
// Filters expose ?q (free text), ?tag (single tag chip), ?kinds
// (comma-separated kind ids) — all editable in-page so users don't
// have to know the URL syntax.

import { useEffect, useMemo, useState } from "react";
import { useAddressDraft } from "../lib/useAddressDraft";
import { useKindLabels } from "../lib/useKindLabels";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Search, X } from "lucide-react";
import { EntityThumb, SnippetText, usePageTitle, SearchInput, useToast } from "@cobblr/platform-web";
import { api, ApiError, type SearchHit } from "../lib/api";
import { QueryError } from "../components/QueryError";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useDetailRoute } from "../lib/useDetailRoute";
import { SearchIncomplete } from "../components/SearchIncomplete";
import { useExactHits } from "../lib/useExactHits";
import { countOf } from "@cobblr/platform-contract/plural";

/** Rows of each kind per page. */
const PAGE = 20;

export function SearchPage() {
  const toast = useToast();
  const light = async (kind: string, id: string) => {
    try { toast.success((await api.requestLight(activeSlug, { kind, id })).note); }
    catch (e) { toast.error(e instanceof Error ? e.message : "The light did not answer."); }
  };
  usePageTitle("Search");
  const { activeSlug } = useActiveOrg();
  const labels = useKindLabels(activeSlug);
  const routeFor = useDetailRoute(activeSlug);
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const kindsParam = params.get("kinds") ?? "";
  const kinds = kindsParam || undefined;
  const tag = (params.get("tag") ?? "").trim() || undefined;

  // Only the kinds a search can reach: a chip for a kind with no list
  // resolver (a print job) could only ever find nothing.
  const entityKinds = useQuery({
    queryKey: ["search-kinds", activeSlug],
    // An api older than /search/kinds (a web deployed ahead of it) still
    // gets its chips, from every kind, as before.
    queryFn: () =>
      api.searchKinds(activeSlug).catch((e: unknown) => {
        // 404-is: an-older-api: a web deployed ahead of the api that serves /search/kinds
        if (e instanceof ApiError && e.status === 404) return api.listEntityKinds(activeSlug);
        throw e;
      }),
    enabled: !!activeSlug,
    staleTime: 5 * 60_000,
  });
  // An exact identifier (a serial, a code) leads, as in the palette.
  const exactAll = useExactHits(activeSlug, q, "search");

  // Where-is-it chip: hits whose fields carry a location_id get their
  // location's name inline — zone chips for search, zero API changes (kinds
  // whose resolver doesn't expose location_id just never show one).
  const locsQ = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const locName = useMemo(() => {
    const m = new Map((locsQ.data?.items ?? []).map((l) => [l.id, l.name] as const));
    return (h: SearchHit): string | null => {
      if (h.where) return h.where;
      const lid = h.fields?.location_id;
      return typeof lid === "string" ? (m.get(lid) ?? null) : null;
    };
  }, [locsQ.data]);

  const results = useQuery({
    queryKey: ["search-full", activeSlug, q, kinds ?? "", tag ?? ""],
    queryFn: () => api.search(activeSlug, { q: q || undefined, kinds, tag, per_kind: PAGE }),
    // A kind on its own browses that kind.
    enabled: !!activeSlug && (q.length > 0 || !!tag || !!kinds),
  });

  // Later pages, per kind: what "Show more" fetched, and whether that kind
  // still has more. A new query starts over.
  const [more, setMore] = useState<Map<string, { items: SearchHit[]; more: boolean }>>(new Map());
  const [loadingKind, setLoadingKind] = useState<string | null>(null);
  useEffect(() => setMore(new Map()), [activeSlug, q, kinds, tag]);

  const grouped = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const h of results.data?.items ?? []) {
      const arr = m.get(h.kind) ?? [];
      arr.push(h);
      m.set(h.kind, arr);
    }
    for (const [kind, page] of more) m.set(kind, [...(m.get(kind) ?? []), ...page.items]);
    return Array.from(m.entries());
  }, [results.data?.items, more]);
  // The exact match answers the same filters as the results (#8058): a kind
  // chip keeps only a match of that kind, and a tag keeps only a match the
  // filtered results also hold, since only they know what carries the tag.
  const exact = useMemo(() => {
    const picked = new Set((kinds ?? "").split(",").filter(Boolean));
    return exactAll.filter((c) =>
      (picked.size === 0 || picked.has(c.entity_kind)) &&
      (!tag || grouped.some(([kind, items]) => kind === c.entity_kind && items.some((h) => h.id === c.entity_id))));
  }, [exactAll, kinds, tag, grouped]);
  // An api older than more_kinds (a web deployed ahead of it) still pages:
  // a kind that filled its page may have more.
  const firstPageFull = (kind: string) => (results.data?.items ?? []).filter((h) => h.kind === kind).length >= PAGE;
  const hasMore = (kind: string) =>
    more.get(kind)?.more ?? (results.data?.more_kinds ? results.data.more_kinds.includes(kind) : firstPageFull(kind));
  // The exact match counts, unless its row is also among the results.
  const shown =
    grouped.reduce((n, [, items]) => n + items.length, 0) +
    exact.filter((c) => !grouped.some(([kind, items]) => kind === c.entity_kind && items.some((h) => h.id === c.entity_id))).length;
  const anyMore = grouped.some(([kind]) => hasMore(kind));
  // How many there are in all, where every kind with more could count them:
  // 2,033 resistors read "20 results, and more below" (#8657).
  const totalOf = (kind: string, loaded: number): number | undefined => {
    const t = results.data?.totals?.[kind];
    return typeof t === "number" ? Math.max(t, loaded) : undefined;
  };
  const found = grouped.length > 0 && grouped.every(([kind, items]) => !hasMore(kind) || totalOf(kind, items.length) !== undefined)
    ? shown + grouped.reduce((n, [kind, items]) => n + ((totalOf(kind, items.length) ?? items.length) - items.length), 0)
    : undefined;
  const resultsWord = (n: number) => `${n.toLocaleString()} ${n === 1 ? "result" : "results"}`;
  const countLine = found !== undefined
    ? found > shown ? `${resultsWord(found)}, ${shown.toLocaleString()} shown` : resultsWord(found)
    : `${countOf(shown, "result")}${anyMore ? ", and more below" : ""}`;

  async function showMore(kind: string, loaded: number) {
    setLoadingKind(kind);
    try {
      const r = await api.search(activeSlug, { q: q || undefined, kinds: kind, tag, per_kind: PAGE, offset: loaded });
      setMore((prev) => {
        const next = new Map(prev);
        const before = next.get(kind)?.items ?? [];
        const got = r.items.filter((h) => h.kind === kind);
        next.set(kind, { items: [...before, ...got], more: r.more_kinds ? r.more_kinds.includes(kind) : got.length >= PAGE });
        return next;
      });
    } finally {
      setLoadingKind(null);
    }
  }

  // The box is the page's own until the typing stops; the address follows,
  // and only a change from elsewhere (the header bar, Back) replaces it.
  const [draft, setDraft] = useAddressDraft(q, (value) => setParam("q", value));

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
          {results.data ? countLine : ""}
        </span>
        <div className="flex-1" />
        <SearchInput value={draft} onChange={setDraft} placeholder="search…" aria-label="Search" autoFocus wrapperClassName="w-56" />
      </div>

      {/* Active filter chips — clear individually with the × button. */}
      {(tag || selectedKinds.size > 0 || q) && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="uppercase tracking-wider text-faint text-[10px]">
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
      <div role="group" aria-label="Kinds to search" className="flex items-center gap-2 flex-wrap text-xs">
        <span className="uppercase tracking-wider text-faint text-[10px]">
          kinds
        </span>
        {(entityKinds.data?.items ?? []).map((k) => {
          const on = selectedKinds.has(k.id);
          return (
            <button
              key={k.id}
              type="button"
              onClick={() => toggleKind(k.id)}
              aria-pressed={on}
              className={
                "min-h-11 inline-flex items-center gap-1 px-3 rounded text-[11px] border transition " +
                (on
                  ? "bg-cobble-600 text-white border-cobble-600"
                  : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-accent hover:text-accent")
              }
            >
              {on && <Check size={12} strokeWidth={2.5} aria-hidden />}
              {k.display_name}
            </button>
          );
        })}
      </div>

      {/* Tag input — narrow to entities carrying a tag, no view required. */}
      <div className="flex items-center gap-2 text-xs">
        <span className="uppercase tracking-wider text-faint text-[10px]">
          tag
        </span>
        <SearchInput value={tag ?? ""} onChange={(v) => setParam("tag", v || null)} placeholder="filter by tag name…" aria-label="Filter by tag name" size="sm" wrapperClassName="w-48" />
      </div>

      {!q && !tag && !kinds && (
        <p className="text-sm text-muted dark:text-slate-400 italic mt-6">
          Type a query above, or filter by tag, or pick a kind - results
          appear as you type.
        </p>
      )}

      {results.isLoading && (
        <div className="text-sm text-muted">Searching…</div>
      )}

      {results.isError && (
        <QueryError what="search results" onRetry={() => results.refetch()} />
      )}
      <SearchIncomplete failed={results.data?.kinds_failed} />
      {(q || tag || kinds) && !results.isLoading && !results.isError && grouped.length === 0 && exact.length === 0 && (
        <div className="text-sm text-muted italic">
          No results{q ? ` for "${q}"` : ""}
          {tag ? ` tagged #${tag}` : ""}. Try a different keyword, a different
          tag, or relax the kind filters.
        </div>
      )}

      {exact.length > 0 && (
        <section className="space-y-2" data-testid="search-exact">
          <h2 className="text-sm font-semibold text-content dark:text-slate-300 py-1 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-accent">Exact match</span>
          </h2>
          <ul className="border border-accent/50 rounded divide-y divide-line dark:divide-slate-800 bg-surface dark:bg-slate-900">
            {exact.map((c) => (
              <li key={`${c.entity_kind}:${c.entity_id}`} className="px-3 py-2 text-sm">
                <Link to={c.detail_path} className="flex items-baseline gap-3 hover:text-accent">
                  <span className="font-medium truncate">{c.label}</span>
                  <span className="text-xs text-muted truncate">{c.where}</span>
                </Link>
                <button type="button" className="text-xs text-accent py-1" onClick={() => void light(c.entity_kind, c.entity_id)}>Where is it?</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {grouped.map(([kind, items]) => (
        <section key={kind} className="space-y-2">
          <h2 className="text-sm font-semibold text-content dark:text-slate-300 sticky-under-header bg-subtle dark:bg-slate-950 py-1 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-faint">
              {labels.collection(kind)}
            </span>
            <span className="text-xs text-faint">{(() => { const t = totalOf(kind, items.length); return t !== undefined && t > items.length ? `${items.length} of ${t.toLocaleString()}` : items.length; })()}</span>
          </h2>
          <ul className="border border-line dark:border-slate-700 rounded divide-y divide-line dark:divide-slate-800 bg-surface dark:bg-slate-900">
            {items.map((h) => (
              <li key={`${h.kind}:${h.id}`} className="px-3 py-2 text-sm">
                <Link
                  to={routeFor(h.kind, h.id, h.detailUrl) ?? "#"}
                  className="flex items-center gap-3 hover:text-accent"
                >
                  <EntityThumb src={h.image_path} alt={h.title} size={36} />
                  <span className="min-w-0 flex-1 flex flex-col">
                    <span className="flex flex-wrap items-baseline gap-x-3 min-w-0">
                      <span className="font-medium [overflow-wrap:anywhere]">{h.title}</span>
                      {h.subtitle && (
                        <span className="text-xs text-muted truncate">
                          {h.subtitle}
                        </span>
                      )}
                    </span>
                    {h.snippet && (
                      <span className="text-xs text-muted dark:text-slate-400 line-clamp-2" data-testid="search-snippet">
                        <SnippetText text={h.snippet} q={q} />
                      </span>
                    )}
                    {/* Under the name, never beside it: a pill held to its width took a
                        phone's row and cut the thing searched for to "Passpor…" (#8632). */}
                    {locName(h) && (
                      <span className="self-start mt-0.5 text-[10px] uppercase tracking-wider text-accent border border-line dark:border-slate-600 rounded-full px-1.5 py-0.5 [overflow-wrap:anywhere]" data-testid="search-hit-place">
                        {locName(h)}
                      </span>
                    )}
                  </span>
                </Link>
                <button type="button" className="text-xs text-accent py-1" onClick={() => void light(h.kind, h.id)}>Where is it?</button>
              </li>
            ))}
          </ul>
          {hasMore(kind) && (
            <button
              type="button"
              onClick={() => void showMore(kind, items.length)}
              disabled={loadingKind === kind}
              className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline disabled:opacity-60"
            >
              {loadingKind === kind && <Loader2 size={12} className="animate-spin" />}
              Show more {labels.collection(kind)}
            </button>
          )}
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
        aria-label="Clear"
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
