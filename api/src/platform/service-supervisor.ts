// The Services supervisor (services.md S9): something watching the chain, not
// only the single job.
//
// The kernel handles one job's failure (a retryable service falls through, a
// restart resumes, an unconfirmed job expires). Nothing saw a RUN: a service
// that says `running` forever, a confirm card nobody opened, a question nobody
// answered, a wire that should have started the next step and did not. One
// sweep, registered with platform().sweeps, looks at every job still moving
// and every finished one whose next step it has not checked:
//
//   - a job that has not moved for SERVICE_STALL_NO_CHANGE_MS, or has run past
//     its deadline (3x the capability's typical_seconds), is polled once more;
//     still stuck at the next look, it is handed on to the next service in the
//     order or failed with error `stalled` (services.ts handOn);
//   - a yes nobody gave is raised again before it expires, and a question
//     nobody answered after a day, each once;
//   - a step that failed where nobody was watching, or a done step whose wire
//     should have started the next one and did not, makes the run STUCK: one
//     notice per run, in the bell and on Discord, with Retry, Skip this step
//     (only where the next step can take the answer as absent) and Cancel.
//
// The watch list is `service_watched_jobs` in meta, kept by the job events, so
// a round opens only the workspaces with something to watch.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import {
  SERVICE_CONFIRM_TTL_MS,
  SERVICE_NEEDS_INPUT_TTL_MS,
  SERVICE_STALL_NO_CHANGE_MS,
  TERMINAL_JOB_STATUSES,
  type ServiceError,
  type ServiceRun,
  type ServiceRunStep,
  type ServiceRunWait,
  type StuckNotice,
} from "@cobblr/platform-contract/services";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import { raiseJobCard, settleJobCards, type JobCardAction } from "./service-cards.js";
import { CONFIRM_SERVICE_ACTION, confirmersOf } from "./service-confirm.js";
import { answererOf, handOn, nudgeStalled, runRows, setServiceSupervisor, skippable, type JobsTable } from "./services.js";
import { parseWireFilter, passesWireFilter } from "./wire-filter.js";
import { notePassFailure } from "./pass-failures.js";

export const SUPERVISOR_PASS = "platform.services-supervisor";
export const RETRY_SERVICE_ACTION = "platform:retry-service-job";
export const SKIP_SERVICE_ACTION = "platform:skip-service-job";
export const CANCEL_SERVICE_RUN_ACTION = "platform:cancel-service-run";
const STUCK_EVENT = "platform.service.stuck";
const LATE_EVENT = "platform.service.waiting_long";

/** A nudged job gets this long to move before it is handed on. */
const NUDGE_GRACE_MS = 2 * 60_000;
/** A yes is asked for again this long before it expires. */
const REMIND_BEFORE_EXPIRY_MS = 4 * 3600_000;
/** A question is asked again after it has waited this long. */
const ANSWER_REMIND_AFTER_MS = 24 * 3600_000;
/** A wire gets this long to start the next step before it is missed. */
const NEXT_STEP_GRACE_MS = 2 * 60_000;

const tdb = async (orgId: string) => (await getTenantDb(orgId)) as unknown as Kysely<{ core_services_jobs: JobsTable }>;

export const runLink = (rootId: string) => `/services/runs/${rootId}`;

const at = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
/** A span as people say it. Never a clock time: the server does not know
 *  the reader's timezone (the page shows times in theirs). */
export function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

// ── The watch list ──────────────────────────────────────────────────────

async function watch(orgId: string, jobId: string, status: string): Promise<void> {
  await meta
    .insertInto("service_watched_jobs")
    .values({ org_id: orgId, job_id: jobId, status })
    .onConflict((oc) =>
      oc.columns(["org_id", "job_id"]).doUpdateSet((eb) => ({
        status,
        // The clock restarts when the status changes, not on every event.
        since: eb.case().when("service_watched_jobs.status", "=", status).then(eb.ref("service_watched_jobs.since")).else(new Date()).end(),
      })),
    )
    .execute();
}

async function unwatch(orgId: string, jobId: string): Promise<void> {
  await meta.deleteFrom("service_watched_jobs").where("org_id", "=", orgId).where("job_id", "=", jobId).execute();
}

// ── The run ─────────────────────────────────────────────────────────────

async function stuckCardLive(orgId: string, rootId: string): Promise<boolean> {
  const r = await meta
    .selectFrom("service_job_cards")
    .select("job_id")
    .where("org_id", "=", orgId)
    .where("job_id", "=", rootId)
    .where("kind", "=", "stuck")
    .where("settled_at", "is", null)
    .executeTakeFirst();
  return !!r;
}

