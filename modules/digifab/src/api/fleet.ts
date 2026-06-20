// /api/v1/orgs/:slug/modules/digifab/fleet — the live floor view.
//
// Coordinate-not-control at FLEET scale: for every enabled connection we ask
// its manager (FDM Monster / OctoPrint / Klipper / … via the driver) for the
// current device list + state, and overlay Cobblr's own in-flight jobs (file +
// progress) onto the matching device. Read-only — the UI polls this; nothing
// here streams gcode or drives hardware.
//
// Robust by connection: an unreachable manager returns an `error` on its own
// card instead of failing the whole fleet (one dead printer farm can't blank
// the view of the others).

import { Router, raw } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { putSnapshot, getSnapshot, freshSnapshotKeys } from "../snapshot-store.js";
import { getBambuStatusMap } from "../bambu-status-store.js";
import { buildDriverById } from "../jobs-core.js";
import { availableDriverKeys } from "../drivers/registry.js";
import { classify } from "../state.js";
import type { MachineDriver, RemoteDevice } from "../drivers/types.js";

export const fleetRouter = Router({ mergeParams: true });

const TERMINAL = ["completed", "failed", "cancelled"];

// F-11 — back-pressure on the per-connection listDevices fan-out. At 50 direct
// connections, a naive Promise.all hits 50 managers every 12s poll, in one
// request, with no cap and no fallback for a slow one. Three guards:
//   1. a short-TTL per-connection cache (a rapid re-poll / second viewer reuses
//      the last fetch instead of re-hitting the manager),
//   2. a per-call timeout so one slow manager can't stall the whole response,
//   3. a concurrency cap so the burst is bounded regardless of fleet size.
// The cache key is the connection id (a globally-unique uuid → tenant-safe);
// device *state* may be up to TTL stale, which is fine on an already-snapshot
// view (jobs/links/attention are still read fresh from the DB each request).
const DEVICE_CACHE_TTL_MS = 10_000;
const LIST_TIMEOUT_MS = 8_000;
const MAX_CONCURRENT_LISTS = 6;
type DeviceCacheEntry = { at: number; devices: RemoteDevice[] };
const deviceCache = new Map<string, DeviceCacheEntry>();

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

/** Cached + timeout-bounded device fetch for one connection. Fresh cache hit →
 *  reuse it; live-fetch error/timeout → fall back to the last-good cache (stale)
 *  if any, else rethrow so the caller renders the connection's error card. */
