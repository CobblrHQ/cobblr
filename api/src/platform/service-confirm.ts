// A person's yes to a service job that waits for one (services.md section 9).
//
// The gate (service-gate.ts) holds a job in `awaiting_confirm` and stores the
// hash of exactly what it would run. A yes here is bound to that: the hash is
// recomputed from the job as it stands and must match, the person saying yes
// must be the one allowed to, and the move out of `awaiting_confirm` is one
// compare-and-set, so two presses (the chat card and the Discord card) start
// it once. A job nobody answers is cancelled after SERVICE_CONFIRM_TTL_MS.
//
// A job that starts waiting where nobody is looking (a wire, module code) is
// sent to a person as a notification whose card carries the yes, the same way
// an approval request reaches its approvers.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { SERVICE_CONFIRM_TTL_MS, type ServiceDoor } from "@cobblr/platform-contract/services";
import { getTenantDb } from "../db/tenant.js";
import { meta } from "../db/meta.js";
import { raiseJobCard, settleJobCards } from "./service-cards.js";
import { onServiceConfirmTrigger, registerServiceConfirmTrigger, serviceConfirmTriggers } from "@cobblr/platform-contract/service-consent";
import { confirmHashOf, policyFor, ServiceRefused } from "./service-gate.js";
import { emit, startQueuedJob } from "./services.js";
import { ORG_ROLES, roleSatisfies } from "@cobblr/platform-contract/org-roles";

/** The action a confirm card's button runs (platform-actions.ts). */
export const CONFIRM_SERVICE_ACTION = "platform:confirm-service-job";
const WAITING_EVENT = "platform.service.awaiting_confirm";

interface JobRow {
  id: string;
  capability: string;
  status: string;
  input: unknown;
  connection_id: string | null;
  confirm_hash: string | null;
  requested_by: string | null;
  origin: ServiceDoor;
  caused_by_job: string | null;
  hop: number;
  created_at: Date;
}
interface Db {
  core_services_jobs: JobRow & { confirmed_by: string | null; updated_at: Date; finished_at: Date | null; error: unknown; message: string | null };
  core_services_job_files: { job_id: string; name: string; direction: "in" | "out"; sha256: string | null };
}
const tdb = async (orgId: string) => (await getTenantDb(orgId)) as unknown as Kysely<Db>;

const EXPIRED = { code: "confirm_expired", message: "Nobody said yes to this within a day, so it was not started.", retryable: false };

async function roleIn(orgId: string, userId: string): Promise<string | null> {
  const m = await meta.selectFrom("org_memberships").select("role").where("org_id", "=", orgId).where("user_id", "=", userId).executeTakeFirst();
  return m?.role ?? null;
}

/** Who may say yes to this job: the person who asked, for their own; an owner
 *  or admin for a job an automation started. A guest never. Exported for the
 *  cards, which are only sent to people who may press them. */
export async function mayConfirm(orgId: string, job: Pick<JobRow, "requested_by" | "capability">, userId: string): Promise<string | null> {
  const role = await roleIn(orgId, userId);
  if (!role || role === "guest") return "Only a member of this workspace can start this.";
  if (job.requested_by && job.requested_by !== userId) return "Only the person who asked for this can start it.";
  if (!job.requested_by && !roleSatisfies(role, ["admin"])) return "An automation started this, so an owner or admin says yes to it.";
  if ((await policyFor(orgId, job.capability)) === "off") return "This is turned off for this workspace.";
  return null;
}