function waitOf(row: JobsTable, answeredBy: string | null): ServiceRunWait {
  const created = new Date(row.created_at);
  switch (row.status) {
    case "awaiting_confirm":
      return { kind: "yes", since: created.toISOString(), expires_at: new Date(created.getTime() + SERVICE_CONFIRM_TTL_MS).toISOString() };
    case "needs_input":
      return { kind: "answer", since: new Date(row.updated_at).toISOString() };
    case "queued":
    case "running":
      return {
        kind: "service",
        label: answeredBy ?? "the service",
        since: new Date(row.last_progress_at ?? row.updated_at).toISOString(),
        stalled: !!row.stalled_at,
        deadline_at: at(row.deadline_at),
      };
    default:
      return null;
  }
}

/** A step that ended without an answer and nobody has dealt with: no retry
 *  of it is going, and it was not skipped. */
function unhandledFailure(row: JobsTable, rows: JobsTable[]): boolean {
  if (row.status !== "failed" || row.skipped_at) return false;
  return !rows.some((r) => r.retry_of === row.id);
}

export async function buildRun(orgId: string, jobId: string): Promise<ServiceRun | null> {
  const rows = await runRows(orgId, jobId);
  const root = rows.find((r) => !r.caused_by_job && !r.retry_of) ?? rows[0];
  if (!root) return null;
  const steps: ServiceRunStep[] = [];
  for (const r of rows) {
    const who = await answererOf(r);
    steps.push({
      id: r.id,
      capability: r.capability,
      title: who?.title ?? r.capability,
      status: r.status,
      answered_by: who?.label ?? null,
      origin: r.origin,
      caused_by_job: r.caused_by_job,
      hop: r.hop,
      attempt: r.attempt,
      progress: r.progress,
      message: r.skipped_at ? "Skipped by a person; the run went on without its answer." : r.message,
      error: (r.error as ServiceError | null) ?? null,
      waiting_on: waitOf(r, who?.label ?? null),
      retried_by: rows.find((x) => x.retry_of === r.id)?.id ?? null,
      skipped: !!r.skipped_at,
      can_skip: unhandledFailure(r, rows) && (await skippable(orgId, r.id)),
      created_at: new Date(r.created_at).toISOString(),
      finished_at: at(r.finished_at),
    });
  }
  const stuck = await stuckCardLive(orgId, root.id);
  const live = rows.filter((r) => !TERMINAL_JOB_STATUSES.has(r.status));
  const failedOpen = rows.filter((r) => unhandledFailure(r, rows));
  const waiting = live.find((r) => r.status === "awaiting_confirm" || r.status === "needs_input");
  const state: ServiceRun["state"] = stuck
    ? "stuck"
    : waiting
      ? "waiting"
      : live.length
        ? "running"
        : failedOpen.length
          ? "failed"
          : rows.every((r) => r.status === "done" || r.skipped_at || rows.some((x) => x.retry_of === r.id))
            ? "done"
            : "cancelled";
  const titleOf = (id: string) => steps.find((s) => s.id === id)?.title ?? "a step";
  const summary =
    state === "stuck" && failedOpen[0]
      ? `Stuck at ${titleOf(failedOpen[0].id)}: ${(failedOpen[0].error as ServiceError | null)?.message ?? "it stopped"}`
      : state === "stuck"
        ? "Stuck: the next step never started."
        : waiting?.status === "awaiting_confirm"
          ? `Waiting for your yes to ${titleOf(waiting.id)}.`
          : waiting
            ? `Waiting for your answer to ${titleOf(waiting.id)}.`
            : live[0]
              ? `${titleOf(live[0].id)} is ${live[0].status === "queued" ? "queued" : "running"}.`
              : state === "done"
                ? `Done: ${steps.length} step${steps.length === 1 ? "" : "s"}.`
                : state === "failed"
                  ? `Stopped at ${titleOf(failedOpen[0]!.id)}.`
                  : "Cancelled.";
  const last = rows.reduce((m, r) => Math.max(m, new Date(r.updated_at).getTime()), 0);
  return { root_id: root.id, state, summary, steps, started_at: new Date(root.created_at).toISOString(), updated_at: new Date(last).toISOString() };
}

// ── Notices ─────────────────────────────────────────────────────────────