async function fetchDevicesCached(driver: MachineDriver, connId: string): Promise<{ devices: RemoteDevice[]; at: number }> {
  const now = Date.now();
  const hit = deviceCache.get(connId);
  if (hit && now - hit.at < DEVICE_CACHE_TTL_MS) return { devices: hit.devices, at: hit.at };
  try {
    const devices = await withTimeout(driver.listDevices(), LIST_TIMEOUT_MS, "listDevices timed out");
    const entry = { at: now, devices };
    deviceCache.set(connId, entry);
    return entry;
  } catch (err) {
    if (hit) return { devices: hit.devices, at: hit.at }; // stale-on-error: keep the floor visible
    throw err;
  }
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

fleetRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const orgId = tenantContext(req).org.id;
    const db = tenantDb(req);

    // Only connections digifab can drive — the store is shared with inventory's
    // Spoolman connection, which must not appear on the farm floor.
    const driveable = new Set(await availableDriverKeys(db));
    const conns = (await platform().devices.connections().list(orgId)).filter(
      (c) => c.enabled && driveable.has(c.type),
    );

    // Cobblr's in-flight jobs — overlaid onto the matching device by
    // (connection, target_device). One active job per device shown.
    const jobs = await db
      .selectFrom("digifab_jobs")
      .select(["id", "connection_id", "target_device", "file_ref", "status", "progress"])
      .where("status", "not in", TERMINAL)
      .execute();

    // Cobblr machine ↔ remote device links, so the UI can name the device by
    // the user's own machine (and a future Machines-page overlay can match).
    const links = await db
      .selectFrom("digifab_device_links")
      .select(["connection_id", "remote_device_id", "machine_id"])
      .execute();

    // Pool membership per device, so the UI can present a pool as ONE farm
    // (cards grouped by pool, even across connections).
    const poolRows = await db
      .selectFrom("digifab_pool_members as m")
      .innerJoin("digifab_pools as p", "p.id", "m.pool_id")
      .select(["m.connection_id", "m.remote_device_id", "p.id as pool_id", "p.name as pool_name"])
      .execute();

    // F-1: devices that finished/failed a print and need a human to clear the
    // bed before they can take new work (the assign worker skips these).
    const attention = await db
      .selectFrom("digifab_device_attention")
      .select(["connection_id", "remote_device_id", "reason", "created_at"])
      .execute();

    // Cockpit: per-device manual overrides (a camera URL the manager doesn't
    // report). Merged over any driver-reported camera below.
    const settings = await db
      .selectFrom("digifab_device_settings")
      .select(["connection_id", "remote_device_id", "camera_url", "snapshot_relay"])
      .execute();
    const freshSnaps = await freshSnapshotKeys(db); // which devices have a recent relayed frame

    const connections = await mapLimit(conns, MAX_CONCURRENT_LISTS, async (c) => {
        try {
          const driver = await buildDriverById(db, orgId, c.id);
          if (!driver) {
            return { connection_id: c.id, label: c.label, type: c.type, error: "driver unavailable", fetched_at: null, devices: [] };
          }
          const { devices, at } = await fetchDevicesCached(driver, c.id);
          // For a cloud Bambu, prefer the live MQTT telemetry the pump caches
          // (real-time temps/progress/state) over the slower HTTP list.
          const bambuLive = c.type === "bambu" ? await getBambuStatusMap(db, c.id) : null;
          const mapped = devices.map((d) => {
            const job = jobs.find((j) => j.connection_id === c.id && j.target_device === d.id) ?? null;
            const link = links.find((l) => l.connection_id === c.id && l.remote_device_id === d.id) ?? null;
            const pool = poolRows.find((p) => p.connection_id === c.id && p.remote_device_id === d.id) ?? null;
            const att = attention.find((a) => a.connection_id === c.id && a.remote_device_id === d.id) ?? null;
            const setting = settings.find((s) => s.connection_id === c.id && s.remote_device_id === d.id) ?? null;
            const live = bambuLive?.get(d.id) ?? null;
            const state = live?.state ?? d.state ?? "unknown";
            return {
              id: d.id,
              name: d.name,
              state,
              klass: classify(state),
              enabled: d.enabled,
              tags: d.tags ?? [],
              linked_machine_id: link?.machine_id ?? null,
              pool_id: pool?.pool_id ?? null,
              pool_name: pool?.pool_name ?? null,
              // Cockpit: live temps — the Bambu cloud-MQTT pump's reading wins
              // over the slower driver-reported one when fresh. Embed-only.
              temps: live?.temps ?? d.temps ?? null,
              // Current job sub-stage (preheating/leveling/…) when reported —
              // answers "why isn't it printing yet". Display-only.
              stage: live?.stage ?? d.stage ?? null,
              // Real-time print progress straight from the printer (Bambu cloud
              // MQTT), for a print Cobblr didn't start so there's no active_job.
              live: live
                ? { progress: live.progress, remaining_min: live.remaining_min, layer_num: live.layer_num, total_layers: live.total_layers }
                : null,
              camera_url: setting?.camera_url ?? d.camera_url ?? null,
              // Snapshot relay (opt-in, off by default). When on AND a fresh
              // agent-pushed frame exists, the web auth-fetches it from the
              // /snapshot route (remote-viewable) instead of the LAN camera_url.
              snapshot_relay: setting?.snapshot_relay ?? false,
              snapshot_fresh: !!setting?.snapshot_relay && freshSnaps.has(`${c.id}:${d.id}`),
              // F-1: needs a bed-clear ack before it's assignable again.
              needs_attention: att ? { reason: att.reason, since: att.created_at } : null,
              active_job: job
                ? { id: job.id, file_ref: job.file_ref, status: job.status, progress: job.progress }
                : null,
            };
          });
          return { connection_id: c.id, label: c.label, type: c.type, error: null, fetched_at: new Date(at).toISOString(), devices: mapped };
        } catch (err) {
          return {
            connection_id: c.id,
            label: c.label,
            type: c.type,
            error: (err as Error).message?.slice(0, 160) || "unreachable",
            fetched_at: null,
            devices: [],
          };
        }
      },
    );

    const all = connections.flatMap((c) => c.devices);
    const summary = {
      devices: all.length,
      printing: all.filter((d) => d.klass === "printing").length,
      idle: all.filter((d) => d.klass === "idle").length,
      offline: all.filter((d) => d.klass === "offline").length,
      error: all.filter((d) => d.klass === "error").length,
      connections: connections.length,
      connections_down: connections.filter((c) => c.error).length,
      needs_attention: all.filter((d) => d.needs_attention).length,
    };

    res.json({ connections, summary });
  }),
);

