// Shared job logic — building a driver from a stored connection, and
// polling a job's status. No express dependency, so both the HTTP route
// and the core-queue poll worker use the same code.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import { resolveDriver } from "./drivers/registry.js";
import type { EdgeRelay } from "./drivers/edge-adapter.js";
import type { MachineDriver, RemoteDevice, SubmitResult } from "./drivers/types.js";
import { isAssignable } from "./state.js";
import { notifyPrint, progressBucket } from "./notify.js";

/** The manual camera URL set for a device (for the "Live view" link in print
 *  notifications). Null when none or no device. */
async function cameraFor(db: Kysely<DigifabDB>, connectionId: string | null, deviceId: string | null): Promise<string | null> {
  if (!connectionId || !deviceId) return null;
  const row = await db
    .selectFrom("digifab_device_settings")
    .select(["camera_url"])
    .where("connection_id", "=", connectionId)
    .where("remote_device_id", "=", deviceId)
    .executeTakeFirst();
  return row?.camera_url ?? null;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** Consecutive poll errors before a live job is declared `failed` (F-12) — so a
 *  transient network blip doesn't kill a healthy print. */
const POLL_ERROR_THRESHOLD = 3;

/** Build a live driver from a connection ref (id OR label; decrypts creds). The
 *  connection now lives in core-devices — fetch it via the platform store; the
 *  digifab db is still needed for the installed-driver (digifab_drivers) lookup. */
export async function buildDriverById(
  db: Kysely<DigifabDB>,
  orgId: string,
  connectionRef: string,
): Promise<MachineDriver | null> {
  const conn = await platform().devices.connections().getInternal(orgId, connectionRef);
  if (!conn) return null;
  let creds: Record<string, unknown> = {};
  if (conn.credentials_enc) {
    creds = await platform().integrations.decryptCredentials(orgId, conn.credentials_enc);
  }
  // A "cobblr-edge://" base_url means this edge_adapter connection is reached via
  // the cloud→edge TUNNEL (the agent dials out) rather than a direct bridge URL.
  // Build the relay closure here, where platform().edge + orgId are in hand, so
  // the pure driver stays platform-free. The relay errors if no agent is connected.
  const relay: EdgeRelay | null = /^cobblr-edge:/i.test(conn.base_url)
    ? async (r) => {
        const res = await platform().edge.send(orgId, { path: r.path, method: r.method === "POST" ? "POST" : "GET", body: r.body });
        return { status: res.status, body: res.body };
      }
    : null;
  return resolveDriver(
    db,
    conn.type,
    {
      baseUrl: conn.base_url,
      apiKey: (creds.apiKey as string | undefined) ?? null,
      username: (creds.username as string | undefined) ?? null,
      password: (creds.password as string | undefined) ?? null,
      extra: { creds },
    },
    conn.id,
    relay,
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
  if (!job || !job.remote_job_id || !job.connection_id) return null;
  // Whether the job was ALREADY terminal — so the terminal side-effects (filament
  // deduct, bed-clear attention, notifications, kick-assign) fire only on the
  // transition, not on every poll of an already-finished job.
  const wasTerminal = TERMINAL.has(job.status);
  const driver = await buildDriverById(db, orgId, job.connection_id);
  if (!driver) return null;

  // F-12: a single transient poll error must NOT flip a live print to a
  // permanent `failed` (which fires the failure wires + frees the printer). A
  // dropped packet is not a failed print. Only declare terminal failure after
  // POLL_ERROR_THRESHOLD consecutive errors; a successful poll resets the count.
  let status: string;
  let progress: number | null = null;
  let error: string | null = null;
  let etaSec: number | null = null;
  let elapsedSec: number | null = null;
  try {
    const st = await driver.getJobStatus(job.remote_job_id);
    status = st.state;
    progress = st.progress ?? null;
    etaSec = st.timeRemainingSec ?? null;
    elapsedSec = st.elapsedSec ?? null;
  } catch (e) {
    const errs = (job.poll_errors ?? 0) + 1;
    error = (e as Error).message.slice(0, 300);
    if (errs < POLL_ERROR_THRESHOLD) {
      // Keep the job's current (non-terminal) status; just record the transient
      // error + the count, and try again next tick. Not terminal.
      await db
        .updateTable("digifab_jobs")
        .set({ error: `unreachable (${errs}/${POLL_ERROR_THRESHOLD}): ${error}`, poll_errors: errs, last_polled_at: new Date(), updated_at: new Date() })
        .where("id", "=", jobId)
        .execute();
      return { status: job.status, terminal: false };
    }
    // Repeatedly unreachable → give up.
    status = "failed";
    error = `unreachable after ${errs} polls: ${error}`;
  }
  const terminal = TERMINAL.has(status);
  // F-1 ATOMIC: a terminal job's status flip and its bed-clear (needs_attention)
  // row must commit TOGETHER. Otherwise an assign pass can observe the device as
  // "no longer printing" (gone from the busy set, mock back to idle) in the gap
  // BEFORE the attention row exists, and drip the next queued job straight onto
  // the uncleared bed — the digifab-pools flake (3rd job not held; ≤2 cap blipped).
  // One transaction closes that window: any pass reads both-after or both-before.
  const markAttention = terminal && !wasTerminal && !!job.connection_id && !!job.target_device;
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("digifab_jobs")
      .set({ status, progress, error, poll_errors: 0, last_polled_at: new Date(), updated_at: new Date() })
      .where("id", "=", jobId)
      .execute();
    if (markAttention) {
      await trx
        .insertInto("digifab_device_attention")
        .values({
          connection_id: job.connection_id!,
          remote_device_id: job.target_device!,
          job_id: jobId,
          reason: status === "completed" ? "print-completed" : "print-failed",
        })
        .onConflict((oc) =>
          oc.columns(["connection_id", "remote_device_id"]).doUpdateSet({
            job_id: jobId,
            reason: status === "completed" ? "print-completed" : "print-failed",
            created_at: new Date(),
          }),
        )
        .execute();
    }
  });

  // ── Print-lifecycle notifications (the "post updates to Discord" flow) ──
  // A 25/50/75% milestone fires once as it's crossed (the stored progress is the
  // "last seen", so the next poll in the same bucket won't re-notify).
  const gramsUsed = job.material_grams != null ? Number(job.material_grams) : null;
  if (!terminal && status === "printing") {
    const newB = progressBucket(progress);
    if (newB > progressBucket(job.progress != null ? Number(job.progress) : null) && newB >= 1 && newB <= 3) {
      const cam = await cameraFor(db, job.connection_id, job.target_device);
      void notifyPrint(orgId, { kind: "progress", jobId, fileRef: job.file_ref, device: job.target_device, cameraUrl: cam, progress, etaSec, elapsedSec, gramsUsed });
    }
  }

  if (terminal && !wasTerminal) {
    // (F-1 bed-clear `needs_attention` was already written atomically with the
    // status flip above — see the transaction — so an assign pass can never see
    // the freed bed without the attention row.)
    // The marquee reactivity hook: a default wire can carry
    // print.completed → projects:set-dep-satisfied / mark task done /
    // bump stock, with neither module importing the other.
    // Surface the consumed filament as { partId, delta } so a seeded
    // digifab.print.completed → inventory.adjust-stock wire deducts it (the
    // adjust-stock handler reads partId/delta straight off the payload). Only
    // on a clean completion — a failed print didn't consume the spool.
    const grams = job.material_grams != null ? Number(job.material_grams) : null;
    const material =
      status === "completed" && job.material_part_id && grams && grams > 0
        ? {
            partId: job.material_part_id,
            delta: -grams,
            reason: `Print: ${job.file_ref}`,
            // Source attribution for the consumption ledger — "this print drew it down".
            sourceKind: "digifab:job",
            sourceId: jobId,
          }
        : {};
    void platform().events.emit(
      status === "completed" ? "digifab.print.completed" : "digifab.print.failed",
      {
        orgId,
        jobId,
        connectionId: job.connection_id,
        linkedMachineId: job.linked_machine_id,
        linkedTaskId: job.linked_task_id,
        ...material,
      },
    );
    // Discord/in-app update on the terminal outcome.
    const cam = await cameraFor(db, job.connection_id, job.target_device);
    void notifyPrint(orgId, {
      kind: status === "completed" ? "completed" : "failed",
      jobId,
      fileRef: job.file_ref,
      device: job.target_device,
      cameraUrl: cam,
      progress,
      elapsedSec,
      gramsUsed,
      error,
    });
    // A freed printer should immediately pull the next queued pool job, rather
    // than wait for the worker's next re-tick. Dynamic import avoids a static
    // cycle (assign-worker imports this file).
    void import("./assign-worker.js").then((m) => m.kickAssign(orgId)).catch(() => {});
  }
  return { status, terminal };
}

