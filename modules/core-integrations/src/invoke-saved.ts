// Run one action of a workspace's saved outbound connection: the one door
// behind both the Connections page's Invoke and the connector's built-in
// service (services.md §12), so a Slack post Cobb asks for and one a person
// presses are the same call, logged the same way.
//
// It is also where a send meets the other side's limits: one connection sends
// at its own pace, and a 5xx, a 429 or a dropped connection is tried again
// later from the queue instead of being a lost message. A send that gives up
// is a failed row in the calls log that carries what it takes to send it again.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import type { CoreIntegrationsDB } from "./db.js";
import { MAX_SEND_ATTEMPTS, OutboundSendError, backoffMs, isRetryable, paceIntervalMs, sleep } from "./outbound-send.js";

export const SEND_QUEUE = "core-integrations.send";

/** The longest a caller waits in line for its turn before the send is handed to
 *  the queue; the queue worker waits longer, it has nobody holding a request. */
const CALLER_WAIT_MS = 2_000;

export type SavedInvokeOutcome =
  | { kind: "not_found" }
  | { kind: "disabled" }
  | { kind: "unknown_connector"; connectorId: string }
  | { kind: "queued"; connectorId: string; runAt: Date; because: "pace" | "retry"; error: string | null }
  | { kind: "done"; connectorId: string; ok: boolean; ms: number; status: number | null; result: unknown; error: string | null };

export interface SendPlan {
  /** 1 for a send somebody just asked for, then 2.. for the retries. */
  attempt?: number;
  /** How long to stand in line for this connection's turn before handing over. */
  maxWaitMs?: number;
  /** Stable across the tries of one send. */
  key?: string;
}

export interface SendDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  /** Zero means a turn was claimed now. A positive wait is unclaimed and must
   *  be checked again after sleeping; waits past `maxWaitMs` go to the queue. */
  pace(db: Kysely<CoreIntegrationsDB>, key: string, intervalMs: number, maxWaitMs: number): Promise<{ waitMs: number } | { deferMs: number }>;
  enqueue(orgId: string, payload: SendJob, runAt: Date): Promise<void>;
}

export interface SendJob {
  rowId: string;
  actionId: string;
  args: Record<string, unknown>;
  rendered?: string;
  attempt: number;
  /** One per send, kept through every retry. */
  key?: string;
}

/** Claim only a turn that is due: reserving future turns lets late timers
 *  release a burst. The database clock and atomic update coordinate processes. */
async function claimTurn(db: Kysely<CoreIntegrationsDB>, key: string, intervalMs: number, maxWaitMs: number): Promise<{ waitMs: number } | { deferMs: number }> {
  if (intervalMs <= 0) return { waitMs: 0 };
  const interval = intervalMs / 1000;
  const taken = await sql`
    insert into core_integrations_pace (connection_id, next_at)
    values (${key}, clock_timestamp() + make_interval(secs => ${interval}))
    on conflict (connection_id) do update
       set next_at = clock_timestamp() + make_interval(secs => ${interval})
     where core_integrations_pace.next_at <= clock_timestamp()
 returning connection_id`.execute(db);
  if (taken.rows[0]) return { waitMs: 0 };
  const open = await sql<{ defer_ms: string }>`select (extract(epoch from (next_at - clock_timestamp())) * 1000)::text as defer_ms from core_integrations_pace where connection_id = ${key}`.execute(db);
  const waitMs = Math.max(1, Math.ceil(Number(open.rows[0]?.defer_ms ?? "0")));
  return waitMs > maxWaitMs ? { deferMs: waitMs } : { waitMs };
}

const REAL_SEND_DEPS: SendDeps = {
  now: () => Date.now(),
  sleep,
  random: Math.random,
  pace: claimTurn,
  enqueue: async (orgId, payload, runAt) => {
    await platform().queue.enqueue({ orgId, queue: SEND_QUEUE, payload: payload as unknown as Record<string, unknown>, runAt, maxAttempts: 3 });
  },
};

