// Global cross-module search bar. Renders in the header chrome;
// typing in it hits core-search.search() which fans the query out
// across every kind that registered a list resolver. Results
// dropdown shows live as you type; pressing Enter navigates to the
// /search results page.

import { useEffect, useRef, useState } from "react";
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
  const ref = useRef<HTMLDivElement>(null);

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

  // Close dropdown on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const items = hits.data?.items ?? [];

  return (
    <div ref={ref} className="relative shrink-0 hidden md:block">
      <div className="flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 focus-within:border-cobble-500">
        <Search size={12} className="text-slate-400" />
        <input
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
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Search…"
          className="bg-transparent text-sm placeholder-slate-400 w-40 focus:w-56 transition-[width] outline-none"
        />
      </div>
      {open && items.length > 0 && (
        <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded shadow-lg z-50 divide-y divide-slate-100 dark:divide-slate-800">
          {items.slice(0, 20).map((h) => (
            <button
              key={`${h.kind}:${h.id}`}
              onClick={() => {
                navigate(detailRoute(h.kind, h.id));
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-sm"
            >
              <div className="font-medium truncate">{h.title}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
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
              className="w-full px-3 py-2 text-xs text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800/60 text-center"
            >
              See all results for "{q.trim()}" →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Map a kind to its detail-page URL. Falls back to /search?kind=... if
 *  no known route. Matches the routes registered in App.tsx. */
function detailRoute(kind: string, id: string): string {
  const [moduleName, type] = kind.split(":");
  if (moduleName === "inventory" && type === "part") return `/inventory/parts/${id}`;
  if (moduleName === "machines" && type === "machine") return `/machines/${id}`;
  if (moduleName === "assets" && type === "asset") return `/assets/${id}`;
  if (moduleName === "projects" && type === "project") return `/projects/${id}`;
  if (moduleName === "projects" && type === "task") return `/projects/tasks/${id}`;
  if (moduleName === "purchases" && type === "order") return `/purchases/${id}`;
  return `/search?q=${encodeURIComponent(`${kind}:${id}`)}`;
}
