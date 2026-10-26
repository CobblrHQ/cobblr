// Global cross-module search bar. Renders in the header chrome;
// typing in it hits core-search.search() which fans the query out
// across every kind that registered a list resolver. Results
// dropdown shows live as you type; pressing Enter navigates to the
// /search results page.

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchInput } from "@cobblr/platform-web";
import { useKindLabels } from "../lib/useKindLabels";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "../lib/api";
import { searchFeatures } from "../lib/feature-index";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { recordHref } from "@cobblr/platform-contract/instance-detail";
import { SearchIncomplete } from "./SearchIncomplete";
import { SnippetText } from "@cobblr/platform-web";
import { useExactHits } from "../lib/useExactHits";

export function SearchBar() {
  const { activeSlug } = useActiveOrg();
  const labels = useKindLabels(activeSlug);
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  // Collapsed by default — the bar is a magnifying-glass icon that
  // expands to the input on click, freeing up navbar width.
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce so we don't fire on every keystroke.
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const featureHits = useMemo(() => searchFeatures(q, 3), [q]);
  const hits = useQuery({
    queryKey: ["search", activeSlug, debounced],
    queryFn: () => api.search(activeSlug, debounced),
    enabled: !!activeSlug && debounced.length > 1,
    staleTime: 30_000,
  });

  // Pull the entity-kinds registry once — drives detailRoute lookup so
  // we don't need an if-chain hardcoding routes per module. Stale-for-
  // a-while because the registry changes only on module install/disable.
  const kinds = useQuery({
    queryKey: ["entity-kinds", activeSlug],
    queryFn: () => api.listEntityKinds(activeSlug),
    enabled: !!activeSlug,
    staleTime: 5 * 60_000,
  });
  const routeByKind = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const k of kinds.data?.items ?? []) m.set(k.id, k.detail_route);
    return m;
  }, [kinds.data]);

  function detailRoute(kind: string, id: string, detailUrl?: string | null): string {
    return recordHref({ kind, id, detailUrl }, routeByKind.get(kind)) ?? `/search?q=${encodeURIComponent(`${kind}:${id}`)}`;
  }

  // Close dropdown on outside click; collapse the (empty) field back to
  // an icon so it stops taking navbar space.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        if (q.trim().length === 0) setExpanded(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [q]);

  // Focus the field the moment it expands.
  useEffect(() => {
    if (expanded) inputRef.current?.focus();
  }, [expanded]);

  const items = hits.data?.items ?? [];
  // An exact identifier (a serial, a code) is asked of the same registry the
  // scanner and the palette use, and leads the list.
  const exact = useExactHits(activeSlug, debounced, "search", expanded);

  // One list the arrows walk: exact hits, the app's own features, the
  // records, then "see all". Enter opens the highlighted one; with none
  // highlighted it opens the full results page, as it always did.
  type Entry = { key: string; go: () => void; node: React.ReactNode };
  const entries: Entry[] = [
    ...exact.map((c) => ({
      key: `exact-${c.entity_kind}-${c.entity_id}`,
      go: () => navigate(c.detail_path),
      node: (
        <>
          <div className="font-medium truncate">{c.label}</div>
          <div className="text-xs text-accent truncate">Exact match · {c.where}</div>
        </>
      ),
    })),
    ...featureHits.map((f) => ({
      key: `feat-${f.route}-${f.label}`,
      go: () => navigate(f.route),
      node: (
        <>
          <div className="font-medium truncate text-accent">{f.label}</div>
          <div className="text-xs text-muted dark:text-slate-400 truncate">{f.hint}</div>
        </>
      ),
    })),
    ...items
      .filter((h) => !exact.some((c) => c.entity_kind === h.kind && c.entity_id === h.id))
      .slice(0, 20)
      .map((h) => ({
        key: `${h.kind}:${h.id}`,
        // Prefer the resolver-owned per-item detailUrl (carries instance
        // context, e.g. /instances/designs/<id>); the kind→route registry map
        // is the fallback for hits without one.
        go: () => navigate(detailRoute(h.kind, h.id, h.detailUrl)),
        node: (
          <>
            <div className="font-medium truncate">
              {h.title}
              {/* A retired record is still found (an old drill is exactly
                  what a person searches for) and says so, ranked after the
                  live ones by the search itself. */}
              {h.retired && (
                <span className="ml-2 align-middle text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">archived</span>
              )}
            </div>
            <div className="text-xs text-muted dark:text-slate-400 truncate">
              {labels.collection(h.kind)}
              {h.subtitle ? ` · ${h.subtitle}` : ""}
            </div>
            {h.snippet && (
              <div className="text-xs text-muted dark:text-slate-400 truncate">
                <SnippetText text={h.snippet} q={q} />
              </div>
            )}
          </>
        ),
      })),
    ...(q.trim().length > 0
      ? [
          {
            key: "see-all",
            go: () => navigate(`/search?q=${encodeURIComponent(q.trim())}`),
            node: <div className="text-xs text-muted text-center">See all results for &ldquo;{q.trim()}&rdquo; →</div>,
          },
        ]
      : []),
  ];
  const [sel, setSel] = useState(-1);
  useEffect(() => setSel(-1), [debounced]);
  useEffect(() => {
    if (sel >= 0) document.getElementById(`searchbar-option-${sel}`)?.scrollIntoView?.({ block: "nearest" });
  }, [sel]);
  const showList = open && expanded && (entries.length > (q.trim() ? 1 : 0) || (hits.data?.kinds_failed?.length ?? 0) > 0);

  return (
    <div ref={ref} className="relative shrink-0 hidden md:block">
      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          title="Search"
          aria-label="Search"
          className="text-faint dark:text-slate-500 hover:text-accent transition p-[6px]"
        >
          <Search size={15} />
        </button>
      ) : (
        <SearchInput
            ref={inputRef}
            size="sm"
            wrapperClassName="w-60"
            aria-label="Search"
            role="combobox"
            aria-expanded={showList}
            aria-controls="searchbar-results"
            aria-autocomplete="list"
            aria-activedescendant={sel >= 0 ? `searchbar-option-${sel}` : undefined}
            value={q}
            onChange={(v) => {
              setQ(v);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && entries.length) {
                e.preventDefault();
                setOpen(true);
                setSel((s) => Math.min(s + 1, entries.length - 1));
              }
              if (e.key === "ArrowUp" && entries.length) {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, -1));
              }
              if (e.key === "Enter") {
                const chosen = sel >= 0 ? entries[sel] : undefined;
                if (chosen) chosen.go();
                else if (q.trim().length > 0) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
                else return;
                setOpen(false);
              }
              if (e.key === "Escape") {
                setOpen(false);
                if (q.trim().length === 0) setExpanded(false);
              }
            }}
            placeholder="Search…"
          />
      )}
      {showList && (
        <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto bg-surface dark:bg-slate-900 border border-line dark:border-slate-700 rounded shadow-lg z-50">
          {(hits.data?.kinds_failed?.length ?? 0) > 0 && (
            <div className="p-1.5 border-b border-line dark:border-slate-800"><SearchIncomplete compact failed={hits.data?.kinds_failed} /></div>
          )}
          <ul role="listbox" id="searchbar-results" aria-label="Search results" className="divide-y divide-line dark:divide-slate-800">
            {entries.map((en, i) => (
              <li
                key={en.key}
                id={`searchbar-option-${i}`}
                role="option"
                aria-selected={sel === i}
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  en.go();
                  setOpen(false);
                }}
                className={"cursor-pointer px-3 py-2 text-sm " + (sel === i ? "bg-subtle dark:bg-slate-800/60" : "hover:bg-subtle dark:hover:bg-slate-800/60")}
              >
                {en.node}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

