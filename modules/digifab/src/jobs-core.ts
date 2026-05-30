// Shared job logic — building a driver from a stored connection, and
// polling a job's status. No express dependency, so both the HTTP route
// and the core-queue poll worker use the same code.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import { resolveDriver } from "./drivers/registry.js";
import type { MachineDriver } from "./drivers/types.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Build a live driver from a connection row (decrypts creds). */
export async function buildDriverById(
  db: Kysely<DigifabDB>,
  orgId: string,
  connectionId: string,
): Promise<MachineDriver | null> {
  const conn = await db
    .selectFrom("digifab_connections")
    .select(["id", "type", "base_url", "credentials_enc"])
    .where("id", "=", connectionId)
    .executeTakeFirst();
  if (!conn) return null;
  let creds: Record<string, unknown> = {};
  if (conn.credentials_enc) {
    creds = await platform().integrations.decryptCredentials(orgId, conn.credentials_enc);
  }
  return resolveDriver(
    db,
    conn.type,
    {
      baseUrl: conn.base_url,
      apiKey: (creds.apiKey as string | undefined) ?? null,
      username: (creds.username as string | undefined) ?? null,
      password: (creds.password as string | undefined) ?? null,
    },
    conn.id,
  );
}

/** Poll one job: getJobStatus → persist → emit on terminal. Returns the
 *  new status + whether it's terminal (so the worker stops re-enqueuing). */
export async function pollJob(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
): Promise<{ status: string; terminal: boolean } | null> {
  const job = await db
    .selectFrom("digifab_jobs")
    .selectAll()
    .where("id", "=", jobId)
    .executeTakeFirst();
  if (!job || !job.remote_job_id) return null;
  const driver = await buildDriverById(db, orgId, job.connection_id);
  if (!driver) return null;

  let status: string;
  let progress: number | null = null;
  let error: string | null = null;
  try {
    const st = await driver.getJobStatus(job.remote_job_id);
    status = st.state;
    progress = st.progress ?? null;
  } catch (e) {
    status = "failed";
    error = (e as Error).message.slice(0, 300);
  }
  const terminal = TERMINAL.has(status);
  await db
    .updateTable("digifab_jobs")
    .set({ status, progress, error, last_polled_at: new Date(), updated_at: new Date() })
    .where("id", "=", jobId)
    .execute();

  if (terminal) {
    // The marquee reactivity hook: a default wire can carry
    // print.completed → projects:set-dep-satisfied / mark task done /
    // bump stock, with neither module importing the other.
    void platform().events.emit(
      status === "completed" ? "digifab.print.completed" : "digifab.print.failed",
      { orgId, jobId, connectionId: job.connection_id, linkedMachineId: job.linked_machine_id, linkedTaskId: job.linked_task_id },
    );
  }
  return { status, terminal };
}
