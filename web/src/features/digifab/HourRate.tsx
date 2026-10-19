import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRunAction, useToast } from "@cobblr/platform-web";
import { centsFromAmount, formatMoney } from "@cobblr/platform-contract/money";

/** What an hour of a printer, or of every printer in a pool, costs: added to
 *  each finished print's filament when the print is priced. Empty removes it. */
export function HourRateEditor({ slug, target, current }: { slug: string; target: { printer: string } | { pool: string }; current: { amount: number; currency: string } | null }) {
  // PRESS-ARGS: the press carries the printer or pool it was drawn for and the rate typed beside it; empty is the action's own "remove".
  const run = useRunAction();
  const qc = useQueryClient();
  const toast = useToast();
  const [rate, setRate] = useState(current ? String(current.amount) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const out = await run({ actionId: "digifab:set-machine-hour-rate", args: { ...target, rate: rate.trim() } });
      const result = out.result as { ok?: boolean; error?: string; summary?: string } | null;
      if (!result?.ok) throw new Error(result?.error || "The hour rate was not changed.");
      if (result.summary) toast.success(result.summary);
      void qc.invalidateQueries({ queryKey: ["digifab-fleet", slug] });
      void qc.invalidateQueries({ queryKey: ["digifab-pools", slug] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <label className="flex items-center gap-1.5 text-faint">
          Hour rate
          <input
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder={current ? formatMoney(centsFromAmount(current.amount), { currency: current.currency }) : "none"}
            className="w-20 px-1.5 py-0.5 border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900 text-content dark:text-mortar-100"
          />
        </label>
        <button type="button" onClick={() => void save()} disabled={busy || rate.trim() === (current ? String(current.amount) : "")} className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-1.5 py-0.5 disabled:opacity-50">Save</button>
      </div>
      {error && <p className="mt-1 text-[11px] text-ember-600 dark:text-ember-400">{error}</p>}
    </div>
  );
}