export async function invokeSavedConnector(
  db: Kysely<CoreIntegrationsDB>,
  orgId: string,
  rowId: string,
  actionId: string,
  args: Record<string, unknown>,
  rendered?: string,
  plan: SendPlan = {},
  deps: SendDeps = REAL_SEND_DEPS,
): Promise<SavedInvokeOutcome> {
  const attempt = plan.attempt ?? 1;
  const row = await db
    .selectFrom("core_integrations_connectors")
    .select(["connector_id", "credentials_enc", "enabled"])
    .where("id", "=", rowId)
    .executeTakeFirst();
  if (!row) return { kind: "not_found" };
  if (!row.enabled) return { kind: "disabled" };
  const def = platform().integrations.getConnector(row.connector_id);
  if (!def) return { kind: "unknown_connector", connectorId: row.connector_id };
  const creds = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);
  const key = plan.key ?? randomUUID();
  const job: SendJob = { rowId, actionId, args, rendered, attempt, key };

  const intervalMs = paceIntervalMs(row.connector_id, creds);
  const waitUntil = deps.now() + (plan.maxWaitMs ?? CALLER_WAIT_MS);
  for (;;) {
    const turn = await deps.pace(db, rowId, intervalMs, Math.max(0, waitUntil - deps.now()));
    if ("deferMs" in turn) {
      const runAt = new Date(deps.now() + turn.deferMs);
      await deps.enqueue(orgId, job, runAt);
      return { kind: "queued", connectorId: row.connector_id, runAt, because: "pace", error: null };
    }
    if (turn.waitMs <= 0) break;
    await deps.sleep(turn.waitMs);
  }

  const start = deps.now();
  let ok = false;
  let status: number | null = null;
  let error: string | null = null;
  let result: unknown = null;
  let failure: unknown = null;
  try {
    result = await platform().integrations.invokeConnector(row.connector_id, { orgId, rowId, credentials: creds, args, rendered, idempotencyKey: key }, actionId);
    ok = true;
    const maybeStatus = (result as { status?: number } | null)?.status;
    if (typeof maybeStatus === "number") status = maybeStatus;
  } catch (err) {
    failure = err;
    error = (err as Error).message;
    if (err instanceof OutboundSendError) status = err.status;
  }
  const ms = deps.now() - start;

  const again = !ok && isRetryable(failure) && attempt < MAX_SEND_ATTEMPTS;
  const runAt = again ? new Date(deps.now() + backoffMs(attempt + 1, (failure as OutboundSendError).retryAfterMs, deps.random)) : null;
  // The row a person reads: every try is one line; the last failed one says it
  // gave up and carries what Send again needs.
  const needsLook = !ok && failure instanceof OutboundSendError && failure.needsLook;
  const meta = { args, rendered: rendered ?? null, connection_id: rowId, attempt, ...(ok || again ? {} : { gave_up: true }), ...(needsLook ? { needs_look: true } : {}), ...(runAt ? { retry_at: runAt.toISOString() } : {}) };
  try {
    await db
      .insertInto("core_integrations_calls")
      .values({
        direction: "outbound",
        connector_id: row.connector_id,
        action_or_event: actionId,
        status,
        ok,
        error,
        request_meta: sql`${JSON.stringify(meta)}::jsonb` as never,
        ms,
      })
      .execute();
  } catch (err) {
    console.error("[core-integrations] audit write failed:", err);
  }
  if (runAt) {
    await deps.enqueue(orgId, { ...job, attempt: attempt + 1 }, runAt);
    return { kind: "queued", connectorId: row.connector_id, runAt, because: "retry", error };
  }
  void platform().events.emit(ok ? "core-integrations.connector.invoked" : "core-integrations.connector.failed", {
    orgId,
    rowId,
    connectorId: row.connector_id,
    actionId,
    ms,
    error,
    ...(ok ? {} : { attempts: attempt, gaveUp: true, ...(needsLook ? { needsLook: true } : {}) }),
  });
  return { kind: "done", connectorId: row.connector_id, ok, ms, status, result, error };
}