async function raiseStuck(n: StuckNotice): Promise<void> {
  await raiseJobCard({
    orgId: n.orgId,
    jobId: n.subjectId,
    kind: "stuck",
    userIds: n.userIds ?? (await confirmersOf(n.orgId, null)),
    eventType: STUCK_EVENT,
    message: n.message,
    heading: n.heading,
    body: n.body,
    ...(n.context ? { context: n.context } : {}),
    ...(n.link ? { link: n.link } : {}),
    actions: (n.actions ?? []) as JobCardAction[],
  });
}

async function settleStuck(orgId: string, subjectId: string): Promise<void> {
  await settleJobCards(orgId, subjectId, "stuck");
}

/** Tell the run's person (or the workspace's owners and admins, for a run an
 *  automation started) that it is stuck, once. */
async function noticeStuckRun(orgId: string, stuckJobId: string, why: string): Promise<void> {
  const run = await buildRun(orgId, stuckJobId);
  if (!run) return;
  const root = run.steps.find((s) => s.id === run.root_id)!;
  const step = run.steps.find((s) => s.id === stuckJobId);
  const rootRow = (await runRows(orgId, run.root_id)).find((r) => r.id === run.root_id);
  const actions: JobCardAction[] = [];
  if (step && (step.status === "failed" || step.status === "cancelled")) {
    actions.push({ id: "retry", label: "Retry", action: RETRY_SERVICE_ACTION, args: { job_id: step.id }, style: "primary" });
    if (await skippable(orgId, step.id)) actions.push({ id: "skip", label: "Skip this step", action: SKIP_SERVICE_ACTION, args: { job_id: step.id }, style: "secondary" });
  }
  actions.push({ id: "cancel", label: "Cancel", action: CANCEL_SERVICE_RUN_ACTION, args: { job_id: run.root_id }, style: "danger" });
  const stepTitle = step?.title ?? "a step";
  await raiseStuck({
    orgId,
    subjectId: run.root_id,
    heading: run.steps.length > 1 ? `${root.title} is stuck at ${stepTitle}` : `${stepTitle} is stuck`,
    body: why,
    message: `${root.title} is stuck: ${why}`,
    context: `Started ${span(Date.now() - new Date(root.created_at).getTime())} ago, ${run.steps.length} step${run.steps.length === 1 ? "" : "s"} so far.`,
    link: runLink(run.root_id),
    actions,
    userIds: await confirmersOf(orgId, rootRow?.requested_by ?? null),
  });
}

async function remind(orgId: string, row: JobsTable, kind: "yes_late" | "answer_late", now: Date): Promise<void> {
  const who = await answererOf(row);
  const title = who?.title ?? row.capability;
  const run = await runRows(orgId, row.id);
  const root = run.find((r) => !r.caused_by_job && !r.retry_of) ?? row;
  const waited = span(now.getTime() - new Date(kind === "yes_late" ? row.created_at : row.updated_at).getTime());
  const actions: JobCardAction[] =
    kind === "yes_late"
      ? [
          { id: "confirm", label: "Yes, start it", action: CONFIRM_SERVICE_ACTION, args: { job_id: row.id }, style: "primary" },
          { id: "cancel", label: "Cancel", action: CANCEL_SERVICE_RUN_ACTION, args: { job_id: root.id }, style: "danger" },
        ]
      : [{ id: "cancel", label: "Cancel", action: CANCEL_SERVICE_RUN_ACTION, args: { job_id: root.id }, style: "danger" }];
  const left = span(new Date(row.created_at).getTime() + SERVICE_CONFIRM_TTL_MS - now.getTime());
  await raiseJobCard({
    orgId,
    jobId: row.id,
    kind,
    userIds: await confirmersOf(orgId, row.requested_by),
    eventType: LATE_EVENT,
    message: kind === "yes_late" ? `${title} has waited ${waited} for your yes.` : `${title} has waited ${waited} for your answer.`,
    heading: kind === "yes_late" ? `${title} is still waiting for your yes` : `${title} is still waiting for your answer`,
    body:
      kind === "yes_late"
        ? `Nobody has said yes for ${waited}. It is cancelled in ${left} if nobody does.`
        : `It asked a question ${waited} ago and nothing has moved since. Answer it where it was asked, or cancel the run.`,
    link: runLink(root.id),
    actions,
    priority: "high",
  });
}

/** Whether a yes was seen: a confirm card that somebody opened. The person
 *  and Cobb doors never get a card (they had one on screen), so for those an
 *  unopened reminder is the first card. */
async function confirmSeen(orgId: string, jobId: string): Promise<boolean> {
  const r = await meta
    .selectFrom("service_job_cards as c")
    .innerJoin("notifications as n", "n.id", "c.notification_id")
    .select("c.job_id")
    .where("c.org_id", "=", orgId)
    .where("c.job_id", "=", jobId)
    .where("c.kind", "=", "confirm")
    .where("n.read_at", "is not", null)
    .executeTakeFirst();
  return !!r;
}

