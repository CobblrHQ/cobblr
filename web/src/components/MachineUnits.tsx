// One machine record can stand for several identical machines, and any of
// them can be named under it: its own name, state, notes, service log, label
// and links, still one of the record's count. This is where a person names
// one, opens one, splits one into a record of its own, or makes a single
// machine one of a group. The rules live server-side (modules/machines
// units.ts); this only says them.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api, type Machine, type MachineUnitMove } from "../lib/api";

const pill =
  "inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-line dark:border-slate-600 text-muted hover:border-cobble-500 hover:text-accent transition disabled:opacity-50";

export function MachineUnits({
  slug,
  machine: m,
  instance,
  onOpen,
}: {
  slug: string;
  machine: Machine;
  instance?: string;
  onOpen?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [joining, setJoining] = useState(false);
  const [parentId, setParentId] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["machine", slug] });
    void qc.invalidateQueries({ queryKey: ["machines", slug] });
  };
  const failed = (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e));
  const moved = (what: string) => (r: MachineUnitMove) => {
    toast.success(`${what}. The group now counts ${r.parent_quantity}.`);
    refresh();
  };

  const name = useMutation({
    mutationFn: () => api.nameMachineUnit(slug, m.id, {}, instance),
    onSuccess: (r) => {
      refresh();
      onOpen?.(r.id);
    },
    onError: failed,
  });
  const splitOne = useMutation({ mutationFn: () => api.splitOneMachine(slug, m.id, instance), onSuccess: moved("Split one off into its own"), onError: failed });
  const split = useMutation({ mutationFn: (id: string) => api.splitMachineUnit(slug, id, instance), onSuccess: moved("Split into its own"), onError: failed });
  const join = useMutation({
    mutationFn: () => api.makeMachineUnitOf(slug, m.id, parentId, instance),
    onSuccess: (r) => {
      moved("Now one of the group")(r);
      setJoining(false);
    },
    onError: failed,
  });
  const others = useQuery({
    queryKey: ["machines", slug, instance ?? null, "unit-of-candidates"],
    queryFn: () => api.listMachines(slug, instance),
    enabled: joining,
  });

  const units = m.units ?? [];
  const notNamed = m.units_not_named ?? Math.max((m.quantity ?? 1) - units.length, 0);

  if (m.unit_of) {
    return (
      <div className="rounded-lg border border-line dark:border-slate-700 px-3 py-2 text-sm flex flex-wrap items-center gap-2" data-testid="machine-units">
        <span className="flex-1 min-w-0 text-content dark:text-mortar-100">
          One of{" "}
          <button type="button" className="text-accent hover:underline" onClick={() => onOpen?.(m.unit_of!.id)}>
            {m.unit_of.name}
          </button>
        </span>
        <button type="button" className={pill} disabled={split.isPending} onClick={() => split.mutate(m.id)}>
          Split into its own
        </button>
      </div>
    );
  }

  if ((m.quantity ?? 1) > 1 || units.length > 0) {
    return (
      <div className="rounded-lg border border-line dark:border-slate-700 px-3 py-2 text-sm space-y-2" data-testid="machine-units">
        <div className="text-xs text-muted">
          {m.quantity} of these{units.length ? `, ${units.length} with a name of ${units.length === 1 ? "its" : "their"} own` : ""}
        </div>
        {units.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-2" data-testid="machine-unit">
            <button type="button" className="flex-1 min-w-0 basis-40 truncate text-left text-content dark:text-mortar-100 hover:text-accent" onClick={() => onOpen?.(u.id)}>
              {u.name}
            </button>
            <span className="text-[11px] text-faint">{u.state}</span>
            <button type="button" className={pill} disabled={split.isPending} onClick={() => split.mutate(u.id)}>
              Split into its own
            </button>
          </div>
        ))}
        {notNamed > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 min-w-0 basis-40 text-xs text-muted">
              {notNamed} {notNamed === 1 ? "has" : "have"} no name of {notNamed === 1 ? "its" : "their"} own
            </span>
            <button type="button" className={pill} disabled={name.isPending} onClick={() => name.mutate()}>
              Name one
            </button>
            {(m.quantity ?? 1) > 1 && (
              <button type="button" className={pill} disabled={splitOne.isPending} onClick={() => splitOne.mutate()}>
                Split one off
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const candidates = (others.data?.items ?? []).filter((o) => o.id !== m.id);
  return joining ? (
    <div className="rounded-lg border border-line dark:border-slate-700 px-3 py-2 text-sm flex flex-wrap items-center gap-2" data-testid="machine-units">
      <label className="flex-1 min-w-0 basis-48 text-xs text-muted">
        One of the machines in
        <select className="mt-1 block w-full rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1 text-sm text-content dark:text-mortar-100" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">Pick a record…</option>
          {candidates.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.quantity > 1 ? ` (${o.quantity})` : ""}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className={pill} disabled={!parentId || join.isPending} onClick={() => join.mutate()}>
        Make it one of them
      </button>
      <button type="button" className="text-xs text-muted hover:text-accent" onClick={() => setJoining(false)}>
        Cancel
      </button>
    </div>
  ) : (
    <button type="button" className={pill} onClick={() => setJoining(true)} data-testid="machine-join-group">
      One of a group…
    </button>
  );
}
