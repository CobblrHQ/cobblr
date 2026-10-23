// LocationTreePicker — a hierarchical, DRILL-DOWN location picker. Rooms "open
// into" their contents (breadcrumb navigation) instead of the flat, infinitely-
// tall indented <select> that LocationPicker renders. Same props, so it's a
// drop-in. Portals to body (a header's backdrop-blur traps position:fixed, so
// the panel must escape it — see the modal-portal convention).
//
// Interaction: a row's NAME picks that location; the ▸ on the right OPENS it to
// reveal its children. A leaf (no children) just picks. Search flattens to
// matches with their path. Every place is pickable: no prop narrows it to one
// kind (#6438; lint:capabilities, location:one-picker).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Backpack, Check, ChevronDown, ChevronRight, MapPin, Plus, X } from "lucide-react";
import { api, type Location, type PlaceHolder } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { QuickCreateLocation } from "./QuickCreateLocation";
import { ActionDescription, firstActionSentence, OverlayLayer, PopoverLayer, SearchInput, useEscapeToClose, useToast } from "@cobblr/platform-web";

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
  /** Exclude one id (e.g. don't offer yourself as a parent). */
  excludeId?: string;
  /** Exclude this location AND everything under it. For choosing a PARENT,
   *  where a node may not become its own ancestor. */
  excludeSubtreeOf?: string;
  label?: string;
  placeholder?: string;
  triggerLabel?: string;
  description?: string;
  /** What the "no place" row says. A parent picker says "(top-level)". */
  noneLabel?: string;
  className?: string;
  size?: "sm" | "md";
  /** The record whose place this is. Given, the picker also offers the things
   *  that hold things (a Backpack, a toolbox) and moves the record into one
   *  through placement; the trigger then reads "Backpack, in Desk drawer". */
  thing?: { kind: string; id: string };
  /** After the record moved into, or out of, something that holds things. */
  onPlaced?: () => void;
  /** A destination picker (Move everything): offer the things that hold
   *  things too, and hand the chosen one back instead of moving anything. */
  onPickHolder?: (holder: PlaceHolder) => void;
  /** The holder chosen through onPickHolder, shown as the selection. */
  pickedHolder?: Pick<PlaceHolder, "kind" | "id" | "title" | "line"> | null;
}

// siblings: manual drag order (position), then NATURAL name (Bin 2 before Bin 10).
const cmp = (a: Location, b: Location) =>
  a.position - b.position || a.name.localeCompare(b.name, undefined, { numeric: true });

