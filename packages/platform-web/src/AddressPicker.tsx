// The address picker, and how an address reads on a record (#5317).
//
// Smart in this order, heuristic first:
//   1. The addresses this workspace already used, matched as you type, name
//      and street both ("mvc" finds MVC Lodi Agency), each with the record it
//      was last used on. Free, private, instant, and most addresses repeat.
//   2. The parts form (name, street, city, state, postal code, country), whose
//      boxes carry the browser's address autofill, for a person's own places.
//   3. A map lookup's places, only when the api has one (`lookup` not null).
//      None ships: with none, nothing here mentions a map search.
//   4. Free text always saves: whatever is typed is the address when nothing
//      matches. A slow or failed lookup never holds that up.
//
// Called an address on screen, never a location: a Location is where a thing
// is kept.

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import {
  addressKey,
  addressText,
  asAddress,
  directionsUrl,
  isAppleDevice,
  joinAddressLine,
  type AddressPart,
  type AddressValue,
} from "@cobblr/platform-contract/address";
import { usePlatformWeb } from "./context";

/** Directions open in the device's own maps app where there is one. */
function useDirections(value: unknown): string | null {
  return useMemo(() => {
    const apple = typeof navigator !== "undefined" && isAppleDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0);
    return directionsUrl(value, { apple });
  }, [value]);
}

/** An address as a record shows it: what the place is called, the street
 *  address under it, and a Directions link. `inline` is a compact row that
 *  wraps Directions within a table cell or calendar row. */
export function AddressView({ value, inline }: { value: unknown; inline?: boolean }) {
  const a = asAddress(value);
  const href = useDirections(a);
  if (!a) return <span className="text-faint dark:text-slate-600">—</span>;
  const directions = href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline" data-testid="address-directions" onClick={(e) => e.stopPropagation()}>
      Directions
    </a>
  ) : null;
  if (inline) {
    return (
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-2" data-testid="address-view">
        <span className="min-w-0 truncate" title={addressText(a)}>{addressText(a)}</span>
        {directions}
      </span>
    );
  }
  return (
    <span className="block min-w-0" data-testid="address-view">
      {a.name && <span className="block font-medium text-content dark:text-mortar-100" data-testid="address-name">{a.name}</span>}
      {a.line && <span className={"block " + (a.name ? "text-sm text-muted dark:text-slate-400" : "")} data-testid="address-line">{a.line}</span>}
      {directions && <span className="block text-sm">{directions}</span>}
    </span>
  );
}

const PART_BOXES: Array<{ part: "name" | AddressPart; label: string; autoComplete: string }> = [
  { part: "name", label: "Name of the place", autoComplete: "organization" },
  { part: "street", label: "Street", autoComplete: "address-line1" },
  { part: "city", label: "City", autoComplete: "address-level2" },
  { part: "region", label: "State or region", autoComplete: "address-level1" },
  { part: "postal", label: "Postal code", autoComplete: "postal-code" },
  { part: "country", label: "Country", autoComplete: "country-name" },
];

type Parts = Partial<Record<"name" | AddressPart, string>>;

function partsOf(a: AddressValue | null, typed: string): Parts {
  if (!a) return typed.trim() ? { street: typed.trim() } : {};
  const has = a.street || a.city || a.region || a.postal || a.country;
  return { name: a.name, street: has ? a.street : a.line, city: a.city, region: a.region, postal: a.postal, country: a.country };
}

