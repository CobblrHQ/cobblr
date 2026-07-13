// Cross-catalog quick-pick. Type a query, see grouped results from
// every installed catalog, click one to bind it to the entity being
// created/edited.
//
// Host-agnostic: takes a `search` callback so platform-web stays free
// of network code. The host wires its own InventoryApi / generic
// fetch / whatever in.

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

export interface CatalogTypeaheadHit {
  id: string;
  catalog_id: string;
  catalog_name: string;
  external_id: string;
  payload: Record<string, unknown>;
  title: string;
  title_column: string;
  /** `{ catalogPayloadKey: instanceFieldName }` from the catalog schema —
   *  picking this hit prefills those instance fields from the payload. */
  field_map?: Record<string, string>;
}

interface Props {
  /** The currently bound hit, if any. When set, the typeahead renders
   *  a "matched chip" instead of the input so the user can see what
   *  they picked + clear it. */
  selected: CatalogTypeaheadHit | null;
  onSelect: (hit: CatalogTypeaheadHit | null) => void;
  /** Returns ranked search hits across every catalog. Debounced
   *  upstream by the typeahead; the host just provides the call. */
  search: (q: string) => Promise<{ items: CatalogTypeaheadHit[] }>;
  /** Field name to read an image url out of each hit's payload. Each
   *  catalog can name this column differently — the search response
   *  includes `payload`, but doesn't know which key is the image. For
   *  v0.2 we eyeball common keys (img_url, image_url, image). */
  imageKeys?: string[];
  placeholder?: string;
  /** Render the matched chip's secondary line. Default: catalog name. */
  subtitleFor?: (hit: CatalogTypeaheadHit) => string;
}

const DEFAULT_IMAGE_KEYS = ["img_url", "image_url", "image", "thumbnail"];

function pickImage(hit: CatalogTypeaheadHit, keys: string[]): string | null {
  for (const k of keys) {
    const v = hit.payload[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function CatalogTypeahead({
  selected,
  onSelect,
  search,
  imageKeys = DEFAULT_IMAGE_KEYS,
  placeholder = "Match to a catalog…",
  subtitleFor,
}: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<CatalogTypeaheadHit[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 200ms debounce — keeps the network quiet while the user types.
  // We deliberately don't cache: catalog data changes rarely, but
  // re-running on every reopen is cheap.
  useEffect(() => {
    if (selected) return;
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await search(q.trim());
        if (!cancelled) setHits(res.items);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, selected, search]);

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (selected) {
    const image = pickImage(selected, imageKeys);
    return (
      <div className="flex items-center gap-2 rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/30 px-2 py-1.5">
        {image && (
          <img
            src={image}
            alt={selected.title}
            className="w-9 h-9 rounded object-cover border border-line dark:border-slate-700"
            loading="lazy"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">
            {selected.title}
          </div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-accent dark:text-cobble-300 truncate">
            {subtitleFor
              ? subtitleFor(selected)
              : `${selected.catalog_name} · #${selected.external_id}`}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="text-faint hover:text-ember-500 transition p-1"
          aria-label="Clear match"
          title="Clear match"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-2 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2">
        <Search size={14} className="text-faint shrink-0" />
        <input
          type="text"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm py-1.5 focus:outline-none text-content dark:text-mortar-100 placeholder:text-faint"
        />
        {loading && (
          <span className="text-[10px] font-mono text-faint">…</span>
        )}
      </div>
      {open && q.trim().length >= 2 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg max-h-80 overflow-y-auto">
          {hits.length === 0 && !loading && (
            <div className="text-xs text-faint italic px-3 py-2">
              No matches in any installed catalog.
            </div>
          )}
          {groupByCatalog(hits).map(([catalogName, group]) => (
            <div key={catalogName}>
              <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 px-3 pt-2 pb-1 sticky top-0 bg-surface dark:bg-slate-900">
                {catalogName}
              </div>
              {group.map((h) => {
                const image = pickImage(h, imageKeys);
                return (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => {
                      onSelect(h);
                      setOpen(false);
                      setQ("");
                    }}
                    className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-subtle dark:hover:bg-slate-800/60 transition"
                  >
                    {image ? (
                      <img
                        src={image}
                        alt={h.title}
                        className="w-8 h-8 rounded object-cover border border-line dark:border-slate-700 shrink-0"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-8 h-8 shrink-0 rounded border border-dashed border-line dark:border-slate-700" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-content dark:text-mortar-100 truncate">
                        {h.title}
                      </div>
                      <div className="text-[10px] font-mono text-faint truncate">
                        #{h.external_id}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupByCatalog(
  hits: CatalogTypeaheadHit[],
): Array<[string, CatalogTypeaheadHit[]]> {
  const order: string[] = [];
  const groups = new Map<string, CatalogTypeaheadHit[]>();
  for (const h of hits) {
    if (!groups.has(h.catalog_name)) {
      order.push(h.catalog_name);
      groups.set(h.catalog_name, []);
    }
    groups.get(h.catalog_name)!.push(h);
  }
  return order.map((k) => [k, groups.get(k)!]);
}
