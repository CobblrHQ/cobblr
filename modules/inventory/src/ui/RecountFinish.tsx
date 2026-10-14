// Finishing a recount (#6302): seen, new and not seen, previewed with the
// choices made here before anything changes, then applied in one press with
// one Undo. "The scan is the truth" is the owner's "overwrite": on, what was
// not seen defaults to gone and places and amounts come from the scans.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRunAction, useToast, useUnits } from "@cobblr/platform-web";
import { countOf } from "@cobblr/platform-contract/plural";
import { useInventory } from "./context";
import type { NewChoice, NotSeenChoice } from "../recount-reconcile.js";

const NOT_SEEN: Array<{ value: NotSeenChoice; label: string }> = [
  { value: "gone", label: "Mark gone" },
  { value: "keep", label: "Keep" },
  { value: "later", label: "Still out, check later" },
];

export function RecountFinish({ id, onClose }: { id: string; onClose: () => void }) {
  const { api, orgSlug } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();
  const units = useUnits();
  // PRESS-ARGS: Apply passes this recount's id and every choice the preview on screen was made with; Undo passes the recount it finished.
  const runAction = useRunAction();
  const [truth, setTruth] = useState(false);
  const [notSeen, setNotSeen] = useState<Record<string, NotSeenChoice>>({});
  const [all, setAll] = useState<NotSeenChoice | "">("");
  const [fresh, setFresh] = useState<Record<string, NewChoice>>({});
  const [busy, setBusy] = useState(false);
  const body = { truth, not_seen: notSeen, ...(all ? { not_seen_all: all } : {}), new: fresh };
  const plan = useQuery({ queryKey: ["inventory-recount-plan", orgSlug, id, JSON.stringify(body)], queryFn: () => api.recountPlan(id, body), enabled: !busy, placeholderData: (prev) => prev });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["inventory-recount", orgSlug, id] });

  const apply = async () => {
    setBusy(true);
    try {
      const res = await runAction({ actionId: "inventory:apply-recount", args: { recount_id: id, ...body } }, { undo: "shown-here" });
      refresh();
      onClose();
      toast.action(String((res.result as { summary?: unknown } | null)?.summary ?? "Finished the recount."), {
        actionLabel: "Undo",
        onAction: async () => {
          try {
            await runAction({ actionId: "inventory:undo-recount", args: { recount_id: id } }, { undo: "is-undo" });
            refresh();
            toast.success("Put everything back as it was.");
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const p = plan.data;
  const head = "text-[10px] uppercase tracking-widest text-accent";
  const list = "divide-y divide-line dark:divide-slate-800 rounded-md border border-line dark:border-slate-700";
  return (
    <section className="space-y-3 rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3" data-testid="recount-finish">
      <label className="flex min-h-11 items-start gap-3 text-sm">
        <input type="checkbox" role="switch" aria-checked={truth} checked={truth} onChange={(e) => setTruth(e.target.checked)} className="mt-0.5 h-5 w-5" />
        <span>
          <span className="block font-medium text-content dark:text-mortar-100">The scan is the truth</span>
          <span className="block text-xs text-muted dark:text-slate-400">What you did not scan is marked gone, and places and amounts come from the scans. Still previewed below.</span>
        </span>
      </label>
      {plan.isError && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{plan.error instanceof Error ? plan.error.message : "The preview could not be read."}</p>}
      {p && (
        <>
          <div className="space-y-1">
            <h3 className={head}>Seen: {p.counts.seen}</h3>
            {p.seen.some((s) => s.move || s.amount) ? (
              <ul className={list}>
                {p.seen.filter((s) => s.move || s.amount).map((s) => (
                  <li key={s.id} className="px-3 py-2 text-sm text-content dark:text-mortar-100">
                    {s.title}
                    {s.move && <span className="text-muted dark:text-slate-400">: moves to {s.move.to_name ?? "its new place"}</span>}
                    {s.amount && <span className="text-muted dark:text-slate-400">: {units.format(s.amount.after, s.amount.unit)} left (was {units.format(s.amount.before, s.amount.unit)})</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted dark:text-slate-400">{truth ? "Nothing seen has moved or changed amount." : "Seen things stay as recorded."}</p>
            )}
          </div>
          {p.new.length > 0 && (
            <div className="space-y-1">
              <h3 className={head}>New: {p.counts.added} to add</h3>
              <ul className={list}>
                {p.new.map((n) => (
                  <li key={n.scan_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span data-recount-title className="min-w-0 basis-full break-words text-content dark:text-mortar-100 sm:basis-auto sm:flex-1">{n.title}</span>
                    <select aria-label={`What to do with ${n.title}`} value={n.choice} onChange={(e) => setFresh((m) => ({ ...m, [n.scan_id]: e.target.value as NewChoice }))} className="min-h-11 rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 text-sm">
                      <option value="add">Add it</option>
                      <option value="skip">Skip</option>
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.not_seen.length > 0 && (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className={`${head} mr-auto`}>Not seen: {p.not_seen.length}</h3>
                <select aria-label="Every thing not seen" value={all} onChange={(e) => { setAll(e.target.value as NotSeenChoice | ""); setNotSeen({}); }} className="min-h-11 rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 text-sm">
                  <option value="">All: as the switch says</option>
                  {NOT_SEEN.map((o) => <option key={o.value} value={o.value}>All: {o.label}</option>)}
                </select>
              </div>
              <ul className={list}>
                {p.not_seen.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 basis-full sm:basis-auto sm:flex-1">
                      <span data-recount-title className="block break-words text-content dark:text-mortar-100">{n.title}</span>
                      {n.place && <span className="block break-words text-xs text-muted dark:text-slate-400">{n.place}</span>}
                    </span>
                    <select aria-label={`What to do with ${n.title}`} value={n.choice} onChange={(e) => setNotSeen((m) => ({ ...m, [n.id]: e.target.value as NotSeenChoice }))} className="min-h-11 rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 text-sm">
                      {NOT_SEEN.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-sm text-content dark:text-mortar-100" data-testid="recount-plan-line">
              {[
                p.counts.moved ? `${p.counts.moved} moved` : null,
                p.counts.counted ? `${p.counts.counted} recounted` : null,
                p.counts.added ? `${p.counts.added} added` : null,
                p.counts.gone ? `${countOf(p.counts.gone, "thing")} marked gone` : null,
                p.counts.later ? `${p.counts.later} to check later` : null,
              ].filter(Boolean).join(", ") || "Nothing changes"}
            </span>
            <button type="button" onClick={onClose} className="min-h-11 rounded-md border border-line dark:border-slate-600 px-3 text-sm">Keep counting</button>
            <button type="button" disabled={busy || plan.isFetching} onClick={() => void apply()} className="min-h-11 rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 px-4 text-sm font-medium text-white">
              {busy ? "Applying…" : "Apply"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