function useDebounced<T>(value: T, ms: number): T {
  // DRAFT-OK: not a record's value but the typed query, moved by the effect below.
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface AddressPickerProps {
  label: string;
  value: unknown;
  /** The address chosen, or null when it is cleared. */
  onCommit: (v: AddressValue | null) => void;
  required?: boolean;
  /** Open straight into editing (a form that is filling it in). */
  startEditing?: boolean;
}

export function AddressPicker({ label, value, onCommit, required, startEditing }: AddressPickerProps) {
  const { api, orgSlug } = usePlatformWeb();
  const current = asAddress(value);
  // Editing is asked for; with no address there is nothing else to show. Read
  // from the value on every render, so a panel that remounts the field before
  // a save comes back still shows the address once it does.
  const [editing, setEditing] = useState(!!startEditing);
  const [query, setQuery] = useState("");
  const [parts, setParts] = useState<Parts | null>(null);
  const [active, setActive] = useState(-1);
  const id = useId();
  const q = useDebounced(query.trim(), 200);

  const suggestions = useQuery({
    queryKey: ["addresses", orgSlug, q],
    queryFn: () => api.addresses!(orgSlug, q),
    enabled: (editing || !current) && !!api.addresses,
    staleTime: 30_000,
  });
  const used = suggestions.data?.used ?? [];
  const found = (suggestions.data?.found ?? []).filter((f) => !used.some((u) => addressKey(u.address) === addressKey(f)));
  const lookup = suggestions.data?.lookup ?? null;
  const rows: Array<{ address: AddressValue; note: string | null }> = [
    ...used.map((u) => ({ address: u.address, note: u.usedOn.name ? `Used on ${u.usedOn.name}` : null })),
    ...found.map((f) => ({ address: f, note: null })),
  ];
  const typed = query.trim();

  function pick(a: AddressValue | null) {
    onCommit(a);
    setQuery("");
    setParts(null);
    setActive(-1);
    setEditing(false);
  }
  const keepTyped = () => typed && pick({ line: typed, source: "typed" });

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && rows[active]) pick(rows[active]!.address);
      else keepTyped();
    } else if (e.key === "Escape" && current) {
      setEditing(false);
      setQuery("");
    }
  }

  const heading = (
    <span id={`${id}-label`} className="block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
      {label}
      {required ? <span className="text-ember-500"> *</span> : null}
    </span>
  );

  if (!editing && current) {
    return (
      <div data-testid="address-field">
        {heading}
        <div className="flex items-start gap-2">
          <MapPin size={16} className="mt-0.5 shrink-0 text-faint" aria-hidden />
          <div className="min-w-0 flex-1"><AddressView value={current} /></div>
          <button type="button" className="text-sm text-accent" onClick={() => setEditing(true)} data-testid="address-change">
            Change
          </button>
        </div>
      </div>
    );
  }

  if (parts) {
    const line = joinAddressLine(parts);
    const save = () => {
      const a = asAddress({ ...parts, source: "typed" });
      if (a) pick(a);
    };
    return (
      <div data-testid="address-field" role="group" aria-labelledby={`${id}-label`}>
        {heading}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="address-parts">
          {PART_BOXES.map((b) => (
            <label key={b.part} className={"block " + (b.part === "name" || b.part === "street" ? "sm:col-span-2" : "")}>
              <span className="block text-xs text-muted dark:text-slate-400 mb-0.5">{b.label}</span>
              <input
                className="input w-full"
                name={b.part}
                autoComplete={b.autoComplete}
                value={parts[b.part] ?? ""}
                onChange={(e) => setParts({ ...parts, [b.part]: e.target.value })}
                data-part={b.part}
              />
            </label>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn" disabled={!line && !parts.name?.trim()} onClick={save} data-testid="address-save">
            Save address
          </button>
          <button type="button" className="btn" onClick={() => setParts(null)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="address-field">
      {heading}
      <input
        className="input w-full"
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls={`${id}-list`}
        aria-labelledby={`${id}-label`}
        aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
        autoComplete="street-address"
        placeholder="Type an address, or the name of a place used before"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
        }}
        onKeyDown={onKey}
        autoFocus={!!current}
        data-testid="address-search"
      />
      <ul id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} className="mt-1 overflow-hidden rounded-md border border-line dark:border-slate-700 empty:hidden">
        {rows.map((r, i) => (
          <li
            key={addressKey(r.address) + i}
            id={`${id}-opt-${i}`}
            role="option"
            aria-selected={i === active}
            className={"cursor-pointer px-3 py-2 text-sm " + (i === active ? "bg-subtle dark:bg-slate-800" : "hover:bg-subtle dark:hover:bg-slate-800") + (i > 0 ? " border-t border-line dark:border-slate-700" : "")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(r.address)}
            data-testid="address-option"
          >
            {r.address.name && <span className="block font-medium">{r.address.name}</span>}
            <span className={"block " + (r.address.name ? "text-muted dark:text-slate-400" : "")}>{r.address.line}</span>
            {r.note && <span className="block text-[11px] text-faint">{r.note}</span>}
            {i === used.length && lookup && <span className="block text-[11px] text-faint">From {lookup.name}</span>}
          </li>
        ))}
      </ul>
      {suggestions.data?.lookup_failed && <p className="mt-1 text-[11px] text-faint">The map search did not answer. What you type still saves.</p>}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {typed && (
          <button type="button" className="text-accent" onClick={keepTyped} data-testid="address-use-typed">
            Use “{typed.length > 40 ? typed.slice(0, 40) + "…" : typed}”
          </button>
        )}
        <button type="button" className="text-accent" onClick={() => setParts(partsOf(current, typed))} data-testid="address-enter-parts">
          Enter street, city and postal code
        </button>
        {current && (
          <button type="button" className="text-muted" onClick={() => { setEditing(false); setQuery(""); }}>
            Cancel
          </button>
        )}
        {current && !required && (
          <button type="button" className="text-muted" onClick={() => pick(null)} data-testid="address-clear">
            Remove address
          </button>
        )}
      </div>
    </div>
  );
}
