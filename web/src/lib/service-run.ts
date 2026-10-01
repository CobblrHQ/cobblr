// How a service run reads to a person (services.md S9): the words for a
// run's state, for what a step waits on, and which buttons a stuck step
// offers. Pure, so the page and its test read the same rules.
import type { ServiceRun, ServiceRunStep } from "./api";

export const RUN_STATE_WORD: Record<ServiceRun["state"], string> = {
  stuck: "Stuck",
  waiting: "Waiting for you",
  running: "Running",
  failed: "Stopped",
  done: "Done",
  cancelled: "Cancelled",
};

export const STEP_STATUS_WORD: Record<string, string> = {
  awaiting_confirm: "Waiting for your yes",
  queued: "Queued",
  running: "Running",
  needs_input: "Asking you something",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const hm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function when(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? hm(iso) : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm(iso)}`;
}

/** One line: what this step is waiting on, or how it ended. */
export function stepLine(step: ServiceRunStep, now: Date = new Date()): string {
  const w = step.waiting_on;
  if (w?.kind === "yes") return `Waiting for your yes since ${when(w.since, now)}. Cancelled at ${when(w.expires_at, now)} if nobody says yes.`;
  if (w?.kind === "answer") return `Waiting for your answer since ${when(w.since, now)}.`;
  if (w?.kind === "service") {
    if (w.stalled) return `${w.label} has not moved since ${when(w.since, now)}. Checking on it.`;
    return `${w.label} is working on it${w.deadline_at ? `, usually done by ${when(w.deadline_at, now)}` : ""}.`;
  }
  if (step.skipped) return "Skipped: the run went on without its answer.";
  if (step.retried_by) return "Tried again below.";
  if (step.status === "failed") return step.error?.message ?? "It failed.";
  if (step.status === "cancelled") return step.error?.message && step.error.code !== "x-cancelled" ? step.error.message : "Cancelled.";
  if (step.status === "done") return step.finished_at ? `Finished at ${when(step.finished_at, now)}.` : "Finished.";
  return STEP_STATUS_WORD[step.status] ?? step.status;
}

export type StepButton = "retry" | "skip" | "yes";

/** What a person can do about this step, from the run page. */
export function stepButtons(step: ServiceRunStep): StepButton[] {
  if (step.status === "awaiting_confirm") return ["yes"];
  if ((step.status === "failed" || step.status === "cancelled") && !step.retried_by && !step.skipped) {
    return step.can_skip ? ["retry", "skip"] : ["retry"];
  }
  return [];
}

/** Whether the run can still be cancelled: something in it is not finished. */
export function runCancellable(run: ServiceRun): boolean {
  return run.state === "stuck" || run.steps.some((s) => !["done", "failed", "cancelled"].includes(s.status));
}
