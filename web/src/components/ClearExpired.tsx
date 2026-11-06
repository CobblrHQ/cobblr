// "Clear what's past its date": one press ends everything past its date in a
// list, as used up or as thrown out, behind a confirm that names the records
// and the units, with one Undo that puts every record back (#9274).
//
// The dashboard card and the list's own page both use this, so the two never
// disagree about what a press does. The server decides what is past its date
// and keeps any fresher lot; this asks first ("dry_run") only so the confirm
// can say what is about to happen.
import { useQuery } from "@tanstack/react-query";
import { useConfirm, useRunAction, useToast } from "@cobblr/platform-web";
import { api } from "../lib/api";

type Plan = { cleared: number; units: number; records: Array<{ id: string; name: string; units: number }> };
type Ended = "used" | "spoiled";
type UndoStep = { action_id: string; undo_id?: string; args?: Record<string, unknown> };
const undoSteps = (u: unknown): UndoStep[] => (Array.isArray(u) ? u : u ? [u] : []).filter((s): s is UndoStep => !!s && typeof (s as UndoStep).action_id === "string");

const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What would be cleared, read-only. `scope` is the records named, or the list. */
export async function lookAtClearing(slug: string, kind: string, actionId: string, scope: ClearScope): Promise<Plan> {
  const body = { actionId, entityKind: kind, args: { ...scope, timezone: timezone(), dry_run: true } };
  const res = await api.request<{ result: Plan }>("POST", `/orgs/${slug}/actions/invoke`, body);
  return res.result;
}

export type ClearScope = { partIds: string[] } | { instance: string };

const units = (n: number) => `${n} ${n === 1 ? "unit" : "units"}`;
const items = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** The names a confirm shows: the first few, then how many more. */
function namesOf(plan: Plan): string {
  const shown = plan.records.slice(0, 6).map((r) => (r.units > 1 ? `${r.name} (${r.units})` : r.name));
  const more = plan.records.length - shown.length;
  return shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

export function useClearExpired(slug: string, kind: string, actionId: string | undefined) {
  // PRESS-ARGS: the scope (the records named, or the list) and which ending; the timezone is added here.
  const runAction = useRunAction();
  const toast = useToast();
  const confirm = useConfirm();

  /** Look, ask, clear. Resolves with the records cleared (none when the person
   *  said no, or nothing was past its date), so a card can drop those rows. */
  return async (scope: ClearScope, ended: Ended): Promise<string[]> => {
    if (!actionId) return [];
    let plan: Plan;
    try {
      plan = await lookAtClearing(slug, kind, actionId, scope);
    } catch (err) {
      toast.error((err as Error).message);
      return [];
    }
    if (plan.cleared === 0) {
      toast.info("Nothing is past its date.");
      return [];
    }
    const verb = ended === "used" ? "used up" : "thrown out";
    const ok = await confirm({
      title: `${ended === "used" ? "Used up" : "Throw out"} ${items(plan.cleared)} past their date?`,
      message: `${namesOf(plan)}: ${units(plan.units)} in all, recorded as ${verb}. Anything newer than its date stays. Each record keeps its history, and Undo puts it all back.`,
      confirmLabel: ended === "used" ? `Used up ${units(plan.units)}` : `Throw out ${units(plan.units)}`,
      destructive: ended === "spoiled",
    });
    if (!ok) return [];
    try {
      const run = await runAction({ actionId, entityKind: kind, args: { ...scope, ended, timezone: timezone() } }, { undo: "shown-here" });
      const result = run.result as { summary?: string; records?: Array<{ id: string }>; skipped?: unknown[] };
      const undo = undoSteps(run.undo);
      toast.action(result.summary ?? `Cleared ${items(plan.cleared)}.`, {
        actionLabel: "Undo",
        duration: 10000,
        onAction: async () => {
          for (const step of undo) await runAction({ actionId: step.action_id, entityKind: kind, undo_id: step.undo_id, args: step.args ?? {} }, { undo: "is-undo" });
        },
      });
      if (result.skipped?.length) toast.error(`${items(result.skipped.length)} could not be changed and stay as they were.`);
      return (result.records ?? []).map((r) => r.id);
    } catch (err) {
      toast.error((err as Error).message);
      return [];
    }
  };
}

/** The list's own page: says how much is past its date, with the two ways to
 *  clear it. Renders nothing when nothing is. */
export function ClearExpiredBar({ slug, instance, kind, actionId }: { slug: string; instance: string; kind: string; actionId: string }) {
  const clear = useClearExpired(slug, kind, actionId);
  const plan = useQuery({
    queryKey: ["clear-expired-plan", slug, instance],
    queryFn: () => lookAtClearing(slug, kind, actionId, { instance }),
    staleTime: 30_000,
    retry: false,
  });
  if (!plan.data || plan.data.cleared === 0) return null;
  const go = async (ended: Ended) => {
    await clear({ instance }, ended);
    await plan.refetch();
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-red-300 dark:border-red-800 bg-red-50/70 dark:bg-red-950/20 px-3 py-2 text-sm" data-testid="clear-expired-bar">
      <span className="min-w-0 flex-1 basis-52 text-content dark:text-mortar-100">
        <strong>{items(plan.data.cleared)}</strong> past their date ({units(plan.data.units)}).
      </span>
      <span className="flex items-center gap-3">
        <button type="button" onClick={() => void go("used")} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90" data-testid="clear-expired-used">
          Used up
        </button>
        <button type="button" onClick={() => void go("spoiled")} className="rounded-md border border-red-300 dark:border-red-700 px-3 py-1.5 text-xs font-medium text-ember-700 dark:text-ember-400 hover:bg-red-100/60 dark:hover:bg-red-900/20" data-testid="clear-expired-tossed">
          Threw out
        </button>
      </span>
    </div>
  );
}
