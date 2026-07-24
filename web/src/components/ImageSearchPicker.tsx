// ImageSearchPicker — THE "pick a photo from the web" surface for the whole
// app. One component, one behaviour, everywhere an entity needs an image: the
// scan inbox, a machine, a record on a shelf.
//
// What makes it the standard rather than three lookalikes:
//   1. ONE search phrase. Pass `entity` and the SERVER derives it exactly the
//      way the scan inbox does (name + brand + the thing's own fields: an
//      author + media word, a colour) — see deriveImageQuery. A book searches
//      "… Laura Ingalls Wilder book" on its record page, not a bare title that
//      returns farm scenery. Callers should not hand-build phrases.
//   2. The term is PRE-FILLED with what was actually searched, not left blank
//      behind a placeholder — a blank box hides the one piece of information
//      you need in order to improve the search (the author, 2026-07-18).
//   3. A FULL-SCREEN viewer, the same one the scan inbox has: the image big on
//      a dark backdrop with the options strip still under it, so you flip
//      between candidates at full size and pick without leaving.
//
// Modes (precedence): `items` (caller supplies a ranked list, e.g. the scan
// inbox's own pipeline) → `entity` (server-derived) → `query` (literal).

import { useEffect, useState, type FormEvent } from "react";
import { Maximize2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type ImageOption } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { nextTerm } from "./imageSearchTerm";
import { ImageLightbox } from "./ImageLightbox";

