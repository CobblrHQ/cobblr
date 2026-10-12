// /services/runs and /services/runs/:id: the Services supervisor's view
// (services.md S9). A run is the chain of jobs one job started (a slice, then
// the print it led to). The list puts stuck and waiting runs first; a run's
// page shows every step, what it waits on, and the buttons to decide about a
// stuck one: the same Retry, Skip and Cancel its notice carries.
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { useToast, usePageTitle, runAction, offerUndo, type ActionRun } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { QueryError } from "../components/QueryError";
import { api, ApiError, type ServiceRun, type ServiceRunStep } from "../lib/api";
import { RUN_STATE_WORD, STEP_STATUS_WORD, runCancellable, stepButtons, stepLine } from "../lib/service-run";

const runKey = (slug: string, id: string) => ["service-run", slug, id] as const;
const runsKey = (slug: string) => ["service-runs", slug] as const;
const LIVE = new Set<ServiceRun["state"]>(["running", "waiting", "stuck"]);

function StateChip({ state }: { state: ServiceRun["state"] }) {
  const tone =
    state === "stuck"
      ? "border-ember-300 text-ember-700 dark:border-ember-700 dark:text-ember-300"
      : state === "waiting"
        ? "border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300"
        : "border-line text-muted dark:border-slate-700";
  return <span className={`text-[11px] rounded px-1.5 py-px border whitespace-nowrap ${tone}`}>{RUN_STATE_WORD[state]}</span>;
}