export type SendJobResult =
  | { ok: true; status: string; remoteJobId: string | null; placement: SubmitResult; uploadedBytes: number; shouldPoll: boolean }
  | { ok: false; code: "not_found" | "already_sent" | "no_connection" | "unknown_device" };

/** Upload + place a job on its connection's farm. Pure (no express, no poll
 *  enqueue) so the send ROUTE and the assignment WORKER share it — the caller
 *  enqueues the poll when `shouldPoll`. Mirrors the original /jobs/:id/send body.
 *  The job must already carry a connection (an unassigned pool job is assigned
 *  first, then sent). */
export async function sendJob(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
): Promise<SendJobResult> {
  const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!job) return { ok: false, code: "not_found" };
  if (job.remote_job_id) return { ok: false, code: "already_sent" };
  if (!job.connection_id) return { ok: false, code: "no_connection" };

  const driver = await buildDriverById(db, orgId, job.connection_id);
  if (!driver) return { ok: false, code: "no_connection" };

  // A job linked to a machine (and not otherwise targeted) routes to that
  // machine's mapped device.
  let deviceId = job.target_device;
  if (!deviceId && !job.target_tag && job.linked_machine_id) {
    const link = await db
      .selectFrom("digifab_device_links")
      .select(["remote_device_id"])
      .where("connection_id", "=", job.connection_id)
      .where("machine_id", "=", job.linked_machine_id)
      .executeTakeFirst();
    if (link) deviceId = link.remote_device_id;
  }

  // F-6/F-7 — resolve and validate the target against THIS connection's real
  // printer list, on our side, before we upload or submit. A remote device id
  // is only unique within its manager, and not every driver honours the `tag`
  // param (FDM Monster's classic submit ignores it) — so doing it here makes
  // every driver behave identically and stops a stale/cross-connection id from
  // silently landing a print on the wrong machine. listDevices is read-only;
  // if it can't be reached we fall through (submitJob will surface its own
  // error) rather than block a send on a transient list hiccup.
  if (deviceId || job.target_tag) {
    let devices: RemoteDevice[] = [];
    try {
      devices = await driver.listDevices();
    } catch {
      devices = [];
    }
    if (devices.length > 0) {
      if (deviceId && !devices.some((d) => d.id === deviceId)) {
        // F-7: an explicit target that this connection doesn't have — refuse
        // rather than blind-submit a print to whatever id the manager maps it to.
        return { ok: false, code: "unknown_device" };
      }
      if (!deviceId && job.target_tag) {
        // F-6: resolve the tag to a concrete printer ourselves. Prefer an
        // enabled, assignable (idle) one; else any tagged printer (the manager
        // queues it). No match → leave deviceId null so the submit routes/awaits
        // visibly instead of dropping the tag on the floor.
        const tag = job.target_tag;
        const tagged = devices.filter((d) => (d.tags ?? []).includes(tag));
        const pick = tagged.find((d) => d.enabled && isAssignable(d.state ?? "")) ?? tagged[0];
        if (pick) deviceId = pick.id;
      }
    }
  }

  // Real bytes when the job references a stored file (via the platform seam —
  // no core-files import); else the placeholder path where file_ref is a routing
  // string. uploadName drives the farm-side filename (+ the mock's routing).
  let fileBytes = new Uint8Array();
  let uploadName = job.file_ref;
  if (job.file_id) {
    const f = await platform().files.read(orgId, job.file_id);
    if (f) {
      fileBytes = new Uint8Array(f.bytes);
      uploadName = f.filename;
    }
  }

  const up = await driver.uploadFile(fileBytes, uploadName);
  const sub = await driver.submitJob({ fileId: up.fileId, deviceId, tag: job.target_tag });
  const status = sub.queued ? "sent" : "awaiting-assignment";
  await db
    .updateTable("digifab_jobs")
    .set({
      remote_file_id: up.fileId,
      remote_job_id: sub.jobId,
      target_device: sub.deviceId ?? deviceId,
      status,
      updated_at: new Date(),
    })
    .where("id", "=", jobId)
    .execute();
  void platform().events.emit("digifab.job.sent", { orgId, jobId, status });
  if (sub.queued) {
    const placed = sub.deviceId ?? deviceId;
    const cam = await cameraFor(db, job.connection_id, placed);
    void notifyPrint(orgId, { kind: "started", jobId, fileRef: job.file_ref, device: placed, cameraUrl: cam, gramsUsed: job.material_grams != null ? Number(job.material_grams) : null });
  }
  return {
    ok: true,
    status,
    remoteJobId: sub.jobId ?? null,
    placement: sub,
    uploadedBytes: fileBytes.byteLength,
    shouldPoll: !!(sub.queued && sub.jobId),
  };
}

