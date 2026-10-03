import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MutationError } from "@cobblr/platform-web";
import { useInventory } from "./context.js";

export function LowStockAlerts() {
  const { api, orgSlug } = useInventory();
  const qc = useQueryClient();
  const key = ["low-stock-alerts", orgSlug];
  const current = useQuery({ queryKey: key, queryFn: () => api.getLowStockAlerts() });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.setLowStockAlerts(enabled),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
  if (!current.data) return null;
  const { enabled, canManage } = current.data;
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 p-4 space-y-2" data-testid="low-stock-alerts">
      <p className="text-sm text-content dark:text-mortar-100">
        {enabled ? "Low-stock alerts are on." : "Want to hear when stock runs low?"} One daily summary, with each item's count and minimum, through your usual notification channels.
      </p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {canManage && (
          <button type="button" className="rounded-md border border-line dark:border-slate-700 px-3 py-2 text-sm font-medium text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-50" disabled={save.isPending} onClick={() => save.mutate(!enabled)}>
            {enabled ? "Turn off low-stock alerts" : "Turn on low-stock alerts"}
          </button>
        )}
        <Link to={`/w/${orgSlug}/lists`} className="text-accent hover:underline">Add running-low items to a shopping list</Link>
      </div>
      <MutationError mutation={save} />
    </div>
  );
}