export function LocationTreePicker({
  value,
  onChange,
  excludeId,
  excludeSubtreeOf,
  label,
  placeholder = "Select a location…",
  triggerLabel,
  description,
  noneLabel = "(no location)",
  className,
  size = "md",
  thing,
  onPlaced,
  onPickHolder,
  pickedHolder,
}: Props) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null); // the room we've drilled into (null = top)
  const [q, setQ] = useState("");
  const trigRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const list = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
  });

  // Holders are offered for a record's own place, or a destination that takes one.
  const offersHolders = !!thing || !!onPickHolder;
  const holders = useQuery({
    queryKey: ["core-placement-holders", activeSlug],
    queryFn: () => api.placementHolders(activeSlug),
    enabled: !!activeSlug && offersHolders,
  });
  const where = useQuery({
    queryKey: ["core-placement-path", activeSlug, thing?.kind, thing?.id],
    queryFn: () => api.placementPath(activeSlug, thing!.kind, thing!.id),
    enabled: !!activeSlug && !!thing,
  });
  const inside = where.data?.inside ?? null;
  const holderRows: PlaceHolder[] = offersHolders
    ? (holders.data?.items ?? []).filter((h) => !(thing && h.kind === thing.kind && h.id === thing.id))
    : [];
  const chosen = inside ?? (pickedHolder ? { kind: pickedHolder.kind, id: pickedHolder.id } : null);
  const afterMove = () => {
    void qc.invalidateQueries({ queryKey: ["core-placement-path", activeSlug] });
    void qc.invalidateQueries({ queryKey: ["core-placement-holders", activeSlug] });
    onPlaced?.();
  };
  const pickHolder = async (h: PlaceHolder) => {
    setOpen(false);
    setQ("");
    if (onPickHolder) {
      onPickHolder(h);
      return;
    }
    try {
      await api.placementPlace(activeSlug, { containee: thing!, container: { kind: h.kind, id: h.id } });
      afterMove();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const all = useMemo(() => {
    const rows = (list.data?.items ?? []).filter((i) => i.id !== excludeId);
    if (!excludeSubtreeOf) return rows;
    // Choosing a PARENT: a location cannot be its own ancestor, so the node and
    // everything beneath it are out. Computed here, where the hierarchy already
    // is, rather than by every caller that needs it — the one caller that did
    // hand-rolled this closure next to a raw <select>.
    const banned = new Set<string>([excludeSubtreeOf]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of rows) {
        if (r.parent_id && banned.has(r.parent_id) && !banned.has(r.id)) {
          banned.add(r.id);
          grew = true;
        }
      }
    }
    return rows.filter((r) => !banned.has(r.id));
  }, [list.data, excludeId, excludeSubtreeOf]);
  const byId = useMemo(() => new Map(all.map((l) => [l.id, l] as const)), [all]);
  const parentOf = (l: Location): string | null => (l.parent_id && byId.has(l.parent_id) ? l.parent_id : null);
  const childrenOf = (pid: string | null) => all.filter((l) => parentOf(l) === pid).sort(cmp);
  const hasKids = (id: string) => all.some((l) => parentOf(l) === id);
  const nameOf = (l: Location) => l.short_name?.trim() || l.name;
  const pathOf = (id: string): Location[] => {
    const out: Location[] = [];
    let cur: string | null = id;
    let guard = 0;
    while (cur && byId.has(cur) && guard++ < 60) {
      const n = byId.get(cur)!;
      out.unshift(n);
      cur = parentOf(n);
    }
    return out;
  };
  const selected = value ? byId.get(value) ?? null : null;

  const reposition = () => {
    const r = trigRef.current?.getBoundingClientRect();
    if (r) setRect(r);
  };
  const openPanel = () => {
    reposition();
    setCursor(selected ? parentOf(selected) : null); // start at the selection's level
    setQ("");
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (open) reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onMove = () => reposition();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);
  useEscapeToClose(open, panelRef, () => setOpen(false));

  const pick = async (id: string | null) => {
    setOpen(false);
    setQ("");
    // Inside a Backpack, the record has no place of its own to set: taking it
    // out, or putting it on a shelf, is a move out of the Backpack first.
    if (inside && thing) {
      try {
        await api.placementRemove(activeSlug, thing);
      } catch (e) {
        toast.error((e as Error).message);
        return;
      }
      afterMove();
    }
    onChange(id);
  };
  const drill = (id: string) => {
    setCursor(id);
    setQ("");
  };

  const rows = q.trim()
    ? all
        .filter((l) => `${l.name} ${l.short_name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))
        .sort(cmp)
        .slice(0, 80)
    : childrenOf(cursor);
  const crumbs = cursor ? pathOf(cursor) : [];
  const holderMatches = q.trim()
    ? holderRows.filter((h) => h.title.toLowerCase().includes(q.trim().toLowerCase()))
    : cursor === null
      ? holderRows
      : [];

  const sizeCls = size === "sm" ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-sm";

  const toggle = () => (open ? setOpen(false) : openPanel());
  // The opener is a real button and comes FIRST: a <label> around a field (its
  // own below, or a host's) forwards a click anywhere in it to the first
  // control inside, and that used to be the Clear button nested in the opener,
  // so opening a printer's Location cleared the saved one (#6365). Clear is a
  // sibling after the opener, never inside it, and no click but its own
  // reaches it.
  const trigger = (
    <div
      ref={trigRef}
      className={
        "w-full inline-flex items-center gap-1.5 border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 " +
        sizeCls +
        (className ? " " + className : "")
      }
    >
      <button type="button" onClick={toggle} aria-expanded={open} title={description ? firstActionSentence(description) : undefined} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left">
        <MapPin size={13} className="shrink-0 text-faint" />
        <span className="truncate flex-1 text-left">
          {triggerLabel ? triggerLabel : inside ? (
            where.data!.line
          ) : pickedHolder ? (
            pickedHolder.line ? `${pickedHolder.title}, in ${pickedHolder.line}` : pickedHolder.title
          ) : selected ? (
            pathOf(selected.id).map(nameOf).join(" › ")
          ) : (
            <span className="text-faint">{placeholder}</span>
          )}
        </span>
      </button>
      {!triggerLabel && (selected || inside) && (
        <button
          aria-label={inside ? `Take out of ${inside.name}` : "Clear location"}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            pick(null);
          }}
          className="shrink-0 text-faint hover:text-content p-0.5"
          title={inside ? `Take out of ${inside.name}` : "Clear location"}
        >
          <X size={13} />
        </button>
      )}
      {/* NAME-OK: decorative chevron, the opener button beside it carries the name */}
      <button type="button" tabIndex={-1} aria-hidden="true" onClick={toggle} className="shrink-0 cursor-pointer text-faint">
        <ChevronDown size={14} />
      </button>
    </div>
  );

  const panel =
    open &&
    rect &&
    createPortal(
      <>
        <OverlayLayer className="z-[60]" onClick={() => setOpen(false)} />
        <PopoverLayer
          ref={panelRef}
          data-testid="location-tree-picker-panel"
          className="z-[61] flex flex-col overflow-hidden rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-xl"
          style={{
            top: rect.bottom + 4,
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
            width: Math.max(rect.width, 288),
            maxHeight: Math.max(200, Math.min(window.innerHeight - rect.bottom - 16, 400)),
          }}
        >
          <div className="border-b border-line dark:border-slate-800 p-2">
            <SearchInput autoFocus value={q} onChange={setQ} placeholder="Search all locations…" aria-label="Search all locations" size="sm" />
          </div>
          {!q.trim() && (
            <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-line dark:border-slate-800 px-2.5 py-1.5 text-xs text-muted">
              <button
                type="button"
                onClick={() => setCursor(null)}
                className={"hover:text-accent " + (cursor === null ? "font-medium text-content" : "")}
              >
                All
              </button>
              {crumbs.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-1">
                  <ChevronRight size={11} className="text-faint" />
                  <button
                    type="button"
                    onClick={() => setCursor(c.id)}
                    className={"hover:text-accent " + (cursor === c.id ? "font-medium text-content" : "")}
                  >
                    {nameOf(c)}
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!q.trim() && (
              <button
                type="button"
                onClick={() => pick(null)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-faint hover:bg-subtle dark:hover:bg-slate-800"
              >
                {value === null && !chosen && <Check size={13} className="shrink-0 text-accent" />}
                {noneLabel}
              </button>
            )}
            {holderMatches.length > 0 && (
              <div data-testid="location-picker-holders" className="border-b border-line dark:border-slate-800">
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-widest text-faint">Inside something</div>
                {holderMatches.map((h) => {
                  const here = chosen?.kind === h.kind && chosen.id === h.id;
                  return (
                    <button
                      key={`${h.kind}:${h.id}`}
                      type="button"
                      onClick={() => void pickHolder(h)}
                      className={"flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-subtle dark:hover:bg-slate-800 " + (here ? "bg-cobble-50 dark:bg-cobble-950/30" : "")}
                    >
                      {here ? <Check size={13} className="shrink-0 text-accent" /> : <Backpack size={13} className="shrink-0 text-faint" />}
                      <span className="truncate">{h.title}</span>
                      {h.line && <span className="truncate text-xs text-faint">in {h.line}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {rows.length === 0 && holderMatches.length === 0 && <div className="px-3 py-3 text-sm text-faint">Nothing here.</div>}
            {rows.map((l) => {
              const kids = hasKids(l.id);
              const parentPath = pathOf(l.id).slice(0, -1);
              return (
                <div
                  key={l.id}
                  className={
                    "flex items-stretch hover:bg-subtle dark:hover:bg-slate-800 " +
                    (value === l.id && !inside ? "bg-cobble-50 dark:bg-cobble-950/30" : "")
                  }
                >
                  <button
                    type="button"
                    onClick={() => pick(l.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
                  >
                    {value === l.id && !inside && <Check size={13} className="shrink-0 text-accent" />}
                    <span className="truncate">
                      {nameOf(l)}
                      {l.short_name && l.short_name !== l.name && <span className="text-faint"> · {l.name}</span>}
                    </span>
                    {q.trim() && parentPath.length > 0 && (
                      <span className="truncate text-xs text-faint">in {parentPath.map(nameOf).join(" › ")}</span>
                    )}
                  </button>
                  {!q.trim() && kids && (
                    <button
                      aria-label={`Open ${nameOf(l)}`}
                      type="button"
                      onClick={() => drill(l.id)}
                      title={`Open ${nameOf(l)}`}
                      className="flex shrink-0 items-center border-l border-line/50 px-2 text-faint hover:text-accent dark:border-slate-800"
                    >
                      <ChevronRight size={16} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              // The picker steps aside for the form it opened: left up over
              // it, its full-screen layer took the form's Name and Create
              // (#7815).
              setOpen(false);
              setCreateOpen(true);
            }}
            className="flex w-full items-center gap-2 border-t border-line dark:border-slate-800 px-3 py-2 text-left text-sm text-accent hover:bg-subtle dark:hover:bg-slate-800"
          >
            <Plus size={14} /> New location…
          </button>
        </PopoverLayer>
      </>,
      document.body,
    );

  // Not a <label>: the caption would name the opener "Location" in place of
  // what it holds, and a label here was how a click on the field reached its
  // Clear (#6365).
  const body = label ? (
    <div className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">
        {label}
      </span>
      {trigger}
    </div>
  ) : (
    trigger
  );

  return (
    <>
      {description ? <ActionDescription description={description}>{body}</ActionDescription> : body}
      {panel}
      {createOpen && (
        <QuickCreateLocation
          slug={activeSlug}
          all={list.data?.items ?? []}
          onClose={() => setCreateOpen(false)}
          onCreated={(loc) => {
            onChange(loc.id);
            setCreateOpen(false);
            setOpen(false);
          }}
          // The same drill-down, one level in. It offers no "+ New location…"
          // of its own (no onCreate), so this cannot nest forever.
          parentField={(v, set) => (
            <LocationTreePicker label="Parent" value={v} onChange={set} placeholder="(top-level)" size="sm" />
          )}
        />
      )}
    </>
  );
}