// F-1 + F-13: a human clears the bed and gives the verdict — "this printer is
// cleared; did the print come out good?". Clearing always frees the printer for
// the assign worker. The verdict drives the per-effect policy (F-13):
//   good     → emit digifab.print.confirmed → the linked task closes now (the
//              consequential effect we deliberately held back from `completed`).
//   scrapped → emit digifab.print.reversed → undo the optimistic effects that
//              already fired on `completed` (add the filament back, un-accrue the
//              machine usage). The task is NOT closed.
// Only a *completed*-print attention has effects to confirm/reverse; a
// failed-print attention just gets cleared (a failed print fired nothing).
const ReadyBody = z.object({ outcome: z.enum(["good", "scrapped"]).default("good") });
fleetRouter.post(
  "/:connectionId/:deviceId/ready",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = tenantContext(req).org.id;
    const db = tenantDb(req);
    const outcome = ReadyBody.parse(req.body ?? {}).outcome;
    const connectionId = req.params.connectionId!;
    const deviceId = req.params.deviceId!;

    const att = await db
      .selectFrom("digifab_device_attention")
      .select(["job_id", "reason"])
      .where("connection_id", "=", connectionId)
      .where("remote_device_id", "=", deviceId)
      .executeTakeFirst();

    // Resolve the print's downstream context from its job, for the wires.
    if (att?.reason === "print-completed" && att.job_id) {
      const job = await db
        .selectFrom("digifab_jobs")
        .select(["id", "linked_task_id", "linked_machine_id", "material_part_id", "material_grams"])
        .where("id", "=", att.job_id)
        .executeTakeFirst();
      if (job) {
        if (outcome === "good") {
          // Fire the held-back consequential effect: close the linked task.
          void platform().events.emit("digifab.print.confirmed", {
            orgId,
            jobId: job.id,
            linkedTaskId: job.linked_task_id,
            linkedMachineId: job.linked_machine_id,
          });
        } else {
          // Reverse the optimistic effects. The reverse event mirrors the
          // forward payload shape so the SAME inventory/machines handlers run:
          // +grams back on the spool, −1 off the machine's print count.
          const grams = job.material_grams != null ? Number(job.material_grams) : null;
          void platform().events.emit("digifab.print.reversed", {
            orgId,
            jobId: job.id,
            ...(job.material_part_id && grams && grams > 0
              ? { partId: job.material_part_id, delta: grams, reason: "Scrapped print" }
              : {}),
            linkedMachineId: job.linked_machine_id,
            prints: -1,
          });
        }
      }
    }

    await db
      .deleteFrom("digifab_device_attention")
      .where("connection_id", "=", connectionId)
      .where("remote_device_id", "=", deviceId)
      .execute();
    res.json({ ok: true, outcome });
  }),
);

