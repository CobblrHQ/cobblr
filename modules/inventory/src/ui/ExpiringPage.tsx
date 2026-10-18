// Going off soon, wherever it is: one line per lot, grouped by place, the place
// with the soonest first, and anything already past its date on top. A closet
// can hold a lot that is fine beside one that expires Friday, so the line is
// the lot, never the item. Spans every collection: a vehicle carries supplies
// and snacks alike. See docs/design-decisions/holdings-and-units.md (phase 3).

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { countdownWords, type Day } from "@cobblr/platform-contract/day";
import { useRunWithUndo } from "@cobblr/platform-web";
import { useInventory } from "./context";

const WINDOWS = [7, 30, 90] as const;

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
}

export function ExpiringPage() {
  const { api, instance } = useInventory();
  const [within, setWithin] = useState<number>(30);
  const q = useQuery({ queryKey: ["inventory-expiring", instance ?? "inventory", within], queryFn: () => api.stockExpiring(within) });
  const run = useRunWithUndo();
  const qc = useQueryClient();
  // One at a time, as the record's own buttons do, but off the lot this row
  // names: the oldest is a different carton, and the row's count says what is
  // left of this one.
  const settle = (l: { part_id: string; kind: string; name: string; lot: string | null; received_on: string; expires_on: string }, actionId: string, done: string) =>
    run(
      {
        actionId,
        entityKind: l.kind,
        entityId: l.part_id,
        args: { ...(l.received_on ? { lot_received_on: l.received_on } : {}), lot_expires_on: l.expires_on, ...(l.lot ? { lot_number: l.lot } : {}) },
      },
      done,
    )
      .catch(() => undefined)
      .finally(() => void qc.invalidateQueries({ queryKey: ["inventory-expiring"] }));
  const places = q.data?.places ?? [];
  const today = (q.data?.today ?? "") as Day;
  return (
    <div className="space-y-4" data-testid="expiring-page">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted dark:text-slate-400">Going off within</span>
        <div className="inline-flex rounded border border-line dark:border-slate-700 overflow-hidden" role="group" aria-label="Within">
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={within === d}
              onClick={() => setWithin(d)}
              className={
                "px-2.5 py-1 text-xs transition " +
                (within === d ? "bg-cobble-600 text-white" : "text-muted dark:text-slate-400 hover:bg-subtle dark:hover:bg-slate-800")
              }
            >
              {d} days
            </button>
          ))}
        </div>
      </div>
      {q.isLoading && <div className="text-xs text-faint">loading…</div>}
      {q.data && places.length === 0 && (
        <div className="border border-dashed border-line dark:border-slate-700 rounded-md p-6 text-center text-sm text-faint italic">
          Nothing goes off in the next {within} days.
        </div>
      )}
      {places.map((p) => (
        <section key={p.location_id ?? "none"} className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900" data-testid="expiring-place">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-line dark:border-slate-700">
            <MapPin size={13} className="text-accent" />
            {p.location_id ? (
              <Link to={`/locations/${p.location_id}`} className="text-sm font-medium text-content dark:text-mortar-100 hover:text-accent">
                {p.location_name ?? "A place"}
              </Link>
            ) : (
              <span className="text-sm font-medium text-muted">No place set</span>
            )}
            <span className="ml-auto text-[11px] font-mono text-faint">{p.lots.length} {p.lots.length === 1 ? "lot" : "lots"}</span>
          </div>
          <ul className="divide-y divide-line dark:divide-slate-800">
            {p.lots.map((l, i) => (
              <li key={`${l.part_id}-${l.expires_on}-${l.lot ?? ""}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-sm" data-testid="expiring-lot">
                <Link to={l.detail_path} className="flex-1 min-w-0 basis-40 truncate text-content dark:text-mortar-100 hover:text-accent">
                  {l.name}
                </Link>
                <span className="font-mono text-xs">{fmt(l.qty)}</span>
                {l.lot && <span className="font-mono text-[11px] text-muted">lot {l.lot}</span>}
                <span className={"font-mono text-[11px] " + (l.days < 0 ? "text-ember-600 dark:text-ember-400" : l.days <= 7 ? "text-amber-700 dark:text-amber-400" : "text-muted dark:text-slate-400")}>
                  {l.days < 0 ? `${-l.days}d past its date` : today ? countdownWords(l.expires_on as Day, today) : l.expires_on}
                </span>
                <span className="ml-auto flex gap-1.5">
                  <button
                    type="button"
                    aria-label={`Used up ${l.name}`}
                    onClick={() => void settle(l, "inventory:use-up", `Used up ${l.name}.`)}
                    className="min-h-9 rounded-md border border-line dark:border-slate-600 px-2.5 text-xs text-content dark:text-mortar-100 hover:border-accent"
                  >
                    Used up
                  </button>
                  <button
                    type="button"
                    aria-label={`Threw out ${l.name}`}
                    onClick={() => void settle(l, "inventory:mark-spoiled", `Threw out ${l.name}.`)}
                    className="min-h-9 rounded-md border border-line dark:border-slate-600 px-2.5 text-xs text-content dark:text-mortar-100 hover:border-accent"
                  >
                    Threw out
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
