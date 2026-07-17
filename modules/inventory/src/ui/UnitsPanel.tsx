// The units (serials) filed under a model. A unit IS a part, so each row links
// to its own detail; adding one files a serial and does NOT move the model's
// count (that separation is the whole reconciliation story — see
// docs/design-decisions/within-instance-units.md).
//
// Shown on every part's detail: any part can gain units, and one that has them
// then reads as a model. There is no "make this a model" toggle — model-ness is
// derived from having units, the same way stock-vs-catalog is derived from data.

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { useInventory } from "./context";

/** Who holds this unit — click to set/change. A plain string ("Janet", "IT
 *  Dept", "Loaned to Bob"); the individual, not the count, is the thing you look
 *  at. See docs/design-decisions/per-unit-assignment.md. */
function HolderCell({ value, onCommit }: { value: string | null; onCommit: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  if (editing) {
    const commit = () => {
      setEditing(false);
      const next = draft.trim() || null;
      if (next !== (value ?? null)) onCommit(next);
    };
    return (
      <input
        autoFocus
        className="input !w-32 text-xs"
        value={draft}
        placeholder="holder"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(value ?? ""); setEditing(false); }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => { setDraft(value ?? ""); setEditing(true); }}
      className={
        "shrink-0 text-xs transition " +
        (value ? "text-content dark:text-mortar-100 hover:text-accent" : "text-faint dark:text-slate-500 italic hover:text-accent")
      }
      title="Assign this unit"
    >
      {value ? `→ ${value}` : "assign"}
    </button>
  );
}

export function UnitsPanel({ partId }: { partId: string }) {
  const { api, basePath, instance } = useInventory();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [serial, setSerial] = useState("");

  const list = useQuery({
    queryKey: ["inventory-units", partId],
    queryFn: () => api.listUnits(partId),
  });

  const assign = useMutation({
    mutationFn: (v: { id: string; assigned_to: string | null }) => api.updatePart(v.id, { assigned_to: v.assigned_to }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["inventory-units", partId] }),
  });

  const add = useMutation({
    mutationFn: () => api.mintUnit(partId, serial.trim() ? { serial_number: serial.trim() } : {}),
    onSuccess: () => {
      setSerial("");
      // The list grows, and units_count on the model changes — which is what the
      // reconciliation chip + prompt read, so refresh the part too.
      void qc.invalidateQueries({ queryKey: ["inventory-units", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-part", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add the unit."),
  });

  const items = list.data?.items ?? [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-accent">
        // units on file{items.length > 0 ? ` (${items.length})` : ""}
      </div>
      {list.isLoading && <div className="text-xs text-faint dark:text-slate-500">loading…</div>}
      {items.length === 0 && !list.isLoading && (
        <div className="text-xs text-faint dark:text-slate-500 italic">
          No serials on file yet. Add one below to start tracking individuals.
        </div>
      )}
      {items.length > 0 && (
        <ul className="divide-y divide-line dark:divide-slate-700 -mx-1">
          {items.map((u) => (
            <li key={u.id} className="px-1 py-2 flex items-baseline gap-3 text-sm">
              {u.serial_number && (
                <span className="font-mono text-xs shrink-0 text-content dark:text-mortar-100">
                  {u.serial_number}
                </span>
              )}
              <a
                href={`${basePath}/parts/${u.id}`}
                className="flex-1 truncate text-muted dark:text-slate-400 hover:text-accent transition"
              >
                {u.name}
              </a>
              <HolderCell
                value={u.assigned_to}
                onCommit={(v) => assign.mutate({ id: u.id, assigned_to: v })}
              />
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex gap-2 pt-1">
        <input
          className="input !w-full text-sm"
          value={serial}
          placeholder="Serial number (optional)"
          onChange={(e) => setSerial(e.target.value)}
        />
        <button
          type="submit"
          disabled={add.isPending}
          className="rounded-md bg-cobble-600 hover:bg-cobble-500 text-white text-xs font-medium px-3 py-1.5 transition disabled:opacity-50 whitespace-nowrap"
        >
          {add.isPending ? "Adding…" : "Add a serial"}
        </button>
        {/* Scan serials straight in: the camera opens knowing this model
            (?unitOf), files each decode as a unit, and stays live for the next.
            See within-instance-units.md. */}
        <button
          type="button"
          onClick={() =>
            navigate(
              `/scan/camera?unitOf=${partId}${instance ? `&into=${encodeURIComponent(instance)}` : ""}`,
            )
          }
          className="rounded-md border border-line dark:border-slate-600 text-content dark:text-mortar-100 text-xs font-medium px-3 py-1.5 transition hover:bg-subtle dark:hover:bg-slate-800 whitespace-nowrap"
          title="Scan serials into this item"
        >
          Scan
        </button>
      </form>
    </div>
  );
}