// ── A step that should have come next ───────────────────────────────────

/** The wires that should run a service after this job: enabled, on this
 *  job's event, running platform:invoke-service, with a condition it passes. */
async function expectedNext(orgId: string, row: JobsTable): Promise<string[]> {
  const eventName = row.skipped_at ? "services.job.done" : `services.job.${row.status}`;
  const wires = await meta
    .selectFrom("entity_action_bindings")
    .select(["id", "filter", "args"])
    .where("org_id", "=", orgId)
    .where("trigger_type", "=", "event")
    .where("trigger_event", "=", eventName)
    .where("action_id", "=", "platform:invoke-service")
    .where("enabled", "=", true)
    .execute();
  const payload = { orgId, jobId: row.id, capability: row.capability, status: row.skipped_at ? "done" : row.status, causedByJob: row.caused_by_job, hop: row.hop, name: eventName, output: row.output };
  const out: string[] = [];
  for (const w of wires) {
    if (!passesWireFilter(parseWireFilter(w.filter).filter, { event: payload })) continue;
    const cap = (w.args as { capability?: unknown } | null)?.capability;
    out.push(typeof cap === "string" ? cap : "the next service");
  }
  return out;
}

// ── One look at one workspace ───────────────────────────────────────────

export interface SuperviseResult {
  nudged: number;
  handedOn: number;
  failed: number;
  reminded: number;
  stuck: number;
}

export async function supervise(orgId: string, now: Date = new Date()): Promise<SuperviseResult> {
  const out: SuperviseResult = { nudged: 0, handedOn: 0, failed: 0, reminded: 0, stuck: 0 };
  const watched = await meta.selectFrom("service_watched_jobs").selectAll().where("org_id", "=", orgId).execute();
  if (!watched.length) return out;
  const db = await tdb(orgId);
  const rows = (await db.selectFrom("core_services_jobs").selectAll().where("id", "in", watched.map((w) => w.job_id)).execute()) as JobsTable[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const w of watched) {
    const row = byId.get(w.job_id);
    if (!row) {
      await unwatch(orgId, w.job_id);
      continue;
    }
    try {
      const t = now.getTime();
      if (row.status === "queued" || row.status === "running") {
        const moved = new Date(row.last_progress_at ?? row.updated_at).getTime();
        const why =
          row.deadline_at && t > new Date(row.deadline_at).getTime()
            ? "ran past the time it should take"
            : t - moved > SERVICE_STALL_NO_CHANGE_MS
              ? `stopped answering (nothing changed for ${Math.round((t - moved) / 60_000)} minutes)`
              : null;
        if (!why) continue;
        if (!row.stalled_at) {
          await nudgeStalled(orgId, row.id, now);
          out.nudged++;
          continue;
        }
        const stalledAt = new Date(row.stalled_at).getTime();
        if (t - stalledAt < NUDGE_GRACE_MS || moved > stalledAt) continue;
        const r = await handOn(orgId, row.id, why);
        if (r === "handed_on") out.handedOn++;
        if (r === "failed") {
          out.failed++;
          // Its failed event re-watches it; the notice goes out on the next look
          // with every other failure, or right now:
          const fresh = (await db.selectFrom("core_services_jobs").selectAll().where("id", "=", row.id).executeTakeFirst()) as JobsTable | undefined;
          if (fresh) await noticeStuckRun(orgId, row.id, (fresh.error as ServiceError | null)?.message ?? why);
          out.stuck++;
        }
        continue;
      }
      if (row.status === "awaiting_confirm") {
        const expiresAt = new Date(row.created_at).getTime() + SERVICE_CONFIRM_TTL_MS;
        if (t >= expiresAt - REMIND_BEFORE_EXPIRY_MS && t < expiresAt && !(await confirmSeen(orgId, row.id))) {
          if ((await raiseReminder(orgId, row, "yes_late", now))) out.reminded++;
        }
        continue;
      }
      if (row.status === "needs_input") {
        const since = new Date(row.updated_at).getTime();
        if (t - since >= ANSWER_REMIND_AFTER_MS && t - since < SERVICE_NEEDS_INPUT_TTL_MS) {
          if ((await raiseReminder(orgId, row, "answer_late", now))) out.reminded++;
        }
        continue;
      }
      // Finished: settle its reminders, and look for what should come next.
      await settleJobCards(orgId, row.id, "yes_late");
      await settleJobCards(orgId, row.id, "answer_late");
      const all = await runRows(orgId, row.id);
      if (row.status === "failed" && unhandledFailure(row, all)) {
        const err = row.error as ServiceError | null;
        const someoneWatching = (row.origin === "person" || row.origin === "cobb") && all.length === 1 && err?.code !== "stalled";
        if (!someoneWatching) {
          await noticeStuckRun(orgId, row.id, err?.message ?? "it failed");
          out.stuck++;
        }
        await unwatch(orgId, row.id);
        continue;
      }
      if (row.status === "done" || row.skipped_at) {
        if (t - new Date(w.since).getTime() < NEXT_STEP_GRACE_MS) continue;
        const expected = await expectedNext(orgId, row);
        const started = all.some((r) => r.caused_by_job === row.id);
        if (expected.length && !started) {
          const title = (await answererOf(row))?.title ?? row.capability;
          await noticeStuckRun(orgId, row.id, `${title} finished, but the next step (${expected.join(", ")}) never started. Its automation may have been refused; its recent activity says why.`);
          out.stuck++;
        }
      }
      await unwatch(orgId, row.id);
    } catch (err) {
      notePassFailure("services-supervisor", orgId, err);
      console.warn(`[services-supervisor] org ${orgId} job ${row.id}: ${(err as Error).message}`);
    }
  }
  return out;
}

