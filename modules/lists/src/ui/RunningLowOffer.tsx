// "Add running-low items to a list automatically?" Off until someone says so.
//
// Without a bundle, a thing running low never reached a list: the wire that
// does it came only with Groceries. A module never turns that on by itself (an
// update never opts anyone in), so the Lists page asks, once, and saying yes
// makes the same wire a bundle makes, pointed at the list the person picks. It
// shows only where something can run low (the event exists here), and says
// plainly when it is on and where things go, with the way to stop it.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingCart } from "lucide-react";
import { usePlatformWeb, useToast, type PlatformWire } from "@cobblr/platform-web";
import type { ListSummary } from "./api.js";

export const RUNNING_LOW_EVENT = "inventory.stock.low";
const ADD_ITEM = "lists:add-item";

/** The wire that already sends running-low things to a list, if any. */
export function runningLowWire(wires: PlatformWire[]): PlatformWire | undefined {
  return wires.find((w) => w.enabled && w.trigger_event === RUNNING_LOW_EVENT && w.action_id === ADD_ITEM);
}

function wireListName(w: PlatformWire, lists: ListSummary[]): string {
  const args = (w.args ?? {}) as { listId?: string; listTitle?: string };
  return lists.find((l) => l.id === args.listId)?.title ?? args.listTitle ?? "Shopping list";
}

export function RunningLowOffer({ lists }: { lists: ListSummary[] }) {
  const { api, orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  const toast = useToast();
  const [pick, setPick] = useState("");
  const can = !!api.listWires && !!api.createWire && !!api.deleteWire && !!api.listWireEvents;
  const events = useQuery({ queryKey: ["wire-events", orgSlug], queryFn: () => api.listWireEvents!(orgSlug), enabled: can, staleTime: 60_000 });
  const wires = useQuery({ queryKey: ["wires", orgSlug], queryFn: () => api.listWires!(orgSlug), enabled: can });
  const turnOn = useMutation({
    mutationFn: (listId: string) =>
      api.createWire!(orgSlug, { source_kind: "inventory:part", action_id: ADD_ITEM, trigger_type: "event", trigger_event: RUNNING_LOW_EVENT, args: { listId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["wires", orgSlug] });
      toast.success("Things running low will go on that list.");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const turnOff = useMutation({
    mutationFn: (id: string) => api.deleteWire!(orgSlug, id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["wires", orgSlug] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  if (!can || !events.data?.items.some((e) => e.event === RUNNING_LOW_EVENT) || !wires.data) return null;
  const on = runningLowWire(wires.data.items);
  const listId = pick || lists[0]?.id || "";

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 px-3 py-2.5 flex flex-wrap items-center gap-2 text-sm" data-testid="running-low-offer">
      <ShoppingCart size={15} className="text-accent shrink-0" aria-hidden />
      {on ? (
        <>
          <span className="flex-1 min-w-[12rem] text-content dark:text-mortar-100">
            Things running low go on <strong>{wireListName(on, lists)}</strong> by themselves.
          </span>
          {!on.bundle_id && (
            <button type="button" onClick={() => turnOff.mutate(on.id)} disabled={turnOff.isPending} className="text-xs text-muted hover:text-accent">
              Stop
            </button>
          )}
        </>
      ) : lists.length === 0 ? (
        <span className="flex-1 text-muted">Make a list, and things running low can go on it by themselves.</span>
      ) : (
        <>
          <span className="flex-1 min-w-[12rem] text-content dark:text-mortar-100">Add running-low items to a list automatically?</span>
          <select aria-label="Which list" value={listId} onChange={(e) => setPick(e.target.value)} className="input !w-auto text-xs">
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => listId && turnOn.mutate(listId)} disabled={!listId || turnOn.isPending} className="px-3 py-1.5 text-xs rounded bg-cobble-600 text-white disabled:opacity-50">
            Turn on
          </button>
        </>
      )}
    </div>
  );
}