export function ImageSearchPicker({
  entity,
  query,
  brand,
  items: itemsProp,
  loading: loadingProp,
  onPick,
  onPreview,
  onSearch,
  busy,
  label,
  enabled = true,
  searchable = true,
}: {
  /** Derived mode (preferred): the server builds the phrase from this entity. */
  entity?: { kind: string; id: string } | null;
  /** Literal mode: search exactly this. */
  query?: string;
  brand?: string;
  /** Pre-fetched mode: render a caller-supplied ranked list. */
  items?: ImageOption[];
  loading?: boolean;
  /** Called with the chosen image's full-size url. The caller applies it. */
  onPick: (url: string) => void;
  /** When set, a tile click hands the url to the CALLER instead of opening this
   *  component's own full-screen viewer — for a caller that already has one
   *  open (the scan inbox renders this strip inside its lightbox, where a tile
   *  click swaps the enlarged image). Without it, tiles open the viewer here. */
  onPreview?: (url: string) => void;
  /** Pre-fetched mode only: the caller re-runs its own search for this term. */
  onSearch?: (term: string) => void;
  /** Disable tiles while the caller is saving the pick. */
  busy?: boolean;
  label?: string;
  enabled?: boolean;
  /** Show the editable search box (default true). */
  searchable?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const usesProp = itemsProp !== undefined;
  const [term, setTerm] = useState("");
  const [touched, setTouched] = useState(false);
  const [applied, setApplied] = useState("");
  const [viewIdx, setViewIdx] = useState<number | null>(null);

  const fetched = useQuery({
    queryKey: ["image-options", activeSlug, entity?.kind, entity?.id, query, brand, applied],
    queryFn: () => api.imageOptions(activeSlug, { q: applied || query, brand, entity }),
    // An entity needs no q at all (the server derives it); literal mode does.
    enabled: enabled && !usesProp && !!activeSlug && (!!entity || !!(applied || query || "").trim()),
    staleTime: 5 * 60_000,
  });
  const loading = usesProp ? !!loadingProp : fetched.isFetching;
  const source = itemsProp ?? fetched.data?.items ?? [];
  // What the server actually searched — shown IN the box, not as a placeholder.
  const searched = applied || (usesProp ? "" : (fetched.data?.query ?? query ?? ""));
  useEffect(() => {
    setTerm((t) => nextTerm({ searched, term: t, touched }));
  }, [searched, touched]);

  const [broken, setBroken] = useState<Set<string>>(new Set());
  const opts = source.filter((o) => !broken.has(o.url));

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = term.trim();
    setApplied(t);
    if (usesProp) onSearch?.(t); // the caller owns fetching in pre-fetched mode
  }

  function tileClick(o: ImageOption) {
    if (onPreview) onPreview(o.url);
    else setViewIdx(opts.indexOf(o));
  }

  return (
    <div className="space-y-1.5">
      {searchable && (
        <form onSubmit={submit} className="flex items-center gap-1.5">
          <input
            value={term}
            onChange={(e) => {
              setTouched(true);
              setTerm(e.target.value);
            }}
            placeholder="search images…"
            className="flex-1 min-w-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={busy}
            className="shrink-0 rounded border border-line dark:border-slate-600 px-2 py-1 text-[11px] font-medium text-muted hover:text-content hover:border-faint disabled:opacity-50"
          >
            Search
          </button>
          {touched && (
            <button
              type="button"
              onClick={() => {
                setTouched(false);
                setApplied("");
              }}
              className="shrink-0 text-[11px] text-faint hover:text-content"
              title="Back to the derived search"
            >
              reset
            </button>
          )}
        </form>
      )}
      {loading ? (
        <div className="text-[11px] text-faint animate-pulse">finding photo options…</div>
      ) : opts.length === 0 ? (
        <div className="text-[11px] text-faint italic">
          {searched ? `no images found for "${searched}"` : "no photo options"}
        </div>
      ) : (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
            {label ?? "photo options"}{" "}
            <span className="text-faint normal-case">
              · DuckDuckGo · tap to use, ⤢ to view full size
            </span>
          </div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
            {/* Two gestures for two intentions. The BIG target does the common
                thing — you are picking a photo, so tapping the photo picks it.
                Zooming is the rarer "let me check this one first", so it gets
                the small corner button (the author, 2026-07-20: "you should click image
                to select, and press small button to zoom it"). */}
            {opts.map((o) => (
              <div key={o.url} className="relative w-20 h-20 shrink-0 group">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(o.url)}
                  title={`Use this image — ${o.title} (${o.source})`}
                  aria-label={`Use this image: ${o.title}`}
                  className="w-full h-full rounded border border-line dark:border-slate-700 overflow-hidden bg-white hover:border-cobble-400 transition disabled:opacity-50"
                >
                  <img
                    src={o.thumb}
                    alt={o.title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                    onError={() => setBroken((s) => new Set(s).add(o.url))}
                  />
                </button>
                <button
                  type="button"
                  onClick={() => tileClick(o)}
                  title="View full size"
                  aria-label={`View full size: ${o.title}`}
                  // Always visible, not hover-only: on touch there is no hover,
                  // and a control you can't see is a control that doesn't exist.
                  // Not disabled by `busy` — looking is safe while a pick saves.
                  className="absolute bottom-1 right-1 rounded bg-black/60 hover:bg-black/80 text-white shadow-md w-6 h-6 flex items-center justify-center"
                >
                  <Maximize2 className="w-3 h-3" strokeWidth={2.5} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full-screen viewer — the shared app-wide ImageLightbox. Candidates are
          the filmstrip; "Use this image" is the primary action. */}
      {viewIdx !== null && opts[viewIdx] && (
        <ImageLightbox
          items={opts.map((o) => ({
            key: o.url,
            url: o.url,
            thumbUrl: o.thumb,
            caption: `${o.title} · ${o.source}`,
            href: o.source,
          }))}
          index={viewIdx}
          onIndex={setViewIdx}
          onClose={() => setViewIdx(null)}
          action={{
            label: "Use this image",
            busy,
            onAction: (it) => {
              if (it.url) onPick(it.url);
              setViewIdx(null);
            },
          }}
          onItemError={(it) => {
            // Full-size dead but the thumb loaded — drop it and close rather than
            // leaving a broken image filling the screen.
            const u = it.url;
            if (u) setBroken((s) => new Set(s).add(u));
            setViewIdx(null);
          }}
        />
      )}
    </div>
  );
}
