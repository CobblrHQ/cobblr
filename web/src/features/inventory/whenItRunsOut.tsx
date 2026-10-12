// "When this runs out…" on a stock record (#6070): the wires already about
// this one record, and the way to add one, which opens the wire composer
// with the trigger (its count changes), the change (it runs out) and the
// record already chosen. Adding a wire is an owner's or admin's, as on
// /wires; anyone sees the ones there are.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { QueryError } from "@cobblr/platform-web";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { STOCK_CHANGED_EVENT, readStockChange, readWireRecords, stockChangePhrase, type NarrowingCondition } from "@cobblr/platform-contract/wire-narrowing";
import { api } from "../../lib/api";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import { wirePrefillHref } from "../../lib/wire-composer";
import type { EntityDetailPanelCtx } from "../../panels/types";

export function WhenItRunsOutPanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const { activeOrg } = useActiveOrg();
  // Making a wire is an admin's (POST /bindings requires owner or admin).
  const canAdd = roleSatisfies(activeOrg?.role, ["admin"]);
  const bindings = useQuery({ queryKey: ["bindings", ctx.slug], queryFn: () => api.listBindings(ctx.slug) });
  const actions = useQuery({ queryKey: ["actions-for-kind", ctx.slug, ctx.kind], queryFn: () => api.listActions(ctx.slug, ctx.kind!), enabled: !!ctx.kind });
  if (bindings.isError) return <QueryError what="this record's automations" onRetry={() => { void bindings.refetch(); }} />;
  const mine = (bindings.data?.items ?? []).filter((b) => {
    const f = b.filter as { in?: unknown } | null;
    return b.trigger_event === STOCK_CHANGED_EVENT && readWireRecords(f?.in)?.record === ctx.entityId;
  });
  const actionLabel = (id: string) => actions.data?.items.find((a) => a.id === id)?.label ?? id;
  const href = wirePrefillHref({
    kind: ctx.kind,
    event: STOCK_CHANGED_EVENT,
    change: { kind: "ran-out" },
    records: { record: ctx.entityId },
    recordName: ctx.entityTitle,
  });
  if (!mine.length && !canAdd) return null;
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 p-3 space-y-2" data-testid="when-it-runs-out">
      <h3 className="text-sm font-semibold">When this runs out</h3>
      {mine.length > 0 && (
        <ul className="space-y-1 text-sm">
          {mine.map((b) => {
            const change = readStockChange(((b.filter as { all?: NarrowingCondition[] } | null)?.all ?? [])).change;
            return (
              <li key={b.id} className="flex flex-wrap items-baseline gap-x-2" data-testid="when-it-runs-out-wire">
                <span className="text-muted dark:text-slate-400">When it {stockChangePhrase(change) ?? "changes"}:</span>
                <span className="min-w-0">{b.label || actionLabel(b.action_id)}</span>
                {!b.enabled && <span className="text-[11px] text-faint">(off)</span>}
              </li>
            );
          })}
        </ul>
      )}
      {canAdd && (
        <Link to={href} className="inline-block text-sm text-accent hover:underline" data-testid="when-it-runs-out-add">
          When this runs out…
        </Link>
      )}
    </section>
  );
}
