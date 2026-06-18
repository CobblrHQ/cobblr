import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Optional secondary text shown dimmed after the label (e.g. a connection name). */
  hint?: string;
}

/**
 * A searchable single-select. Shows option **labels**, stores option **values**
 * (ids) — so it drops in for an id-keyed `<select>`. The dropdown is only
 * rendered while open (lazy — the fix for F-9's 50×50 option blowup) and is
 * absolutely positioned under the input, so it survives inside a `transform`/
 * `backdrop-blur` modal that would trap a `position: fixed` portal.
 *
 * Keyboard: type to filter, ↑/↓ to move, Enter to pick, Esc to close.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Search…",
  emptyLabel = "No matches",
  disabled,
  allowClear,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  /** Show an × to reset to "" (an unselected state). */
  allowClear?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q));
  }, [options, query]);

  // Close on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Keep the active row in range as the filter narrows.
  useEffect(() => { setActive(0); }, [query]);

  const pick = (opt: ComboboxOption) => {
    onChange(opt.value);
    setQuery("");
    setOpen(false);
  };

  const base =
    "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 disabled:opacity-50";

  return (
    <div ref={wrapRef} className={"relative " + (className ?? "")}>
      <div className="relative">
        <input
          type="text"
          className={base + " pr-12"}
          disabled={disabled}
          placeholder={selected ? selected.label : placeholder}
          value={open ? query : (selected?.label ?? "")}
          onFocus={() => !disabled && setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") { if (open && filtered[active]) { e.preventDefault(); pick(filtered[active]!); } }
            else if (e.key === "Escape") { setOpen(false); setQuery(""); }
          }}
        />
        <div className="absolute inset-y-0 right-1.5 flex items-center gap-0.5 text-faint">
          {allowClear && selected && !disabled && (
            <button
              type="button"
              onClick={() => { onChange(""); setQuery(""); }}
              className="hover:text-ember-500 p-0.5"
              title="Clear"
              tabIndex={-1}
            >
              <X size={13} />
            </button>
          )}
          <ChevronsUpDown size={13} className="pointer-events-none" />
        </div>
      </div>
      {open && !disabled && (
        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 shadow-lg py-1 text-sm">
          {filtered.length === 0 && <li className="px-2 py-1.5 text-faint italic">{emptyLabel}</li>}
          {filtered.map((o, i) => (
            <li key={o.value}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={
                  "w-full flex items-center gap-2 px-2 py-1.5 text-left " +
                  (i === active ? "bg-subtle dark:bg-slate-800 " : "") +
                  "text-content dark:text-mortar-100"
                }
              >
                <Check size={13} className={"shrink-0 " + (o.value === value ? "text-accent" : "opacity-0")} />
                <span className="truncate">{o.label}</span>
                {o.hint && <span className="text-[11px] text-faint truncate ml-auto">{o.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
