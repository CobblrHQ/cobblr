// LocationPicker — picks a row from core-locations:location. Used
// wherever an entity has a `location_id: string | null` field (machines,
// assets, inventory parts, future kinds). Renders as a nested-indent
// dropdown so the hierarchy is legible at a glance.
//
// The "+ new location" sentinel in the dropdown opens an inline modal
// that creates the row, then auto-selects it — so a user discovering
// they need a new location doesn't have to abandon their form.

import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api, type Location } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

const CREATE_SENTINEL = "__new__";
// U+00A0 (non-breaking space) for option indentation — regular spaces
// get collapsed in <option> text by every major browser.
const INDENT = "  ";

// The ONE place that understands location order: siblings sort by manual
// drag-order (`position`) then NATURAL name (Bin 1, Bin 2, … Bin 10 — never
// Bin 1, Bin 10, Bin 2), depth-first so the hierarchy reads top-down. A node
// whose parent was filtered out (e.g. an area-only list) becomes a root. Matches
// the LocationsPage tree, so dropdown order == what the user arranged there.
function orderLocations(items: Location[]): Location[] {
  const ids = new Set(items.map((i) => i.id));
  const byParent = new Map<string, Location[]>();
  const roots: Location[] = [];
  for (const it of items) {
    const p = it.parent_id && ids.has(it.parent_id) ? it.parent_id : null;
    if (p) (byParent.get(p) ?? byParent.set(p, []).get(p)!).push(it);
    else roots.push(it);
  }
  const cmp = (a: Location, b: Location) =>
    a.position - b.position || a.name.localeCompare(b.name, undefined, { numeric: true });
  const out: Location[] = [];
  const walk = (n: Location) => {
    out.push(n);
    (byParent.get(n.id) ?? []).sort(cmp).forEach(walk);
  };
  roots.sort(cmp).forEach(walk);
  return out;
}

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
  /** When set, the option for this id is excluded — used in the
   *  Locations admin form to prevent picking yourself as a parent.
   *  Doesn't filter descendants (caller's job if needed). */
  excludeId?: string;
  /** Restrict the pickable rows to one kind. `"area"` = rooms/zones only (for
   *  things that live in a room — printers, machines, assets); `"container"` =
   *  bins/drawers only. Omit to offer the whole hierarchy. A location created
   *  inline defaults to this kind. */
  kind?: Location["kind"];
  /** Visible <label> wrapped around the select. Omit when the caller
   *  draws their own label. */
  label?: string;
  className?: string;
  size?: "sm" | "md";
}

export function LocationPicker({
  value,
  onChange,
  excludeId,
  kind,
  label,
  className,
  size = "md",
}: Props) {
  const { activeSlug } = useActiveOrg();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
  });
  const items = useMemo(() => {
    let rows = (list.data?.items ?? []).filter((i) => i.id !== excludeId);
    if (kind) rows = rows.filter((i) => i.kind === kind);
    return orderLocations(rows);
  }, [list.data, excludeId, kind]);

  const sizeClass = size === "sm" ? "px-2 py-1 text-xs" : "px-2 py-1 text-sm";

  const select = (
    <select
      value={value ?? ""}
      onChange={(e) => {
        if (e.target.value === CREATE_SENTINEL) {
          setCreateOpen(true);
          return;
        }
        onChange(e.target.value || null);
      }}
      className={
        "w-full border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 " +
        sizeClass +
        (className ? " " + className : "")
      }
    >
      <option value="">(no location)</option>
      {items.map((loc) => (
        <option key={loc.id} value={loc.id}>
          {INDENT.repeat(loc.depth)}
          {loc.short_name ?? loc.name}
          {loc.short_name && loc.short_name !== loc.name ? ` — ${loc.name}` : ""}
        </option>
      ))}
      <option value={CREATE_SENTINEL}>+ new location…</option>
    </select>
  );

  const body = label ? (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      {select}
    </label>
  ) : (
    select
  );

  return (
    <>
      {body}
      {createOpen && (
        <QuickCreateLocation
          slug={activeSlug}
          all={list.data?.items ?? []}
          defaultKind={kind}
          onClose={() => setCreateOpen(false)}
          onCreated={(loc) => {
            onChange(loc.id);
            setCreateOpen(false);
          }}
        />
      )}
    </>
  );
}

/** The next globally-unique container number — max trailing integer across all
 *  container locations, + 1. By convention every container (bin/drawer/shelf)
 *  carries a unique number you can label + scan, regardless of its word. */