async function raiseReminder(orgId: string, row: JobsTable, kind: "yes_late" | "answer_late", now: Date): Promise<boolean> {
  const held = await meta
    .selectFrom("service_job_cards")
    .select("job_id")
    .where("org_id", "=", orgId)
    .where("job_id", "=", row.id)
    .where("kind", "=", kind)
    .executeTakeFirst();
  if (held) return false;
  await remind(orgId, row, kind, now);
  return true;
}

/** A person's Cancel on a stuck run: every step still waiting or running is
 *  cancelled, and the run's notices are withdrawn. The number cancelled. */
export async function cancelRun(orgId: string, jobId: string, userId: string): Promise<number> {
  const rows = await runRows(orgId, jobId);
  let n = 0;
  for (const r of rows) {
    if (TERMINAL_JOB_STATUSES.has(r.status)) continue;
    await platform().services.cancel(orgId, r.id, userId);
    n++;
  }
  const root = rows.find((r) => !r.caused_by_job && !r.retry_of) ?? rows[0];
  if (root) await settleStuck(orgId, root.id);
  for (const r of rows) {
    await settleJobCards(orgId, r.id, "yes_late");
    await settleJobCards(orgId, r.id, "answer_late");
    await unwatch(orgId, r.id);
  }
  return n;
}

// ── Registration ────────────────────────────────────────────────────────

let registered = false;
/** The watch list, the sweep and the kernel hooks. Called once at boot.
 *  BORN WITH: nothing (a workspace's watch rows are written by its own job
 *  events, from its first job on; there is nothing to backfill). */
export function registerServiceSupervisor(): void {
  if (registered) return;
  registered = true;
  setServiceSupervisor({ run: buildRun, raiseStuck, settleStuck });
  platform().events.on("services.job.updated", "platform", (payload) => {
    const p = payload as { orgId?: string; jobId?: string; status?: string };
    if (!p.orgId || !p.jobId || !p.status) return;
    void watch(p.orgId, p.jobId, p.status).catch(() => {});
    // A step that moved again (a retry started, a yes arrived) is no longer
    // what its run was stuck on.
    if (p.status === "queued" || p.status === "running") void settleRunIfMoving(p.orgId, p.jobId).catch(() => {});
  });
  platform().events.on("services.job.skipped", "platform", (payload) => {
    const p = payload as { orgId?: string; jobId?: string };
    if (p.orgId && p.jobId) void watch(p.orgId, p.jobId, "skipped").catch(() => {});
  });
  platform().sweeps.register({
    name: SUPERVISOR_PASS,
    everyMs: 2 * 60_000,
    candidates: async (orgIds) => {
      if (!orgIds.length) return [];
      const rows = await meta.selectFrom("service_watched_jobs").select("org_id").distinct().where("org_id", "in", orgIds).execute();
      return rows.map((r) => r.org_id);
    },
    visit: async ({ orgId, now }) => {
      await supervise(orgId, now);
    },
  });
}

async function settleRunIfMoving(orgId: string, jobId: string): Promise<void> {
  const rows = await runRows(orgId, jobId);
  const root = rows.find((r) => !r.caused_by_job && !r.retry_of);
  if (root && !rows.some((r) => unhandledFailure(r, rows))) await settleStuck(orgId, root.id);
}
