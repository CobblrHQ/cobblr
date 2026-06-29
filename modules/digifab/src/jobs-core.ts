// Shared job logic — building a driver from a stored connection, and
// polling a job's status. No express dependency, so both the HTTP route
// and the core-queue poll worker use the same code.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "./db.js";
import { resolveDriver } from "./drivers/registry.js";
import { EdgeAdapterDriver, type EdgeRelay } from "./drivers/edge-adapter.js";
import type { MachineDriver, RemoteDevice, SubmitResult } from "./drivers/types.js";
import { isAssignable } from "./state.js";
import { notifyPrint, progressBucket } from "./notify.js";
// Call-time only (reprint-on-fail re-queue) — both modules import from this one,
// so these are lazy/circular by design; ESM resolves them when the retry fires.
import { kickAssign } from "./assign-worker.js";
import { enqueuePoll } from "./poll-worker.js";

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
    buildEdgeRelay(orgId, conn.base_url, creds.edge as { driver?: unknown; config?: unknown } | undefined, creds.shared as { owner_org?: unknown } | undefined),
  );
}

/** The driver config to ship down the tunnel for an edge instance. `creds.edge`
 *  is stored FLAT by connections.ts — `{ driver, host, apiKey, … }` — so the
 *  driver's config is every field EXCEPT `driver`. (A bug shipped where this read
 *  a nested `edge.config` that's never written, so `host` was dropped and the
 *  bridge looped "prusalink driver needs host".) Tolerates a nested `{ config }`
 *  too, for forward-compat. */
function edgeDriverConfig(edge: { driver?: unknown; config?: unknown }): Record<string, unknown> {
  if (edge.config && typeof edge.config === "object") return edge.config as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(edge as Record<string, unknown>)) {
    // `driver` selects the driver; `bridge` is routing metadata (which bridge
    // serves this connection) — neither is part of the driver's own config.
    if (k !== "driver" && k !== "bridge") rest[k] = v;
  }
  return rest;
}

/** The edge channel key. Multi-bridge: a workspace can run more than one bridge
 *  (separate buildings/VLANs, or LightBurn which must run on the LightBurn PC).
 *  Each named bridge gets its own channel; a connection with no bridge id routes
 *  to the workspace's DEFAULT channel — byte-identical to the single-bridge path,
 *  so existing bridges are untouched. The agent announces the same id via
 *  `?bridge=` on register/poll/respond. */
export function edgeChannelKey(orgId: string, bridge?: string | null): string {
  return bridge ? `${orgId}::${bridge}` : orgId;
}

/** Per-printer Bambu LAN config — `creds.bambu_lan` is a JSON map of
 *  serial → { host, access_code } (the access code is a credential, so it lives
 *  encrypted in creds, not plaintext config). HYBRID: a Bambu connection keeps
 *  its cloud telemetry AND, for any printer with LAN config here, routes
 *  file-push + control through the on-site bridge's `bambu` (LAN) driver. */
/** Per-printer transport mode: all cloud / prefer LAN (cloud fallback) / LAN only
 *  (cloud off, accept losing cloud-only history). Default = prefer_lan once LAN
 *  is configured. */
