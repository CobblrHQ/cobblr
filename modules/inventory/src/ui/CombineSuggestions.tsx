// "These look like one item at 2 places: combine?" Records with the same name
// or barcode, each kept somewhere else, are offered as one thing; nothing is
// ever combined without a yes. "They're different" stops the question for
// good. See docs/design-decisions/holdings-and-units.md (phase 4).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { useInventory } from "./context";
import type { CombineSuggestion } from "./api";

import { countOf } from "@cobblr/platform-contract/plural";
function placesWords(s: CombineSuggestion): string {
  return s.records.map((r) => r.location_name ?? "no place set").join(", ");
}

function SuggestionRow({ s, onDone }: { s: CombineSuggestion; onDone: () => void }) {
  const { api } = useInventory();
  const toast = useToast();
  // The card keeps the record with the most on hand; the others become its places.
  const into = [...s.records].sort((a, b) => b.qty - a.qty)[0]!;
  const combine = useMutation({
    mutationFn: () => api.combineHoldings(into.id, s.records.filter((r) => r.id !== into.id).map((r) => r.id)),
    onSuccess: () => {
      toast.success(`${into.name} is one item now, with a row for each place.`);
      onDone();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't combine them."),
  });
  const different = useMutation({
    mutationFn: () => api.notTheSame(s.records.map((r) => r.id)),
    onSuccess: onDone,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save that."),
  });
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm" data-testid="combine-suggestion">
      <span className="flex-1 min-w-0 basis-48">
        <span className="font-medium text-content dark:text-mortar-100">{into.name}</span>
        <span className="text-muted dark:text-slate-400"> · {placesWords(s)}</span>
        <span className="block text-[11px] text-faint">{s.records.length === 2 ? "Both have" : `All ${s.records.length} have`} {s.because}</span>
      </span>
      <button
        type="button"
        disabled={combine.isPending}
        onClick={() => combine.mutate()}
        className="rounded-md bg-cobble-600 hover:bg-cobble-500 text-white text-xs font-medium px-3 py-1.5 transition disabled:opacity-50"
      >
        Combine
      </button>
      <button type="button" disabled={different.isPending} onClick={() => different.mutate()} className="text-xs text-muted hover:text-accent">
        They're different
      </button>
    </li>
  );
}

/** On the list: how many things look duplicated across places, and each one's
 *  question on request. Renders nothing when there are none. */
export function CombineSuggestionsBanner() {
  const { api, entityKind } = useInventory();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ["inventory-combine-suggestions", entityKind], queryFn: () => api.combineSuggestions() });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["inventory-combine-suggestions"] });
    void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    void qc.invalidateQueries({ queryKey: ["inventory-holdings"] });
  };
  return (
    <div className="rounded-xl border border-cobble-200 dark:border-cobble-800 bg-subtle dark:bg-slate-800/60 px-3 py-2" data-testid="combine-banner">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex-1 min-w-0 text-content dark:text-mortar-100">
          {items.length === 1
            ? `${items[0]!.records[0]!.name} looks like one item kept in ${items[0]!.records.length} places.`
            : `${countOf(items.length, "thing")} look like one item kept in several places.`}
        </span>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs text-accent hover:underline">
          {open ? "Hide" : "Review"}
        </button>
      </div>
      {open && (
        <ul className="mt-1 divide-y divide-line dark:divide-slate-700">
          {items.map((s) => (
            <SuggestionRow key={s.records.map((r) => r.id).join(",")} s={s} onDone={refresh} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** On one item: the same question, about this item only. */
export function CombineSuggestionFor({ partId }: { partId: string }) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["inventory-combine-suggestions", "for", partId], queryFn: () => api.combineSuggestions(partId) });
  const s = q.data?.items[0];
  if (!s) return null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["inventory-combine-suggestions"] });
    void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    void qc.invalidateQueries({ queryKey: ["inventory-holdings"] });
  };
  return (
    <div className="rounded-md border border-cobble-200 dark:border-cobble-800 px-2 py-1" data-testid="combine-for">
      <div className="text-[11px] text-muted dark:text-slate-400">This looks like the same item kept in other places:</div>
      <ul>
        <SuggestionRow s={s} onDone={refresh} />
      </ul>
    </div>
  );
}