export async function confirmServiceJob(orgId: string, jobId: string, userId: string): Promise<void> {
  const db = await tdb(orgId);
  const row = await db
    .selectFrom("core_services_jobs")
    .select(["id", "capability", "status", "input", "connection_id", "confirm_hash", "requested_by", "origin", "caused_by_job", "hop", "created_at"])
    .where("id", "=", jobId)
    .executeTakeFirst();
  if (!row) throw new ServiceRefused("not_found", "There is no such job here.");
  if (row.status !== "awaiting_confirm") throw new ServiceRefused("not_waiting", `This job is not waiting for a yes: it is ${row.status.replace("_", " ")}.`);
  if (Date.now() - new Date(row.created_at).getTime() > SERVICE_CONFIRM_TTL_MS) {
    await expireOne(orgId, db, row);
    throw new ServiceRefused("expired", EXPIRED.message);
  }
  const why = await mayConfirm(orgId, row, userId);
  if (why) throw new ServiceRefused("not_yours", why);

  // What would run, now, hashed the way the gate hashed it when it held the job.
  const files = await db.selectFrom("core_services_job_files").select(["name", "sha256"]).where("job_id", "=", jobId).where("direction", "=", "in").execute();
  const fileHashes = Object.fromEntries(files.map((f) => [f.name, f.sha256 ?? ""]));
  const now = confirmHashOf({ capability: row.capability, input: row.input ?? null, fileHashes, connectionId: row.connection_id });
  if (!row.confirm_hash || now !== row.confirm_hash) {
    throw new ServiceRefused("changed", "What this job would run is not what was shown when it was asked for, so it was not started. Ask for it again.");
  }

  // A yes given ahead of its moment arms the job instead of starting it: the
  // trigger starts it, bound to this same hash.
  const trigger = await triggerOf(orgId, jobId);
  if (trigger && new Date(trigger.until).getTime() > Date.now()) {
    await meta
      .updateTable("service_confirm_triggers")
      .set({ confirm_hash: now, armed_by: userId, armed_at: new Date() })
      .where("org_id", "=", orgId)
      .where("job_id", "=", jobId)
      .execute();
    await settleJobCards(orgId, jobId, "confirm");
    return;
  }

  const moved = await db
    .updateTable("core_services_jobs")
    .set({ status: "queued", confirmed_by: userId, updated_at: new Date() })
    .where("id", "=", jobId)
    .where("status", "=", "awaiting_confirm")
    .where("confirm_hash", "=", now)
    .returning(["id"])
    .executeTakeFirst();
  // The other card was pressed first: it is already on its way.
  if (!moved) throw new ServiceRefused("not_waiting", "This job was already started.");
  await emit(orgId, { id: row.id, capability: row.capability, status: "queued", caused_by_job: row.caused_by_job, hop: row.hop });
  await startQueuedJob(orgId, jobId);
}

async function expireOne(orgId: string, db: Kysely<Db>, row: Pick<JobRow, "id" | "capability" | "caused_by_job" | "hop">): Promise<void> {
  const r = await db
    .updateTable("core_services_jobs")
    .set({ status: "cancelled", error: sql`${JSON.stringify(EXPIRED)}::jsonb` as never, message: EXPIRED.message, finished_at: new Date(), updated_at: new Date() })
    .where("id", "=", row.id)
    .where("status", "=", "awaiting_confirm")
    .executeTakeFirst();
  if (Number(r.numUpdatedRows ?? 0) > 0) await emit(orgId, { id: row.id, capability: row.capability, status: "cancelled", caused_by_job: row.caused_by_job, hop: row.hop });
}

/** Cancel every job in this workspace that has waited past its window.
 *  Exported for the test; the sweep calls it. */
export async function expireUnconfirmed(orgId: string, now: Date = new Date(), open?: unknown): Promise<number> {
  const db = open ? (open as Kysely<Db>) : await tdb(orgId);
  const stale = await db
    .selectFrom("core_services_jobs")
    .select(["id", "capability", "caused_by_job", "hop"])
    .where("status", "=", "awaiting_confirm")
    .where("created_at", "<", new Date(now.getTime() - SERVICE_CONFIRM_TTL_MS))
    .execute();
  // An armed job waits for its trigger until its own deadline, not the day.
  const armed = new Set(
    (
      await meta
        .selectFrom("service_confirm_triggers")
        .select("job_id")
        .where("org_id", "=", orgId)
        .where("armed_by", "is not", null)
        .where("until", ">", now)
        .execute()
    ).map((r) => r.job_id),
  );
  const expiring = stale.filter((r) => !armed.has(r.id));
  for (const row of expiring) await expireOne(orgId, db, row);
  return expiring.length;
}

/** Who a waiting job is sent to: the person who asked, or, for a job no
 *  person asked for, the workspace's owners and admins. */
export async function confirmersOf(orgId: string, requestedBy: string | null): Promise<string[]> {
  if (requestedBy) return [requestedBy];
  const rows = await meta.selectFrom("org_memberships").select("user_id").where("org_id", "=", orgId).where("role", "in", ORG_ROLES.filter((r) => roleSatisfies(r, ["admin"]))).execute();
  return rows.map((r) => r.user_id);
}

/** A job that started waiting where nobody is looking: a wire, module code.
 *  The person and Cobb doors have a card on screen already (the page, the
 *  chat), so they are not sent a second one. */
