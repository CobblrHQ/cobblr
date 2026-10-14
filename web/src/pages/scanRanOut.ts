// Ran out on a scan row (#6526): "I just ran out of this, Cobblr doesn't know
// about it yet, and I have yet to get more." What it does is one contract
// rule, ranOutPlan: a thing you keep goes to none through Used it up (the
// attach count), anything else is added with none on hand (confirm). Both
// put it on the shopping list server-side, and Undo is the row's own
// unconfirm. One hook for the card, the camera and the station.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { ranOutPlan, type RanOutPlan, type ScanRowStateContext } from "@cobblr/platform-contract/scan-triage";
import { api, ApiError, type ScanInboxItem, type ScanMenuEntry, type ScanRanOutAnswer } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { scanInboxKeys } from "../lib/scan-inbox-keys";
import { baseKind, destinationCandidateOf } from "./scanFileAll";
import { resolveInstanceForFiling } from "./scanInstall";

/** The plan for this row, as the person sees it: where it would go and
 *  whether that table keeps a count (a table the menu marks one-of-a-kind
 *  does not; one not installed yet is judged by the server). */
export function ranOutPlanFor(item: ScanInboxItem, viewer: ScanRowStateContext, menu: readonly ScanMenuEntry[] | null | undefined): RanOutPlan {
  const cand = destinationCandidateOf(item, viewer);
  const entry = cand ? (menu ?? []).find((m) => m.module === cand.module && (m.instance ?? null) === (cand.instance ?? null)) : undefined;
  return ranOutPlan(item as never, cand ? { counted: entry ? !entry.unique : true } : null);
}

function listWords(a: ScanRanOutAnswer | undefined): string {
  if (a?.on_list) return " · on the shopping list";
  if (a?.needs_list) return " · choose a shopping list for it";
  return "";
}

export function useRanOut(item: ScanInboxItem | null, viewer: ScanRowStateContext, menu: readonly ScanMenuEntry[] | null | undefined, onDone?: () => void) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const plan: RanOutPlan = item ? ranOutPlanFor(item, viewer, menu) : { kind: "none", why: "nothing scanned yet" };
  const run = useMutation({
    mutationFn: async (): Promise<string> => {
      if (!item) throw new Error("Nothing scanned yet");
      if (plan.kind === "take") {
        const m = plan.match;
        const r = await api.scanAttach(activeSlug, item.id, { kind: m.kind!, entity_id: m.id!, ...(m.instance ? { instance: m.instance } : {}), mode: "count", ran_out: true });
        return `${r.entity_title} is at none now${listWords(r.ran_out)}`;
      }
      if (plan.kind === "add") {
        const cand = destinationCandidateOf(item, viewer)!;
        const bundle = (cand as { bundle_external_id?: string | null }).bundle_external_id ?? null;
        const instance = bundle ? await resolveInstanceForFiling(activeSlug, bundle, cand.instance ?? null) : (cand.instance ?? null);
        const r = await api.confirmScanItem(activeSlug, item.id, {
          target_module: cand.module,
          target_kind: baseKind(cand.module),
          ...(instance ? { instance } : {}),
          ...(item.suggested_name ? { name: item.suggested_name } : {}),
          extras: { ...(cand.fields ?? {}) },
          ran_out: true,
        });
        return `Added ${item.suggested_name ?? "it"} with none on hand${listWords(r.ran_out)}`;
      }
      throw new Error(plan.why);
    },
    onSuccess: (said) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.action(said, {
        actionLabel: "Undo",
        duration: 10_000,
        onAction: async () => {
          try {
            if (!item) return;
            const back = await api.unconfirmScanItem(activeSlug, item.id);
            void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
            toast.success(back.note ?? "Put back as it was");
          } catch (e) {
            toast.error(e instanceof ApiError ? e.message : String(e));
          }
        },
      });
      onDone?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return { plan, offered: plan.kind !== "none", run: () => run.mutate(), pending: run.isPending, error: run.error };
}

/** The words every surface uses for it. */
export const RAN_OUT_LABEL = "Ran out";
export const RAN_OUT_HINT = "You have none now: keep it at 0 and put it on the shopping list";