// Cockpit: set (or clear) a device's camera stream URL — a manual override for a
// manager that doesn't report one. Upserts the per-device settings row.
const CameraBody = z.object({ camera_url: z.string().url().max(1000).nullable() });
fleetRouter.post(
  "/:connectionId/:deviceId/camera",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const parsed = CameraBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "camera_url must be a URL or null" } });
    const connectionId = req.params.connectionId!;
    const deviceId = req.params.deviceId!;
    await db
      .insertInto("digifab_device_settings")
      .values({ connection_id: connectionId, remote_device_id: deviceId, camera_url: parsed.data.camera_url })
      .onConflict((oc) =>
        oc.columns(["connection_id", "remote_device_id"]).doUpdateSet({ camera_url: parsed.data.camera_url, updated_at: new Date() }),
      )
      .execute();
    res.json({ ok: true, camera_url: parsed.data.camera_url });
  }),
);

// Snapshot relay — opt-in, OFF by default. Toggle whether the cloud accepts +
// serves agent-pushed frames for this device (for remote viewing).
const RelayToggle = z.object({ enabled: z.boolean() });
fleetRouter.post(
  "/:connectionId/:deviceId/snapshot-relay",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const parsed = RelayToggle.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "enabled must be a boolean" } });
    await db
      .insertInto("digifab_device_settings")
      .values({ connection_id: req.params.connectionId!, remote_device_id: req.params.deviceId!, snapshot_relay: parsed.data.enabled })
      .onConflict((oc) =>
        oc.columns(["connection_id", "remote_device_id"]).doUpdateSet({ snapshot_relay: parsed.data.enabled, updated_at: new Date() }),
      )
      .execute();
    res.json({ ok: true, snapshot_relay: parsed.data.enabled });
  }),
);

// Resolve `:connectionId` — "self" means "this workspace's tunnelled edge
// connection" (base_url cobblr-edge://), so the edge agent can push snapshots
// WITHOUT knowing its Cobblr connection id. Returns null if there's no (or an
// ambiguous) tunnelled connection.
async function resolveSelfConnection(orgId: string, connectionId: string): Promise<string | null> {
  if (connectionId !== "self") return connectionId;
  const conns = await platform().devices.connections().list(orgId);
  const edge = conns.filter((c) => c.enabled && c.type === "edge_adapter" && /^cobblr-edge:/i.test(c.base_url || ""));
  return edge.length === 1 ? edge[0]!.id : (edge[0]?.id ?? null);
}

// The edge agent PUSHES the latest webcam frame here (raw JPEG body) — only when
// the workspace owner enabled the relay for this device. Stored in the tenant DB
// + served back by GET below. The agent dials out, so this is a normal
// authenticated POST. Use connectionId "self" to auto-resolve (no id to paste).
fleetRouter.post(
  "/:connectionId/:deviceId/snapshot",
  raw({ type: ["image/jpeg", "application/octet-stream"], limit: "4mb" }),
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = tenantContext(req).org.id;
    const db = tenantDb(req);
    const connectionId = await resolveSelfConnection(orgId, req.params.connectionId!);
    if (!connectionId) return void res.status(404).json({ error: { code: "no_connection", message: "no tunnelled edge connection for 'self'" } });
    const deviceId = req.params.deviceId!;
    // Honour the off-switch: drop the push unless the relay is enabled.
    const setting = await db
      .selectFrom("digifab_device_settings")
      .select(["snapshot_relay"])
      .where("connection_id", "=", connectionId)
      .where("remote_device_id", "=", deviceId)
      .executeTakeFirst();
    if (!setting?.snapshot_relay) return void res.status(409).json({ error: { code: "relay_off", message: "snapshot relay is off for this device" } });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !(await putSnapshot(db, connectionId, deviceId, body))) {
      return void res.status(400).json({ error: { code: "bad_frame", message: "expected a JPEG body ≤4MB" } });
    }
    res.json({ ok: true });
  }),
);

// Serve the latest relayed frame (the web auth-fetches it for the fleet card).
fleetRouter.get(
  "/:connectionId/:deviceId/snapshot",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const jpeg = await getSnapshot(tenantDb(req), req.params.connectionId!, req.params.deviceId!);
    if (!jpeg) return void res.status(404).json({ error: { code: "no_snapshot", message: "no recent frame" } });
    res.setHeader("content-type", "image/jpeg");
    res.setHeader("cache-control", "no-store");
    res.send(jpeg);
  }),
);
