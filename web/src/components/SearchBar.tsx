// Global cross-module search bar. Renders in the header chrome;
// typing in it hits core-search.search() which fans the query out
// across every kind that registered a list resolver. Results
// dropdown shows live as you type; pressing Enter navigates to the
// /search results page.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function SearchBar() {
  const { activeSlug } = useActiveOrg();
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

  function detailRoute(kind: string, id: string): string {
    const tmpl = routeByKind.get(kind);
    if (tmpl) return tmpl.replace("{id}", id);
    return `/search?q=${encodeURIComponent(`${kind}:${id}`)}`;
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

  return (
    <div ref={ref} className="relative shrink-0 hidden md:block">
      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          title="Search"
          className="text-faint dark:text-slate-500 hover:text-accent transition p-1.5"
        >
          <Search size={15} />
        </button>
      ) : (
        <div className="flex items-center gap-1 px-2 py-1 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 focus-within:border-cobble-500">
          <Search size={12} className="text-faint" />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && q.trim().length > 0) {
                navigate(`/search?q=${encodeURIComponent(q.trim())}`);
                setOpen(false);
              }
              if (e.key === "Escape") {
                setOpen(false);
                if (q.trim().length === 0) setExpanded(false);
              }
            }}
            placeholder="Search…"
            className="bg-transparent text-sm placeholder-slate-400 w-52 outline-none"
          />
        </div>
      )}
      {open && expanded && items.length > 0 && (
        <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto bg-surface dark:bg-slate-900 border border-line dark:border-slate-700 rounded shadow-lg z-50 divide-y divide-line dark:divide-slate-800">
          {items.slice(0, 20).map((h) => (
            <button
              key={`${h.kind}:${h.id}`}
              onClick={() => {
                navigate(detailRoute(h.kind, h.id));
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-subtle dark:hover:bg-slate-800/60 text-sm"
            >
              <div className="font-medium truncate">{h.title}</div>
              <div className="text-xs text-muted dark:text-slate-400 truncate">
                {h.kind}
                {h.subtitle ? ` · ${h.subtitle}` : ""}
              </div>
            </button>
          ))}
          {q.trim().length > 0 && (
            <button
              onClick={() => {
                navigate(`/search?q=${encodeURIComponent(q.trim())}`);
                setOpen(false);
              }}
              className="w-full px-3 py-2 text-xs text-muted hover:bg-subtle dark:hover:bg-slate-800/60 text-center"
            >
              See all results for "{q.trim()}" →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

