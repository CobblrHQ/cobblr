// QuickCreateLocation — the inline "+ New location…" accordion that every
// location picker opens when the place you want doesn't exist yet. Create it
// without abandoning the form you were filling in, and the picker selects the
// new row for you.
//
// It used to live inside LocationPicker.tsx (the flat indented <select> that
// the drill-down picker replaced). That file is gone; this is the half of it
// that was always shared.

import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api, type Location } from "../lib/api";

/** The next free container number: the highest trailing number across all
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
// form (no nested modal). Containers auto-append a globally-unique number so
// "Bin" becomes "Bin 17". Mirrors the full form on /locations but trimmed for
// in-flight use.
export function QuickCreateLocation({
  slug,
  all,
  defaultKind,
  fixedParentId,
  onClose,
  onCreated,
  parentField,
}: {
  slug: string;
  all: Location[];
  defaultKind?: Location["kind"];
  /** Create INSIDE this location, with no parent picker at all. For a place
   *  that already IS the parent — the "add a location inside this one" button
   *  on a location's own page — where asking again would be asking a question
   *  the page has already answered. */
  fixedParentId?: string;
  onClose: () => void;
  onCreated: (loc: Location) => void;
  /** Renders the Parent field. Required, and taken as a prop rather than
   *  imported, because the thing that belongs here is the workspace's location
   *  picker — and every picker renders THIS component, so importing one back
   *  would close an import cycle. The picker hands its own down instead. */
  parentField?: (value: string | null, onChange: (id: string | null) => void) => ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [kind, setKind] = useState<"area" | "container">(defaultKind ?? "container");
  const [parentId, setParentId] = useState<string>(fixedParentId ?? "");

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
              (auto-numbered - containers get a unique number)
            </span>
          )}
        </label>
        <label className="block">
          <span className={labelCls}>Short name (optional)</span>
          <input type="text" value={shortName} onChange={(e) => setShortName(e.target.value)} className={fieldCls} />
        </label>
        {!fixedParentId && parentField?.(parentId || null, (id) => setParentId(id ?? ""))}
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