export type AssignJobResult =
  | { ok: true; status: string; remoteJobId: string | null; placement: SubmitResult; shouldPoll: boolean }
  | { ok: false; code: "not_found" | "not_awaiting" | "no_connection" | "no_file" | "unknown_device" };

/** F-14 — re-pick a printer for a job stuck in `awaiting-assignment` (its target
 *  matched 0 or many printers). The file is ALREADY on the farm (remote_file_id),
 *  so this just re-submits it to a now-explicit device — no re-upload, no
 *  delete-and-recreate. Validates the device belongs to the connection (F-7).
 *  The send route can't do this: it refuses a job that's already been placed. */
export async function assignJob(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
  deviceId: string,
): Promise<AssignJobResult> {
  const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!job) return { ok: false, code: "not_found" };
  if (job.status !== "awaiting-assignment") return { ok: false, code: "not_awaiting" };
  if (!job.connection_id) return { ok: false, code: "no_connection" };
  if (!job.remote_file_id) return { ok: false, code: "no_file" };

  const driver = await buildDriverById(db, orgId, job.connection_id);
  if (!driver) return { ok: false, code: "no_connection" };

  // F-7: the chosen device must actually be on this connection.
  let devices: RemoteDevice[] = [];
  try {
    devices = await driver.listDevices();
  } catch {
    devices = [];
  }
  if (devices.length > 0 && !devices.some((d) => d.id === deviceId)) {
    return { ok: false, code: "unknown_device" };
  }

  const sub = await driver.submitJob({ fileId: job.remote_file_id, deviceId });
  const status = sub.queued ? "sent" : "awaiting-assignment";
  await db
    .updateTable("digifab_jobs")
    .set({
      remote_job_id: sub.jobId,
      target_device: sub.deviceId ?? deviceId,
      target_tag: null, // a specific printer was chosen — drop the ambiguous tag
      status,
      updated_at: new Date(),
    })
    .where("id", "=", jobId)
    .execute();
  void platform().events.emit("digifab.job.sent", { orgId, jobId, status });
  if (sub.queued) {
    const placed = sub.deviceId ?? deviceId;
    const cam = await cameraFor(db, job.connection_id, placed);
    void notifyPrint(orgId, { kind: "started", jobId, fileRef: job.file_ref, device: placed, cameraUrl: cam, gramsUsed: job.material_grams != null ? Number(job.material_grams) : null });
  }
  return { ok: true, status, remoteJobId: sub.jobId ?? null, placement: sub, shouldPoll: !!(sub.queued && sub.jobId) };
}