async function announceWaiting(orgId: string, jobId: string): Promise<void> {
  const db = await tdb(orgId);
  const row = await db
    .selectFrom("core_services_jobs")
    .select(["id", "capability", "status", "requested_by", "origin"])
    .where("id", "=", jobId)
    .executeTakeFirst();
  if (!row || row.status !== "awaiting_confirm") return;
  if (row.origin === "person" || row.origin === "cobb") return;
  const who = row.origin === "wire" ? "An automation" : "A module";
  await raiseJobCard({
    orgId,
    jobId: row.id,
    kind: "confirm",
    userIds: await confirmersOf(orgId, row.requested_by),
    eventType: WAITING_EVENT,
    message: `${who} asked for ${row.capability}, and it waits for your yes.`,
    heading: `${row.capability} is waiting for your yes`,
    body: `${who} asked for it. Nothing has run yet, and it runs exactly as it was asked.`,
    context: "It is cancelled if nobody says yes within a day.",
    actions: [{ id: "confirm", label: "Yes, start it", action: CONFIRM_SERVICE_ACTION, args: { job_id: row.id }, style: "primary" }],
  });
}

// ── A yes given ahead of its moment ─────────────────────────────────────

const TRIGGER_DEFAULT_MS = 24 * 3600_000;
const TRIGGER_MAX_MS = 7 * 24 * 3600_000;

export interface ConfirmTriggerView {
  label: string;
  event: string;
  until: string;
  armed: boolean;
}

async function triggerOf(orgId: string, jobId: string) {
  return meta.selectFrom("service_confirm_triggers").selectAll().where("org_id", "=", orgId).where("job_id", "=", jobId).executeTakeFirst();
}

export async function confirmTriggerView(orgId: string, jobId: string): Promise<ConfirmTriggerView | null> {
  const t = await triggerOf(orgId, jobId);
  return t ? { label: t.label, event: t.event, until: new Date(t.until).toISOString(), armed: !!t.armed_by } : null;
}

/** Propose "start this when `afterId` finishes" on a waiting job. Starts
 *  nothing: the person's yes arms it. `afterId` names a thing some
 *  registered trigger owns (a service job, a print). */
export async function proposeConfirmTrigger(orgId: string, jobId: string, userId: string, afterId: string, forMs?: number): Promise<ConfirmTriggerView> {
  const db = await tdb(orgId);
  const row = await db.selectFrom("core_services_jobs").select(["id", "status", "requested_by", "capability"]).where("id", "=", jobId).executeTakeFirst();
  if (!row) throw new ServiceRefused("not_found", "There is no such job here.");
  if (row.status !== "awaiting_confirm") throw new ServiceRefused("not_waiting", "Only a job waiting for a yes can wait for something else too.");
  const why = await mayConfirm(orgId, row, userId);
  if (why) throw new ServiceRefused("not_yours", why);
  let found: { event: string; label: string } | null = null;
  for (const t of serviceConfirmTriggers()) {
    const label = await t.describe(orgId, afterId).catch(() => null);
    if (label) {
      found = { event: t.event, label };
      break;
    }
  }
  if (!found) throw new ServiceRefused("refused", "Nothing here by that id can be waited for: it is not a job or a print in this workspace.");
  const until = new Date(Date.now() + Math.min(TRIGGER_MAX_MS, Math.max(60_000, forMs ?? TRIGGER_DEFAULT_MS)));
  await meta
    .insertInto("service_confirm_triggers")
    .values({ org_id: orgId, job_id: jobId, event: found.event, match_value: afterId, label: found.label, until, confirm_hash: null, armed_by: null, armed_at: null })
    .onConflict((oc) => oc.columns(["org_id", "job_id"]).doUpdateSet({ event: found!.event, match_value: afterId, label: found!.label, until, confirm_hash: null, armed_by: null, armed_at: null }))
    .execute();
  return (await confirmTriggerView(orgId, jobId))!;
}

/** Take a proposed or armed trigger back: the job waits for a plain yes. */
export async function withdrawConfirmTrigger(orgId: string, jobId: string, userId: string): Promise<void> {
  const db = await tdb(orgId);
  const row = await db.selectFrom("core_services_jobs").select(["requested_by", "capability"]).where("id", "=", jobId).executeTakeFirst();
  if (!row) throw new ServiceRefused("not_found", "There is no such job here.");
  const why = await mayConfirm(orgId, row, userId);
  if (why) throw new ServiceRefused("not_yours", why);
  await meta.deleteFrom("service_confirm_triggers").where("org_id", "=", orgId).where("job_id", "=", jobId).execute();
}

/** The thing an armed job waited for has finished: start every job armed on
 *  it that is still exactly what was confirmed, and inside its deadline. */