export function ServiceRunsPage() {
  usePageTitle("Service runs");
  const { activeSlug } = useActiveOrg();
  const q = useQuery({
    queryKey: runsKey(activeSlug),
    queryFn: () => api.listServiceRuns(activeSlug),
    enabled: !!activeSlug,
    refetchInterval: (r) => (r.state.data?.items.some((x) => LIVE.has(x.state)) ? 10_000 : false),
  });
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100">Service runs</h1>
        <p className="text-sm text-muted mt-0.5">
          Every job an outside service did here, with the steps that followed from it. A run that is stuck or waiting for you comes first.
        </p>
      </div>
      {q.isError && <QueryError what="the runs" onRetry={() => void q.refetch()} />}
      {q.isSuccess && items.length === 0 && (
        <p className="text-sm text-faint rounded-xl border border-dashed border-line dark:border-slate-700 p-4">No service has done anything here yet.</p>
      )}
      <ul className="space-y-2" data-testid="service-runs">
        {items.map((r) => {
          const first = r.steps[0];
          return (
            <li key={r.root_id}>
              <Link
                to={`/services/runs/${r.root_id}`}
                className="block rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 hover:border-accent/60 transition"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-content dark:text-mortar-100 truncate">{first?.title ?? "A service job"}</span>
                  {r.steps.length > 1 && <span className="text-[11px] text-faint whitespace-nowrap">{r.steps.length} steps</span>}
                  <span className="flex-1" />
                  <StateChip state={r.state} />
                </div>
                <p className="text-xs text-muted mt-1 line-clamp-2">{r.summary}</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ServiceRunPage() {
  const { id = "" } = useParams();
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({
    queryKey: runKey(activeSlug, id),
    queryFn: () => api.getServiceRun(activeSlug, id),
    enabled: !!activeSlug && !!id,
    refetchInterval: (r) => (r.state.data && LIVE.has(r.state.data.state) ? 5000 : false),
  });
  const run = q.data;
  usePageTitle(run?.steps[0]?.title ?? "Service run");

  const act = useMutation({
    mutationFn: async ({ what, jobId }: { what: "retry" | "skip" | "yes" | "cancel"; jobId: string }) => {
      setBusy(`${what}:${jobId}`);
      if (what === "yes") return api.confirmServiceJob(activeSlug, jobId);
      const actionId = what === "retry" ? "platform:retry-service-job" : what === "skip" ? "platform:skip-service-job" : "platform:cancel-service-run";
      // PRESS-ARGS: the step's job id is the only argument these three actions take, and the row carries it
      return runAction(api, qc, activeSlug, { actionId, entityKind: "", entityId: "", args: { job_id: jobId } });
    },
    onSuccess: (r, v) => {
      const said = v.what === "retry" ? "Started again." : v.what === "skip" ? "Skipped; the run goes on." : v.what === "yes" ? "Started." : "Run cancelled.";
      // An Undo the action hands back is offered with it (#5812).
      // PRESS-ARGS: Undo runs the action's own steps, each carrying its arguments.
      if (v.what === "yes" || !offerUndo(toast, (b) => runAction(api, qc, activeSlug, b), r as ActionRun, {}, said)) toast.success(said);
      void qc.invalidateQueries({ queryKey: runKey(activeSlug, id) });
      void qc.invalidateQueries({ queryKey: runsKey(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError || e instanceof Error ? e.message : "That did not go through."),
    onSettled: () => setBusy(null),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <Link to="/services/runs" className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent">
        <ChevronLeft size={16} /> Service runs
      </Link>
      {q.isError && <QueryError what="this run" onRetry={() => void q.refetch()} />}
      {run && (
        <>
          <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
            <div className="flex items-start gap-2">
              <h1 className="text-lg font-semibold text-content dark:text-mortar-100 flex-1 min-w-0">{run.steps[0]?.title ?? "Service run"}</h1>
              <StateChip state={run.state} />
            </div>
            <p className="text-sm text-muted mt-1" data-testid="run-summary">
              {run.summary}
            </p>
            {runCancellable(run) && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => act.mutate({ what: "cancel", jobId: run.root_id })}
                className="mt-3 text-sm px-3 py-1.5 rounded-lg border border-line dark:border-slate-700 text-ember-700 dark:text-ember-300 hover:bg-subtle disabled:opacity-50"
              >
                Cancel the run
              </button>
            )}
          </div>
          <ol className="space-y-2" data-testid="run-steps">
            {run.steps.map((s, i) => (
              <Step key={s.id} step={s} n={i + 1} busy={busy} onAct={(what) => act.mutate({ what, jobId: s.id })} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function Step({ step, n, busy, onAct }: { step: ServiceRunStep; n: number; busy: string | null; onAct: (what: "retry" | "skip" | "yes") => void }) {
  const buttons = stepButtons(step);
  const failed = step.status === "failed" && !step.retried_by && !step.skipped;
  return (
    <li
      className={`rounded-xl border bg-surface dark:bg-slate-900 p-3 ${failed ? "border-ember-300 dark:border-ember-800" : "border-line dark:border-slate-700"}`}
      data-step={step.id}
      data-status={step.status}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[11px] font-mono text-faint">{n}</span>
        <span className="font-medium text-content dark:text-mortar-100 truncate">{step.title}</span>
        <span className="flex-1" />
        <span className="text-[11px] rounded px-1.5 py-px border border-line dark:border-slate-700 text-muted whitespace-nowrap">
          {step.skipped ? "Skipped" : STEP_STATUS_WORD[step.status] ?? step.status}
        </span>
      </div>
      <div className="text-[11px] text-faint mt-0.5">
        {step.answered_by ?? "Not routed yet"}
        {step.origin === "wire" ? " · started by an automation" : step.origin === "cobb" ? " · started by Cobb" : ""}
        {step.attempt > 0 ? ` · handed on ${step.attempt}×` : ""}
      </div>
      <p className="text-sm text-muted mt-1.5">{stepLine(step)}</p>
      {(step.status === "running" || step.status === "queued") && typeof step.progress === "number" && (
        <div className="mt-2 h-1.5 rounded bg-subtle dark:bg-slate-800 overflow-hidden" aria-label="Progress">
          <div className="h-full bg-cobble-500" style={{ width: `${Math.round(Math.min(1, Math.max(0, step.progress)) * 100)}%` }} />
        </div>
      )}
      {buttons.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {buttons.map((b) => (
            // COLOUR-NOT-STATE: a primary action beside a secondary one, not a pick.
            <button
              key={b}
              type="button"
              disabled={!!busy}
              onClick={() => onAct(b)}
              className={
                b === "skip"
                  ? "text-sm px-3 py-1.5 rounded-lg border border-line dark:border-slate-700 hover:bg-subtle disabled:opacity-50"
                  : "text-sm px-3 py-1.5 rounded-lg bg-cobble-600 text-white disabled:opacity-60"
              }
            >
              {b === "retry" ? "Retry" : b === "skip" ? "Skip this step" : "Yes, start it"}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
