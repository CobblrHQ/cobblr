// /stocktakes/:id: one "What's still here?" run, where its activity line opens.
// What it kept, what it marked gone and what it counted, and its Undo, which
// stays here after the toast that first offered it is gone.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { usePageTitle, useRunAction, useToast, useUnits } from "@cobblr/platform-web";
import { countOf } from "@cobblr/platform-contract/plural";
import { ApiError, api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { QueryError } from "../components/QueryError";

export function StocktakePage() {
  const { id = "" } = useParams();
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  // PRESS-ARGS: Undo needs only this stocktake's id, which the page has.
  const runAction = useRunAction();
  const units = useUnits();
  const q = useQuery({ queryKey: ["stocktake", activeSlug, id], queryFn: () => api.stocktake(activeSlug, id), enabled: !!id });
  usePageTitle(q.data ? `Stocktake of ${q.data.label}` : "Stocktake");
  if (q.isError) return <QueryError what="this stocktake" onRetry={() => void q.refetch()} />;
  if (!q.data) return <p className="text-sm text-muted">Reading the stocktake…</p>;
  const t = q.data;

  const undo = async () => {
    try {
      // The one argument the undo needs is this stocktake's id.
      // OWN-WAY-BACK: the stocktake's own row is marked undone once; a second press is refused.
      await runAction({ actionId: "inventory:undo-stocktake", args: { stocktake_id: t.id } }, { undo: "is-undo" });
      void qc.invalidateQueries({ queryKey: ["stocktake", activeSlug, id] });
      toast.success(`Put ${t.label} back as it was.`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
    }
  };

  const section = (title: string, rows: Array<{ id: string; title: string; note?: string }>) =>
    rows.length ? (
      <section className="space-y-1">
        <h2 className="text-[10px] uppercase tracking-widest text-accent">{title}</h2>
        <ul className="divide-y divide-line dark:divide-slate-800 rounded-md border border-line dark:border-slate-700">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap gap-x-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-content dark:text-mortar-100">{r.title}</span>
              {r.note && <span className="font-mono text-xs text-muted dark:text-slate-400">{r.note}</span>}
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4" data-testid="stocktake-page">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100">Stocktake of {t.label}</h1>
        <p className="text-sm text-muted dark:text-slate-400">
          {new Date(t.created_at).toLocaleString()}: {countOf(t.kept.length + t.counted.length, "thing")} kept, {t.gone.length} marked gone.
          {t.undone_at ? ` Undone ${new Date(t.undone_at).toLocaleString()}.` : ""}
        </p>
      </div>
      {!t.undone_at && (
        <button type="button" onClick={() => void undo()} className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm" data-testid="undo-stocktake">
          Undo this stocktake
        </button>
      )}
      {section("Marked gone", t.gone.map((g) => ({ id: g.id, title: g.title, note: "gone, not recorded how" })))}
      {section("Counted", t.counted.map((c) => ({ id: c.id, title: c.title, note: `${units.format(c.after, c.unit)} left, was ${units.format(c.before, c.unit)}` })))}
      {section("Still here", t.kept)}
    </div>
  );
}