function nextContainerNumber(all: Location[]): number {
  let max = 0;
  for (const l of all) {
    if (l.kind !== "container") continue;
    const m = (l.name ?? "").match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max + 1;
}

const ENDS_WITH_NUMBER = /\d\s*$/;

// Inline accordion — name + parent + kind, expanded right inside the parent
// form (no nested modal; the author). Containers auto-append a globally-unique number
// so "Bin" becomes "Bin 17". Mirrors the full form on /configuration/locations
// but trimmed for in-flight use.
export function QuickCreateLocation({
  slug,
  all,
  defaultKind,
  onClose,
  onCreated,
}: {
  slug: string;
  all: Location[];
  defaultKind?: Location["kind"];
  onClose: () => void;
  onCreated: (loc: Location) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [kind, setKind] = useState<"area" | "container">(defaultKind ?? "container");
  const [parentId, setParentId] = useState<string>("");

  const nextNum = nextContainerNumber(all);
  // A container whose name is just a word ("Bin", "Office") gets the global
  // number appended; an explicit "Bin 5" is left as typed.
  const autoNumber = kind === "container" && name.trim().length > 0 && !ENDS_WITH_NUMBER.test(name);
  const finalName = autoNumber ? `${name.trim()} ${nextNum}` : name.trim();

  const create = useMutation({
    mutationFn: () =>
      api.createLocation(slug, {
        name: finalName,
        short_name: shortName.trim() || null,
        kind,
        parent_id: parentId || null,
      }),
    onSuccess: (loc) => {
      void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
      toast.success("Location created");
      onCreated(loc);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : String(err));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate();
  }

  const fieldCls =
    "w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900";
  const labelCls =
    "block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1";

  return (
    <div className="mt-2 rounded-lg border border-line dark:border-slate-700 bg-subtle/50 dark:bg-slate-800/40 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-accent">New location</span>
        <button
          type="button"
          onClick={onClose}
          className="text-faint hover:text-content dark:hover:text-mortar-100 transition"
          aria-label="Close"
        >
          <X size={13} />
        </button>
      </div>
      {/* Not a <form> — this is nested inside the parent entity's <form>, and a
          nested form is invalid HTML (the inner submit would bubble to the outer).
          Enter-to-submit + the button both call create() directly. */}
      <div className="space-y-2.5" onKeyDown={(e) => { if (e.key === "Enter") submit(e); }}>
        <label className="block">
          <span className={labelCls}>Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="e.g. Bin, Office, Shelf"
            className={fieldCls}
          />
          {autoNumber && (
            <span className="mt-1 block text-[10px] text-muted dark:text-slate-400">
              → <span className="font-medium text-content dark:text-mortar-200">{finalName}</span>{" "}
              (auto-numbered — containers get a unique number)
            </span>
          )}
        </label>
        <label className="block">
          <span className={labelCls}>Short name (optional)</span>
          <input type="text" value={shortName} onChange={(e) => setShortName(e.target.value)} className={fieldCls} />
        </label>
        <label className="block">
          <span className={labelCls}>Parent</span>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={fieldCls}>
            <option value="">(top-level)</option>
            {all.map((p) => (
              <option key={p.id} value={p.id}>
                {INDENT.repeat(p.depth)}
                {p.short_name ?? p.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className={labelCls}>Kind</span>
          <div className="grid grid-cols-2 gap-2">
            {([
              { v: "container", title: "Container", hint: "bin, drawer, shelf" },
              { v: "area", title: "Area", hint: "room, corner, workshop" },
            ] as const).map((opt) => {
              const on = kind === opt.v;
              return (
                <button
                  key={opt.v}
                  type="button"
                  onClick={() => setKind(opt.v)}
                  className={
                    "rounded-md border px-2.5 py-1.5 text-left transition " +
                    (on
                      ? "border-cobble-500 bg-cobble-50 dark:bg-cobble-900/30 ring-1 ring-cobble-400"
                      : "border-line dark:border-slate-600 hover:bg-surface dark:hover:bg-slate-900")
                  }
                  aria-pressed={on}
                >
                  <span className="block text-sm font-medium text-content dark:text-mortar-100">{opt.title}</span>
                  <span className="block text-[10px] text-faint dark:text-slate-500">{opt.hint}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submit(new Event("submit") as unknown as FormEvent)}
            disabled={!name.trim() || create.isPending}
            className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white"
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
