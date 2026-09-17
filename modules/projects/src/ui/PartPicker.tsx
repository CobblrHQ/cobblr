// A design picks from the stash by searching it, not by scrolling a
// capped list. The materials and hooks pickers were plain <select>s over
// one page of 200 parts across every instance, so a household with a few
// hundred grocery rows never saw its yarn in the picker at all, and nothing
// said so (#3129). This asks the parts list for what the person typed
// (`search=`, the same trigram search the inventory page uses) and says
// plainly when a page is not the whole stash.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { InvPart, ProjectsApi } from "./api";

/** The query-key root every picker read shares, so a reserve invalidates
 *  what a picker shows (a part's free quantity changes). */
export const PART_PICKER_KEY = "inv-parts-pick";

const PAGE = 50;

export function PartPicker({
  api,
  value,
  onChange,
  placeholder,
  include,
  describe,
  emptyHint,
}: {
  api: Pick<ProjectsApi, "listInventoryParts">;
  /** The picked part, or null. The picker shows its name and an X. */
  value: InvPart | null;
  onChange: (part: InvPart | null) => void;
  placeholder: string;
  /** Which rows this picker is for (hooks, not yarn). Applied to what the
   *  search returned; the page note tells the person to keep typing when
   *  the page was not the whole stash. */
  include?: (part: InvPart) => boolean;
  /** Words after the name (free quantity, a gauge). */
  describe?: (part: InvPart) => string;
  /** What to say when a search finds nothing. */
  emptyHint?: string;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const page = useQuery({
    queryKey: [PART_PICKER_KEY, debounced],
    queryFn: () => api.listInventoryParts({ search: debounced, limit: PAGE }),
    enabled: open,
    retry: false,
    staleTime: 30_000,
  });
  const rows = (page.data?.items ?? []).filter((p) => (include ? include(p) : true));
  const more = !!page.data?.next_cursor;

  if (value) {
    return (
      <div className="input flex items-center gap-2 flex-1 min-w-0">
        <span className="flex-1 truncate text-sm text-content dark:text-mortar-100">
          {value.name}
          {describe ? <span className="text-faint dark:text-slate-500"> {describe(value)}</span> : null}
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-faint hover:text-ember-500 shrink-0"
          title="Pick a different one"
          aria-label="Pick a different one"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  const pick = (p: InvPart) => {
    onChange(p);
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={root} className="relative flex-1 min-w-0">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, Math.max(rows.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            const p = rows[active];
            if (open && p) {
              e.preventDefault();
              pick(p);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className="input text-sm w-full"
      />
      {open && (
        <ul role="listbox" className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg">
          {more && (
            // The page is not the whole stash: say so, at the top where it is
            // read before the list is scrolled, rather than letting an
            // absence read as "you do not have one".
            <li className="sticky-in-scroller px-3 py-1.5 text-[11px] text-faint dark:text-slate-500 bg-surface dark:bg-slate-900 border-b border-line dark:border-slate-700">
              {rows.length
                ? `The first ${page.data?.items.length ?? PAGE} of more; keep typing to narrow it`
                : debounced
                  ? `None in the first ${page.data?.items.length ?? PAGE} matches; keep typing to narrow it`
                  : `More than ${page.data?.items.length ?? PAGE} in the stash; type to search it`}
            </li>
          )}
          {page.isLoading && <li className="px-3 py-2 text-xs text-faint">searching…</li>}
          {page.isError && <li className="px-3 py-2 text-xs text-ember-500">Could not read the stash</li>}
          {!page.isLoading && !page.isError && rows.length === 0 && !more && (
            <li className="px-3 py-2 text-xs text-faint italic">{debounced ? (emptyHint ?? "No matches") : (emptyHint ?? "Nothing in the stash yet")}</li>
          )}
          {rows.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                  i === active ? "bg-subtle dark:bg-slate-800" : "hover:bg-subtle dark:hover:bg-slate-800"
                }`}
              >
                <span className="flex-1 truncate text-content dark:text-mortar-100">{p.name}</span>
                {describe ? <span className="text-xs text-faint shrink-0">{describe(p)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
