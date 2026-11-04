// A place's stored floor plan that isn't one. The doors refuse such a plan, but
// an older build could store one, and a reader must never trust the store: the
// page draws what can be drawn and says so here, with the way out.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { editOf, useConfirm, useToast } from "@cobblr/platform-web";
import { jsonbPatchBetween } from "@cobblr/platform-contract/jsonb-merge";
import { planProblem, repairedPlan } from "@cobblr/platform-contract/plan-clearance";
import { api, ApiError, type Location } from "../lib/api";

export function DamagedPlanNotice({ slug, place }: { slug: string; place: Location }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const stored = place.metadata?.floorplan;
  const problem = planProblem(stored);
  const reset = useMutation({
    mutationFn: () => {
      const metadata = { ...place.metadata, floorplan: repairedPlan(stored) };
      return api.updateLocation(slug, place.id, editOf(place, { metadata: jsonbPatchBetween(place.metadata, metadata) }));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
      void qc.invalidateQueries({ queryKey: ["location", slug, place.id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  if (!problem) return null;
  return (
    <div role="alert" data-testid="damaged-plan" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-content dark:text-slate-200">
      <AlertTriangle size={16} className="shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
      <span className="min-w-0 flex-1">This plan is damaged: {problem}. What can still be drawn is shown.</span>
      <button
        type="button"
        disabled={reset.isPending}
        onClick={async () => {
          const ok = await confirm({ title: "Reset this plan?", message: `What can't be drawn is removed from ${place.name}'s plan. Everything that can be drawn stays.`, confirmLabel: "Reset it", destructive: true });
          if (ok) reset.mutate();
        }}
        className="min-h-[44px] sm:min-h-0 rounded border border-line dark:border-slate-600 px-2 py-0.5 hover:border-accent hover:text-accent disabled:opacity-50"
      >
        Reset it
      </button>
    </div>
  );
}
