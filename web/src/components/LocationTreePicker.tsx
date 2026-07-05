// LocationTreePicker — a hierarchical, DRILL-DOWN location picker. Rooms "open
// into" their contents (breadcrumb navigation) instead of the flat, infinitely-
// tall indented <select> that LocationPicker renders. Same props, so it's a
// drop-in. Portals to body (a header's backdrop-blur traps position:fixed, so
// the panel must escape it — see the modal-portal convention).
//
// Interaction: a row's NAME picks that location (when it's a valid target for
// the `kind` filter); the ▸ on the right OPENS it to reveal its children. A leaf
// (no children) just picks. Search flattens to matches with their path.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, MapPin, Plus, Search, X } from "lucide-react";
import { api, type Location } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { QuickCreateLocation } from "./LocationPicker";

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
  /** Exclude one id (e.g. don't offer yourself as a parent). */
  excludeId?: string;
  /** Restrict PICKABLE rows to one kind ("area" rooms / "container" bins).
   *  Non-matching rows still show for navigation (you can drill THROUGH a room
   *  to reach its bins), they just can't be selected. */
  kind?: Location["kind"];
  label?: string;
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
}

// siblings: manual drag order (position), then NATURAL name (Bin 2 before Bin 10).
const cmp = (a: Location, b: Location) =>
  a.position - b.position || a.name.localeCompare(b.name, undefined, { numeric: true });

export function LocationTreePicker({
  value,
  onChange,
  excludeId,
  kind,
  label,
  placeholder = "Select a location…",
  className,
  size = "md",
}: Props) {
  const { activeSlug } = useActiveOrg();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null); // the room we've drilled into (null = top)
  const [q, setQ] = useState("");
  const trigRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const list = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
  });

  const all = useMemo(() => (list.data?.items ?? []).filter((i) => i.id !== excludeId), [list.data, excludeId]);
  const byId = useMemo(() => new Map(all.map((l) => [l.id, l] as const)), [all]);
  const parentOf = (l: Location): string | null => (l.parent_id && byId.has(l.parent_id) ? l.parent_id : null);
  const childrenOf = (pid: string | null) => all.filter((l) => parentOf(l) === pid).sort(cmp);
  const hasKids = (id: string) => all.some((l) => parentOf(l) === id);
  const canPick = (l: Location) => !kind || l.kind === kind;
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
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setQ("");
  };
  const drill = (id: string) => {
    setCursor(id);
    setQ("");
  };

  const rows = q.trim()
    ? all
        .filter((l) => canPick(l) && `${l.name} ${l.short_name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))
        .sort(cmp)
        .slice(0, 80)
    : childrenOf(cursor);
  const crumbs = cursor ? pathOf(cursor) : [];

  const sizeCls = size === "sm" ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-sm";

  const trigger = (
    <div
      ref={trigRef}
      role="button"
      tabIndex={0}
      onClick={() => (open ? setOpen(false) : openPanel())}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openPanel())}
      className={
        "w-full inline-flex items-center gap-1.5 border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 cursor-pointer " +
        sizeCls +
        (className ? " " + className : "")
      }
    >
      <MapPin size={13} className="shrink-0 text-faint" />
      <span className="truncate flex-1 text-left">
        {selected ? (
          pathOf(selected.id).map(nameOf).join(" › ")
        ) : (
          <span className="text-faint">{placeholder}</span>
        )}
      </span>
      {selected && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            pick(null);
          }}
          className="shrink-0 text-faint hover:text-content p-0.5"
          title="Clear location"
        >
          <X size={13} />
        </button>
      )}
      <ChevronDown size={14} className="shrink-0 text-faint" />
    </div>
  );

  const panel =
    open &&
    rect &&
    createPortal(
      <>
        <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
        <div
          className="fixed z-[61] flex flex-col overflow-hidden rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-xl"
          style={{
            top: rect.bottom + 4,
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
            width: Math.max(rect.width, 288),
            maxHeight: Math.max(200, Math.min(window.innerHeight - rect.bottom - 16, 400)),
          }}
        >
          <div className="flex items-center gap-2 border-b border-line dark:border-slate-800 px-2.5 py-2">
            <Search size={14} className="shrink-0 text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search all locations…"
              className="w-full bg-transparent text-sm outline-none"
            />
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
                {value === null && <Check size={13} className="shrink-0 text-accent" />}
                (no location)
              </button>
            )}
            {rows.length === 0 && <div className="px-3 py-3 text-sm text-faint">Nothing here.</div>}
            {rows.map((l) => {
              const kids = hasKids(l.id);
              const pickable = canPick(l);
              const parentPath = pathOf(l.id).slice(0, -1);
              return (
                <div
                  key={l.id}
                  className={
                    "flex items-stretch hover:bg-subtle dark:hover:bg-slate-800 " +
                    (value === l.id ? "bg-cobble-50 dark:bg-cobble-950/30" : "")
                  }
                >
                  <button
                    type="button"
                    onClick={() => (pickable ? pick(l.id) : kids ? drill(l.id) : undefined)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
                  >
                    {value === l.id && <Check size={13} className="shrink-0 text-accent" />}
                    <span className="truncate">
                      {nameOf(l)}
                      {l.short_name && l.short_name !== l.name && <span className="text-faint"> · {l.name}</span>}
                    </span>
                    {q.trim() && parentPath.length > 0 && (
                      <span className="truncate text-xs text-faint">in {parentPath.map(nameOf).join(" › ")}</span>
                    )}
                    {!pickable && kids && <span className="shrink-0 text-[10px] text-faint">open ▸</span>}
                  </button>
                  {!q.trim() && kids && (
                    <button
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
            onClick={() => setCreateOpen(true)}
            className="flex w-full items-center gap-2 border-t border-line dark:border-slate-800 px-3 py-2 text-left text-sm text-accent hover:bg-subtle dark:hover:bg-slate-800"
          >
            <Plus size={14} /> New location…
          </button>
        </div>
      </>,
      document.body,
    );

  const body = label ? (
    <label className="block">
      <span className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-faint dark:text-slate-500">
        {label}
      </span>
      {trigger}
    </label>
  ) : (
    trigger
  );

  return (
    <>
      {body}
      {panel}
      {createOpen && (
        <QuickCreateLocation
          slug={activeSlug}
          all={list.data?.items ?? []}
          defaultKind={kind}
          onClose={() => setCreateOpen(false)}
          onCreated={(loc) => {
            onChange(loc.id);
            setCreateOpen(false);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