export type BambuLanMode = "cloud" | "prefer_lan" | "lan_only";
export type BambuLan = { host: string; access_code: string; mode?: BambuLanMode };
export function bambuLanMode(lan: BambuLan | undefined): BambuLanMode {
  return lan?.mode ?? (lan?.host ? "prefer_lan" : "cloud");
}
export function parseBambuLan(creds: Record<string, unknown>): Record<string, BambuLan> {
  try {
    const m = JSON.parse(String(creds.bambu_lan ?? "{}")) as Record<string, BambuLan>;
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

/** Build the edge-routed `bambu` LAN driver for one printer — the bridge dials
 *  the printer over `mqtts://host:8883` (+ FTPS file push) using the access code.
 *  Each printer is its own bridge instance (`bambu-<serial>`); rides the org's
 *  default bridge channel (same bridge that serves the workspace's other LAN
 *  machines). */
export function buildBambuLanDriver(orgId: string, serial: string, lan: BambuLan, bridge?: string | null): MachineDriver {
  const baseUrl = `cobblr-edge://bambu-${serial}`;
  const relay = buildEdgeRelay(orgId, baseUrl, { driver: "bambu", transport: "lan", host: lan.host, serial, accessCode: lan.access_code, ...(bridge ? { bridge } : {}) } as Record<string, unknown>, null);
  return new EdgeAdapterDriver({ baseUrl, apiKey: null, username: null, password: null, extra: {} }, relay);
}

/** If this connection is Bambu AND `deviceId` has LAN config, return the LAN
 *  driver (for file-push/control); else null (cloud handles it). */
export async function bambuLanDriverFor(orgId: string, connectionRef: string, deviceId: string): Promise<MachineDriver | null> {
  const conn = await platform().devices.connections().getInternal(orgId, connectionRef);
  if (!conn || conn.type !== "bambu" || !conn.credentials_enc) return null;
  const creds = await platform().integrations.decryptCredentials(orgId, conn.credentials_enc);
  const lan = parseBambuLan(creds)[deviceId];
  // "All cloud" mode ignores LAN even if the host/code are stored.
  if (!lan?.host || !lan?.access_code || bambuLanMode(lan) === "cloud") return null;
  return buildBambuLanDriver(orgId, deviceId, lan);
}

/** The cloud→edge tunnel relay closure for a `cobblr-edge://` connection: routes
 *  every edge-adapter call through the agent that dialed out (platform().edge),
 *  so the cloud never fetches a private IP (no SSRF surface). Null for a direct
 *  `http(s)://` bridge URL. Shared by every driver-build path (jobs, fleet,
 *  connection test/listDevices) so the tunnel works end to end, not just for jobs. */
export function buildEdgeRelay(
  orgId: string,
  baseUrl: string,
  edge?: { driver?: unknown; config?: unknown } | null,
  shared?: { owner_org?: unknown; owner_conn_id?: unknown; share_id?: unknown; scope?: unknown } | null,
): EdgeRelay | null {
  if (!/^cobblr-edge:/i.test(baseUrl)) return null;
  const id = (/^cobblr-edge:\/\/(.*)$/i.exec(baseUrl)?.[1] ?? "").replace(/^\/+|\/+$/g, "");

  // SHARED pointer (this connection was redeemed from another workspace's invite).
  // Route through the OWNER's bridge channel, assembling the request from the
  // owner's machine config SERVER-SIDE (their creds never reach this workspace),
  // and enforce the grant LIVE on every call: revoked/expired → blocked; read
  // scope → GET only, so every upload/submit/command/pause (POST) is refused.
  const ownerOrg = typeof shared?.owner_org === "string" ? shared.owner_org : null;
  const ownerConnId = typeof shared?.owner_conn_id === "string" ? shared.owner_conn_id : null;
  const shareId = typeof shared?.share_id === "string" ? shared.share_id : null;
  if (ownerOrg && ownerConnId && shareId) {
    const scope = shared?.scope === "write" ? "write" : "read";
    return async (r) => {
      const method = r.method === "POST" ? "POST" : "GET";
      if (scope === "read" && method !== "GET") {
        return { status: 403, body: { error: { code: "read_only", message: "This shared machine is read-only." } } };
      }
      const odb = (await platform().tenants.getDb(ownerOrg)) as Kysely<DigifabDB>;
      try {
        const grant = await odb
          .selectFrom("digifab_edge_shares")
          .select(["revoked_at", "expires_at"])
          .where("id", "=", shareId)
          .executeTakeFirst();
        if (!grant || grant.revoked_at || (grant.expires_at && new Date(grant.expires_at).getTime() < Date.now())) {
          return { status: 403, body: { error: { code: "revoked", message: "Access to this shared machine was revoked." } } };
        }
        const oc = await platform().devices.connections().getInternal(ownerOrg, ownerConnId);
        if (!oc?.credentials_enc) return { status: 502, body: { error: { code: "unavailable", message: "Shared machine unavailable." } } };
        const ownerCreds = (await platform().integrations.decryptCredentials(ownerOrg, oc.credentials_enc)) as { edge?: { driver?: unknown; config?: unknown } };
        const oe = ownerCreds.edge;
        const instance = id && oe && typeof oe.driver === "string" && oe.driver ? { id, driver: oe.driver, config: edgeDriverConfig(oe) } : undefined;
        const oeBridge = typeof (oe as { bridge?: unknown } | undefined)?.bridge === "string" ? ((oe as { bridge?: string }).bridge as string) : null;
        const res = await platform().edge.send(edgeChannelKey(ownerOrg, oeBridge), { path: r.path, method, body: r.body, ...(instance ? { instance } : {}) });
        void odb.updateTable("digifab_edge_shares").set({ last_used_at: new Date() }).where("id", "=", shareId).execute().catch(() => {});
        return { status: res.status, body: res.body };
      } finally {
        await platform().tenants.releaseIdleDb(ownerOrg);
      }
    };
  }

  // OWNER's own machine: the instance segment + the machine's config (driver +
  // host + key) ride WITH the request so a dynamic-config bridge configures the
  // driver on the fly. Omitted if no config stored (a static bridge routes by path).
  const instance = id && edge && typeof edge.driver === "string" && edge.driver
    ? { id, driver: edge.driver, config: edgeDriverConfig(edge) }
    : undefined;
  // Which bridge serves this connection (null = the workspace default bridge).
  const ownBridge = typeof (edge as { bridge?: unknown } | undefined)?.bridge === "string" ? ((edge as { bridge?: string }).bridge as string) : null;
  const ownKey = edgeChannelKey(orgId, ownBridge);
  return async (r) => {
    const res = await platform().edge.send(ownKey, {
      path: r.path,
      method: r.method === "POST" ? "POST" : "GET",
      body: r.body,
      ...(instance ? { instance } : {}),
    });
    return { status: res.status, body: res.body };
  };
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

  // Reprint-on-fail — a failed print with attempts left goes BACK to the queue
  // and re-sends instead of going terminal (no failed event, no bed-clear yet).
  // Pool jobs clear their device and re-drip; device-targeted jobs re-send to the
  // same printer. Out of attempts → fall through to the terminal path below.
  if (status === "failed") {
    const att = (job.attempts ?? 0) + 1;
    const max = job.max_attempts ?? 1;
    if (att < max) {
      const note = `auto-retry ${att}/${max}: ${error ?? "failed"}`.slice(0, 300);
      const base = { status: "queued", attempts: att, remote_job_id: null, remote_file_id: null, progress: 0, error: note, poll_errors: 0, last_polled_at: new Date(), updated_at: new Date() };
      if (job.target_pool) {
        await db.updateTable("digifab_jobs").set({ ...base, connection_id: null, target_device: null }).where("id", "=", jobId).execute();
        await kickAssign(orgId);
      } else {
        await db.updateTable("digifab_jobs").set(base).where("id", "=", jobId).execute();
        try {
          const r = await sendJob(db, orgId, jobId);
          if (r.ok && r.shouldPoll) await enqueuePoll(orgId, jobId);
        } catch {
          /* leave it queued for a manual retry */
        }
      }
      return { status: "queued", terminal: false };
    }
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

/** Queue commits the materials. When a just-placed job (status "sent") produces
 *  a build (BoM) and hasn't been consumed yet, fire `digifab.job.build_committed`
 *  ONCE — a seeded builds wire deducts the components from inventory + bumps the
 *  output part. The build_consumed_at guard (set atomically here) makes a re-send
 *  / recut idempotent. Best-effort: a failure never blocks the send. */
async function commitBuildIfLinked(
  db: Kysely<DigifabDB>,
  orgId: string,
  jobId: string,
  job: { linked_build_id: string | null; build_consumed_at: Date | null; build_qty: number | null },
  status: string,
): Promise<void> {
  if (status !== "sent" || !job.linked_build_id || job.build_consumed_at) return;
  const res = await db
    .updateTable("digifab_jobs")
    .set({ build_consumed_at: new Date() })
    .where("id", "=", jobId)
    .where("build_consumed_at", "is", null)
    .executeTakeFirst();
  // Only the writer that flipped null→now emits, so concurrent sends can't
  // double-consume even if they raced past the in-memory guard above.
  if (Number(res.numUpdatedRows ?? 0n) === 0) return;
  void platform().events.emit("digifab.job.build_committed", {
    orgId,
    jobId,
    buildId: job.linked_build_id,
    qty: job.build_qty != null ? Number(job.build_qty) : 1,
  });
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

  // HYBRID Bambu LAN: the cloud can't accept an arbitrary file, but the on-site
  // bridge can push it over the printer's LAN. If this Bambu printer has LAN
  // configured, route the upload + submit through the bridge's `bambu` driver
  // (cloud `driver` is still used above for listDevices/validation).
  let sendDriver = driver;
  if (deviceId) {
    const lan = await bambuLanDriverFor(orgId, job.connection_id, deviceId);
    if (lan) sendDriver = lan;
  }

  const up = await sendDriver.uploadFile(fileBytes, uploadName);
  const sub = await sendDriver.submitJob({ fileId: up.fileId, deviceId, tag: job.target_tag });
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
  await commitBuildIfLinked(db, orgId, jobId, job, status);
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
  await commitBuildIfLinked(db, orgId, jobId, job, status);
  if (sub.queued) {
    const placed = sub.deviceId ?? deviceId;
    const cam = await cameraFor(db, job.connection_id, placed);
    void notifyPrint(orgId, { kind: "started", jobId, fileRef: job.file_ref, device: placed, cameraUrl: cam, gramsUsed: job.material_grams != null ? Number(job.material_grams) : null });
  }
  return { ok: true, status, remoteJobId: sub.jobId ?? null, placement: sub, shouldPoll: !!(sub.queued && sub.jobId) };
}