export async function fireConfirmTriggers(orgId: string, event: string, value: string): Promise<string[]> {
  const armed = await meta
    .selectFrom("service_confirm_triggers")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("event", "=", event)
    .where("match_value", "=", value)
    .where("armed_by", "is not", null)
    .execute();
  const started: string[] = [];
  const db = await tdb(orgId);
  for (const t of armed) {
    // One firing per arming, whatever happens next.
    const taken = await meta
      .deleteFrom("service_confirm_triggers")
      .where("org_id", "=", orgId)
      .where("job_id", "=", t.job_id)
      .where("armed_at", "=", t.armed_at!)
      .executeTakeFirst();
    if (Number(taken.numDeletedRows ?? 0) === 0) continue;
    if (new Date(t.until).getTime() < Date.now()) continue;
    const row = await db
      .selectFrom("core_services_jobs")
      .select(["id", "capability", "status", "input", "connection_id", "confirm_hash", "caused_by_job", "hop"])
      .where("id", "=", t.job_id)
      .executeTakeFirst();
    if (!row || row.status !== "awaiting_confirm") continue;
    const files = await db.selectFrom("core_services_job_files").select(["name", "sha256"]).where("job_id", "=", t.job_id).where("direction", "=", "in").execute();
    const nowHash = confirmHashOf({ capability: row.capability, input: row.input ?? null, fileHashes: Object.fromEntries(files.map((f) => [f.name, f.sha256 ?? ""])), connectionId: row.connection_id });
    if (nowHash !== t.confirm_hash || nowHash !== row.confirm_hash) continue;
    const moved = await db
      .updateTable("core_services_jobs")
      .set({ status: "queued", confirmed_by: t.armed_by, updated_at: new Date() })
      .where("id", "=", t.job_id)
      .where("status", "=", "awaiting_confirm")
      .where("confirm_hash", "=", nowHash)
      .returning(["id"])
      .executeTakeFirst();
    if (!moved) continue;
    await emit(orgId, { id: row.id, capability: row.capability, status: "queued", caused_by_job: row.caused_by_job, hop: row.hop });
    await startQueuedJob(orgId, row.id);
    started.push(row.id);
  }
  return started;
}

/** Wire the confirm into the platform: the waiting cards and the expiry.
 *  Called once at boot. */
export function registerServiceConfirm(): void {
  // A service job reaching done is something a waiting job can wait for.
  registerServiceConfirmTrigger({
    event: "services.job.done",
    key: "jobId",
    describe: async (orgId, id) => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const job = await (await tdb(orgId)).selectFrom("core_services_jobs").select(["capability"]).where("id", "=", id).executeTakeFirst();
      return job ? `when the ${job.capability} job finishes` : null;
    },
  });
  onServiceConfirmTrigger((t) => {
    platform().events.on(t.event, "platform", (payload) => {
      const p = payload as Record<string, unknown>;
      const orgId = typeof p.orgId === "string" ? p.orgId : null;
      const value = p[t.key];
      if (orgId && (typeof value === "string" || typeof value === "number")) void fireConfirmTriggers(orgId, t.event, String(value)).catch(() => {});
    });
  });
  platform().events.on("services.job.updated", "platform", (payload) => {
    const p = payload as { orgId?: string; jobId?: string; status?: string };
    if (!p.orgId || !p.jobId) return;
    // A job waiting where nobody is looking is sent to its person; one that
    // has stopped waiting (a yes, a cancel, the day passing) takes its cards
    // back, so no bell or Discord card keeps asking an answered question.
    if (p.status === "awaiting_confirm") {
      void meta
        .insertInto("service_pending_confirms")
        .values({ org_id: p.orgId, job_id: p.jobId })
        .onConflict((oc) => oc.columns(["org_id", "job_id"]).doNothing())
        .execute()
        .catch(() => {});
      void announceWaiting(p.orgId, p.jobId).catch(() => {});
    } else {
      void meta.deleteFrom("service_pending_confirms").where("org_id", "=", p.orgId).where("job_id", "=", p.jobId).execute().catch(() => {});
      void settleJobCards(p.orgId, p.jobId, "confirm").catch(() => {});
    }
  });
  platform().sweeps.register({
    name: "platform.service-confirm-expiry",
    everyMs: 15 * 60_000,
    // Only the workspaces holding a job past its day, from meta: a round with
    // nothing to expire opens no tenant database.
    candidates: async (orgIds) => {
      const rows = await meta
        .selectFrom("service_pending_confirms")
        .select("org_id")
        .distinct()
        .where("since", "<", new Date(Date.now() - SERVICE_CONFIRM_TTL_MS))
        .where("org_id", "in", orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"])
        .execute();
      return rows.map((r) => r.org_id);
    },
    visit: async ({ orgId, now, db }) => {
      await expireUnconfirmed(orgId, now, db);
    },
  });
}
