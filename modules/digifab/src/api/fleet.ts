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
import { buildDriverById, bambuLanDriverFor, parseBambuLan, bambuLanMode, reverseBuildIfCommitted, sendJob, type BambuLan } from "../jobs-core.js";
import { enqueuePoll } from "../poll-worker.js";
import { recordRunVerdict } from "../runs-core.js";
import { availableDriverKeys } from "../drivers/registry.js";
import { ownedDeviceRefs } from "../detectors/owned.js";
import { classify } from "../state.js";
import type { MachineDriver, RemoteDevice } from "../drivers/types.js";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { readCachedList, readCachedInfo, refreshList, ensureInfo, ensureWarming } from "../printer-file-cache.js";

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

/** The driver to use for on-machine FILE ops (list / info / print-existing).
 *  A Bambu connection's CLOUD driver can't touch files — those go over the LAN
 *  bridge (FTPS + MQTT) — so prefer the per-printer LAN driver when configured,
 *  exactly like the camera + control routes. Any other connection just uses its
 *  normal driver. */
async function fileDriverFor(
  db: Kysely<DigifabDB>,
  orgId: string,
  connId: string,
  deviceId: string,
): Promise<MachineDriver | null> {
  const lan = await bambuLanDriverFor(orgId, connId, deviceId);
  return lan ?? (await buildDriverById(db, orgId, connId));
}

/** Persist one connection's last-good device list (survives process restarts —
 *  the durable half of the stale-while-revalidate below). */
async function putDeviceCacheRow(db: Kysely<DigifabDB>, connId: string, devices: RemoteDevice[]): Promise<void> {
  try {
    await db
      .insertInto("digifab_fleet_device_cache")
      .values({ connection_id: connId, devices: JSON.stringify(devices) as never, fetched_at: new Date() })
      .onConflict((oc) => oc.column("connection_id").doUpdateSet({ devices: JSON.stringify(devices) as never, fetched_at: new Date() }))
      .execute();
  } catch (err) {
    console.warn(`[digifab] fleet device-cache write failed for ${connId}:`, (err as Error).message);
  }
}

// One in-flight background refresh per connection — a burst of stale-serves
// must not stack N live fetches onto one slow manager.
const refreshing = new Set<string>();

/** Cached + timeout-bounded device fetch for one connection, served
 *  STALE-WHILE-REVALIDATE so the fleet answers instantly:
 *    fresh memory hit (≤10s) → serve it.
 *    anything older — the memory entry, or the DURABLE per-connection row
 *    (survives restarts) → serve it IMMEDIATELY (marked stale) and kick ONE
 *    detached live refresh; the next poll gets fresh state.
 *    nothing cached at all (first ever look) → block on the live fetch.
 *  Live-fetch error → last-good cache if any, else rethrow so the caller
 *  renders the connection's error card. */
async function fetchDevicesCached(
  db: Kysely<DigifabDB>,
  driver: MachineDriver,
  connId: string,
): Promise<{ devices: RemoteDevice[]; at: number; stale: boolean }> {
  const now = Date.now();
  const hit = deviceCache.get(connId);
  if (hit && now - hit.at < DEVICE_CACHE_TTL_MS) return { devices: hit.devices, at: hit.at, stale: false };

  const liveFetch = async (): Promise<{ devices: RemoteDevice[]; at: number }> => {
    const devices = await withTimeout(driver.listDevices(), LIST_TIMEOUT_MS, "listDevices timed out");
    const entry = { at: Date.now(), devices };
    deviceCache.set(connId, entry);
    void putDeviceCacheRow(db, connId, devices);
    return entry;
  };

  // A stale memory entry, or the durable row from before a restart → serve it
  // now, refresh detached.
  let stale = hit ?? null;
  if (!stale) {
    try {
      const row = await db
        .selectFrom("digifab_fleet_device_cache")
        .select(["devices", "fetched_at"])
        .where("connection_id", "=", connId)
        .executeTakeFirst();
      if (row) {
        const devices = (typeof row.devices === "string" ? JSON.parse(row.devices) : row.devices) as RemoteDevice[];
        if (Array.isArray(devices)) stale = { at: new Date(row.fetched_at).getTime(), devices };
      }
    } catch {
      /* unreadable row → treat as no cache */
    }
  }
  if (stale) {
    if (!refreshing.has(connId)) {
      refreshing.add(connId);
      void liveFetch()
        .catch(() => {})
        .finally(() => refreshing.delete(connId));
    }
    // Seed memory for the stale-on-error window — but never clobber an entry a
    // just-finished background refresh may have written.
    if (!deviceCache.has(connId)) deviceCache.set(connId, stale);
    return { devices: stale.devices, at: stale.at, stale: true };
  }

  // First ever look at this connection — nothing to serve, wait for live.
  try {
    return { ...(await liveFetch()), stale: false };
  } catch (err) {
    const fallback = deviceCache.get(connId);
    if (fallback) return { devices: fallback.devices, at: fallback.at, stale: true };
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
      .select(["id", "connection_id", "target_device", "target_pool", "file_ref", "status", "progress", "priority", "attempts", "max_attempts", "eta_sec", "created_at"])
      .where("status", "not in", TERMINAL)
      .execute();
    // Farm view "next up": the highest-priority queued job aimed at a device
    // (directly, or at a pool the device belongs to). Shown on the tile so an
    // operator sees what each machine will do next, not just what it's doing.
    const queuedSorted = jobs
      .filter((j) => j.status === "queued")
      .sort((a, b) => b.priority - a.priority || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    // Cobblr machine ↔ remote device links, so the UI can name the device by
    // the user's own machine (and a future Machines-page overlay can match).
    const links = await db
      .selectFrom("digifab_device_links")
      .select(["connection_id", "remote_device_id", "machine_id"])
      .execute();
    // One machine, two lenses (machines-digifab-unification.md §3): resolve
    // each linked machine through the entity registry so the tile wears the
    // machine's own name/photo/lifecycle state. Batched, exposable-fields-
    // projected; a resolver failure degrades to connection-side identity.
    const machineById = new Map<string, { name: string; image_path: string | null; state: string | null; detail_url: string | null }>();
    const machineRefs = [...new Set(links.map((l) => l.machine_id))].map((id) => ({ kind: "machines:machine", id }));
    if (machineRefs.length) {
      try {
        for (const m of await platform().entities.lookupMany(orgId, machineRefs)) {
          machineById.set(m.id, {
            name: m.title,
            image_path: (m.fields?.image_path as string | null) ?? null,
            state: (m.fields?.state as string | null) ?? null,
            // The registry knows which collection this machine lives in and
            // builds the correct clean URL (instance-aware) — the tile's
            // "Open machine" click-through rides this, no instance guessing here.
            detail_url: m.detailUrl ?? null,
          });
        }
      } catch {
        /* machines module absent/unreadable → tiles keep connection identity */
      }
    }

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
      .select(["connection_id", "remote_device_id", "camera_url", "snapshot_relay", "grid_x", "grid_y", "sort_order", "row_break"])
      .execute();
    const freshSnaps = await freshSnapshotKeys(db); // which devices have a recent relayed frame
    // AI failure-watch state per device (one query for the whole floor).
    const failureRows = await db
      .selectFrom("digifab_failure_watch")
      .select(["connection_id", "device_id", "score", "paused_at", "watch_at"])
      .execute();
    // Printers an external detector owns — Cobblr stands down its camera pull for
    // them (the detector handles detection); one query for the whole floor.
    const owned = await ownedDeviceRefs(db);

    const connections = await mapLimit(conns, MAX_CONCURRENT_LISTS, async (c) => {
        try {
          const driver = await buildDriverById(db, orgId, c.id);
          if (!driver) {
            return { connection_id: c.id, label: c.label, type: c.type, error: "driver unavailable", fetched_at: null, devices: [] };
          }
          const { devices, at, stale } = await fetchDevicesCached(db, driver, c.id);
          // For a cloud Bambu, prefer the live MQTT telemetry the pump caches
          // (real-time temps/progress/state) over the slower HTTP list.
          const bambuLive = c.type === "bambu" ? await getBambuStatusMap(db, c.id) : null;
          // Per-printer LAN config → the cams wall knows this device has a real
          // camera reachable over the bridge (the cockpit's /camera route), even
          // with no manual camera_url and no snapshot relay.
          let bambuLan: Record<string, BambuLan> = {};
          if (c.type === "bambu") {
            try {
              const internal = await platform().devices.connections().getInternal(orgId, c.id);
              if (internal?.credentials_enc) {
                bambuLan = parseBambuLan(await platform().integrations.decryptCredentials(orgId, internal.credentials_enc));
              }
            } catch {
              /* creds unreadable → no LAN camera flag, nothing else degrades */
            }
          }
          const mapped = devices.map((d) => {
            const job = jobs.find((j) => j.connection_id === c.id && j.target_device === d.id && j.status !== "queued") ?? null;
            const next = queuedSorted.find(
              (j) => (j.connection_id === c.id && j.target_device === d.id) || (j.target_pool != null && j.target_pool === (poolRows.find((p) => p.connection_id === c.id && p.remote_device_id === d.id)?.pool_id ?? "")),
            ) ?? null;
            const link = links.find((l) => l.connection_id === c.id && l.remote_device_id === d.id) ?? null;
            const pool = poolRows.find((p) => p.connection_id === c.id && p.remote_device_id === d.id) ?? null;
            const att = attention.find((a) => a.connection_id === c.id && a.remote_device_id === d.id) ?? null;
            const setting = settings.find((s) => s.connection_id === c.id && s.remote_device_id === d.id) ?? null;
            const fw = failureRows.find((f) => f.connection_id === c.id && f.device_id === d.id) ?? null;
            const live = bambuLive?.get(d.id) ?? null;
            const state = live?.state ?? d.state ?? "unknown";
            // Owned by an external detector → the detector handles the camera +
            // detection; Cobblr reports no camera source so nothing here pulls it.
            const managedByDetector = owned.has(`${c.id}:${d.id}`);
            return {
              id: d.id,
              name: d.name,
              state,
              klass: classify(state),
              enabled: d.enabled,
              tags: d.tags ?? [],
              linked_machine_id: link?.machine_id ?? null,
              // The linked machine's own identity — lets the tile BE the
              // machine (title/photo) instead of a parallel connection-side
              // identity. Null when unlinked or the machine didn't resolve.
              linked_machine:
                link && machineById.has(link.machine_id)
                  ? { id: link.machine_id, ...machineById.get(link.machine_id)! }
                  : null,
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
              // An external detector owns this printer's detection + camera.
              managed_by_detector: managedByDetector,
              // Camera fields are suppressed for a detector-owned printer so
              // neither the camera wall nor the relay pulls the same stream the
              // detector already owns (the single-owner rule).
              camera_url: managedByDetector ? null : (setting?.camera_url ?? d.camera_url ?? null),
              // The bridge can grab frames from this printer's own camera (the
              // cockpit /camera route) — lets the camera wall show it without a
              // manual URL or the snapshot relay.
              lan_camera: !managedByDetector && !!bambuLan[d.id]?.host && !!bambuLan[d.id]?.access_code && bambuLanMode(bambuLan[d.id]) !== "cloud",
              // Snapshot relay (opt-in, off by default). When on AND a fresh
              // agent-pushed frame exists, the web auth-fetches it from the
              // /snapshot route (remote-viewable) instead of the LAN camera_url.
              snapshot_relay: !managedByDetector && (setting?.snapshot_relay ?? false),
              snapshot_fresh: !managedByDetector && !!setting?.snapshot_relay && freshSnaps.has(`${c.id}:${d.id}`),
              // ⑦ Spatial floor position (null = unplaced, flows after placed).
              position: setting?.grid_x != null && setting?.grid_y != null ? { x: setting.grid_x, y: setting.grid_y } : null,
              // Free-form layout: order in the flow + explicit row start.
              sort_order: setting?.sort_order ?? null,
              row_break: setting?.row_break ?? false,
              // F-1: needs a bed-clear ack before it's assignable again.
              needs_attention: att ? { reason: att.reason, since: att.created_at } : null,
              // AI failure watch: live score while printing + whether it auto-paused.
              failure: fw && (fw.watch_at || fw.paused_at) ? { score: Number(fw.score), watching: !!fw.watch_at, paused: !!fw.paused_at } : null,
              active_job: job
                ? { id: job.id, file_ref: job.file_ref, status: job.status, progress: job.progress, priority: job.priority, attempts: job.attempts, max_attempts: job.max_attempts, eta_sec: job.eta_sec }
                : null,
              // What this machine will do next (queued to it or its pool).
              next_job: next ? { id: next.id, file_ref: next.file_ref, pooled: !!next.target_pool } : null,
            };
          });
          return { connection_id: c.id, label: c.label, type: c.type, error: null, fetched_at: new Date(at).toISOString(), stale, devices: mapped };
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

    // Any connection served from a stale cache → the client knows a quick
    // follow-up refetch will have fresher state (the detached refresh is
    // already running server-side).
    const stale = connections.some((c) => (c as { stale?: boolean }).stale);
    res.json({ connections, summary, stale });
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
      // Production runs: the human verdict is what counts a plate — good
      // increments the run (and may close it), scrapped marks the plate
      // non-covering so the assign worker mints a replacement. Idempotent.
      await recordRunVerdict(db, orgId, att.job_id, outcome);
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
          // A scrapped print never produced its build's output either — undo the
          // send-time component consumption + output credit (idempotent).
          await reverseBuildIfCommitted(db, orgId, job.id, "print scrapped at bed clear");
        }
      }
    }

    await db
      .deleteFrom("digifab_device_attention")
      .where("connection_id", "=", connectionId)
      .where("remote_device_id", "=", deviceId)
      .execute();

    // Bed cleared → resume anything that was HELD for it: a device-targeted
    // auto-retry sits `queued` (jobs-core wrote the attention row instead of
    // re-sending onto a dirty bed); send it now. Pool retries resume via the
    // assign worker's normal attention check — just kick a pass.
    const held = await db
      .selectFrom("digifab_jobs")
      .select(["id"])
      .where("status", "=", "queued")
      .where("connection_id", "=", connectionId)
      .where("target_device", "=", deviceId)
      .where("target_pool", "is", null)
      .where("attempts", ">", 0)
      .execute();
    for (const h of held) {
      try {
        const r = await sendJob(db, orgId, h.id);
        if (r.ok && r.shouldPoll) await enqueuePoll(orgId, h.id);
      } catch {
        /* left queued — visible in the queue with its retry note */
      }
    }
    void import("../assign-worker.js").then((m) => m.kickAssign(orgId)).catch(() => {});
    res.json({ ok: true, outcome, resumed: held.length });
  }),
);

// Cockpit: set (or clear) a device's camera stream URL — a manual override for a
// manager that doesn't report one. Upserts the per-device settings row.
// ⑦ Pin (or unpin) a device to a floor-grid cell — the fleet arrange mode.
const PositionBody = z.object({ x: z.number().int().min(0).max(63).nullable(), y: z.number().int().min(0).max(255).nullable() });
fleetRouter.put(
  "/:connectionId/:deviceId/position",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = PositionBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "x + y (or nulls to unpin) required" } });
    const db = tenantDb(req);
    await db
      .insertInto("digifab_device_settings")
      .values({ connection_id: req.params.connectionId!, remote_device_id: req.params.deviceId!, grid_x: parsed.data.x, grid_y: parsed.data.y })
      .onConflict((oc) => oc.columns(["connection_id", "remote_device_id"]).doUpdateSet({ grid_x: parsed.data.x, grid_y: parsed.data.y, updated_at: new Date() }))
      .execute();
    res.json({ ok: true });
  }),
);

// Free-form fleet layout — the whole floor in one PUT: an ordered device list
// with explicit row starts. Replaces the 0027 cell-grid arrange UX (the tiles
// themselves are the layout; rows can be partial). Devices NOT in the list keep
// their settings row but lose any manual order (they flow in the trailing
// "unplaced" row). Per-workspace, like every settings row here.
const LayoutBody = z.object({
  items: z
    .array(
      z.object({
        connection_id: z.string().min(1).max(200),
        device_id: z.string().min(1).max(200),
        row_break: z.boolean().optional(),
      }),
    )
    .max(500),
});
fleetRouter.put(
  "/layout",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = LayoutBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "items: [{connection_id, device_id, row_break?}] required" } });
    const db = tenantDb(req);
    // Clear stale order everywhere first, so a device dropped from the list
    // reverts to unplaced instead of keeping a phantom slot.
    await db.updateTable("digifab_device_settings").set({ sort_order: null, row_break: false, updated_at: new Date() }).execute();
    let i = 0;
    for (const it of parsed.data.items) {
      const fields = { sort_order: i * 10, row_break: it.row_break ?? false, updated_at: new Date() };
      await db
        .insertInto("digifab_device_settings")
        .values({ connection_id: it.connection_id, remote_device_id: it.device_id, ...fields })
        .onConflict((oc) => oc.columns(["connection_id", "remote_device_id"]).doUpdateSet(fields))
        .execute();
      i++;
    }
    res.json({ ok: true, placed: i });
  }),
);

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

// ── Generic live controls ────────────────────────────────────────────────────
// The driver DECLARES what a device can do (pause/resume/stop/jog/light/temps +
// custom); the UI renders only those + runs them here. So a printer shows exactly
// what it supports, across every manager.
fleetRouter.get(
  "/:connectionId/:deviceId/controls",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const orgId = tenantContext(req).org.id;
    const driver = await buildDriverById(tenantDb(req), orgId, req.params.connectionId!);
    const controls = driver?.listControls ? await driver.listControls(req.params.deviceId!) : [];
    res.json({ controls });
  }),
);

// The gcode files on the printer's storage — served from the DURABLE backend
// cache (digifab_printer_files), kept warm by the background warmer, so a modal
// open never touches the machine. We only pull live on the first-ever request
// (no cache yet) or an explicit ?refresh=1; every request (re)starts the warm
// loop so the list + thumbnails stay current on the backend's schedule.
fleetRouter.get(
  "/:connectionId/:deviceId/files",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const connId = req.params.connectionId!;
    const deviceId = req.params.deviceId!;
    const refresh = req.query.refresh === "1";
    const cached = await readCachedList(db, connId, deviceId);
    let files = cached.files;
    let live = false;
    if (refresh || cached.listFetchedAt == null) {
      const driver = await fileDriverFor(db, orgId, connId, deviceId);
      if (driver?.listFiles) {
        try {
          files = await withTimeout(refreshList(db, driver, connId, deviceId), 15_000, "listFiles timed out");
          live = true;
        } catch {
          /* printer unreachable → serve whatever's cached (possibly empty) */
        }
      }
    }
    await ensureWarming(db, orgId, connId, deviceId).catch(() => {});
    res.json({ files, cached: !live, at: (cached.listFetchedAt ?? new Date()).toISOString() });
  }),
);

// Slicer metadata + embedded thumbnail for one file — served from the durable
// cache (fetched once, immutable per file). A cache miss (the warmer hasn't
// reached this file yet) pulls it live once and persists it, so the rows you
// look at first fill in immediately while the rest backfill in the background.
fleetRouter.get(
  "/:connectionId/:deviceId/fileinfo",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) return void res.status(400).json({ error: { code: "bad_query", message: "name required" } });
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const connId = req.params.connectionId!;
    const deviceId = req.params.deviceId!;
    const cached = await readCachedInfo(db, connId, deviceId, name);
    if (cached.fetched) return void res.json({ info: cached.info, cached: true });
    const driver = await fileDriverFor(db, orgId, connId, deviceId);
    if (!driver?.fileInfo) return void res.json({ info: null, cached: false });
    try {
      const info = await withTimeout(ensureInfo(db, driver, connId, deviceId, name), 15_000, "fileInfo timed out");
      return void res.json({ info, cached: false });
    } catch (e) {
      return void res.status(502).json({ error: { code: "fileinfo_failed", message: (e as Error).message } });
    }
  }),
);

const ControlBody = z.object({ id: z.string().min(1).max(60), params: z.record(z.unknown()).optional() });
fleetRouter.post(
  "/:connectionId/:deviceId/control",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = ControlBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "control id required" } });
    const orgId = tenantContext(req).org.id;
    // Prefer the LAN driver when this printer has LAN configured (more reliable
    // than cloud, and the only path that works if cloud rejects the command).
    const lan = await bambuLanDriverFor(orgId, req.params.connectionId!, req.params.deviceId!);
    const driver = lan ?? (await buildDriverById(tenantDb(req), orgId, req.params.connectionId!));
    if (!driver?.runControl) return void res.status(501).json({ error: { code: "unsupported", message: "this printer can't be controlled here" } });
    const r = await driver.runControl(req.params.deviceId!, parsed.data.id, parsed.data.params ?? {});
    if (!r.ok) return void res.status(502).json({ error: { code: "control_failed", message: r.detail ?? "command not accepted by the printer" } });
    res.json({ ok: true, ref: r.ref });
  }),
);

// Start a file ALREADY on the printer's storage (from the file list) — no upload.
const PrintBody = z.object({ name: z.string().min(1).max(300) });
fleetRouter.post(
  "/:connectionId/:deviceId/print",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = PrintBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "file name required" } });
    const driver = await fileDriverFor(tenantDb(req), tenantContext(req).org.id, req.params.connectionId!, req.params.deviceId!);
    if (!driver?.printFile) return void res.status(501).json({ error: { code: "unsupported", message: "this printer can't start an on-disk file here" } });
    const r = await driver.printFile(req.params.deviceId!, parsed.data.name);
    if (!r.ok) return void res.status(502).json({ error: { code: "print_failed", message: r.detail ?? "the printer didn't accept the print" } });
    res.json({ ok: true, ref: r.ref });
  }),
);

// ── Per-printer Bambu LAN access (hybrid) — store host + access code so the
// on-site bridge can push files / control over the printer's LAN, while cloud
// keeps doing telemetry. The access code is a credential → stored encrypted in
// the connection's creds (creds.bambu_lan = { serial: { host, access_code } }).
const LanBody = z.object({
  host: z.string().max(200).optional(),
  access_code: z.string().max(64).optional(),
  mode: z.enum(["cloud", "prefer_lan", "lan_only"]).optional(),
});
async function readLanMap(orgId: string, connId: string): Promise<{ conn: { id: string; type: string; credentials_enc: string | null } | null; map: Record<string, BambuLan> }> {
  const conn = await platform().devices.connections().getInternal(orgId, connId);
  if (!conn) return { conn: null, map: {} };
  const creds = conn.credentials_enc ? await platform().integrations.decryptCredentials(orgId, conn.credentials_enc) : {};
  return { conn: { id: conn.id, type: conn.type, credentials_enc: conn.credentials_enc }, map: parseBambuLan(creds) };
}
fleetRouter.put(
  "/:connectionId/:deviceId/lan",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = LanBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "host + access_code required" } });
    const orgId = tenantContext(req).org.id;
    const { conn, map } = await readLanMap(orgId, req.params.connectionId!);
    if (!conn || conn.type !== "bambu") return void res.status(400).json({ error: { code: "not_bambu", message: "LAN access is for Bambu connections" } });
    // Merge — host/access_code on first enable; mode can change on its own later.
    const prev = map[req.params.deviceId!] ?? { host: "", access_code: "" };
    const host = (parsed.data.host ?? prev.host).trim();
    const access_code = (parsed.data.access_code ?? prev.access_code).trim();
    if (!host || !access_code) return void res.status(400).json({ error: { code: "incomplete", message: "host + access_code required to enable LAN" } });
    map[req.params.deviceId!] = { host, access_code, mode: parsed.data.mode ?? prev.mode ?? "prefer_lan" };
    await platform().devices.connections().update(orgId, conn.id, { creds: { bambu_lan: JSON.stringify(map) } });
    res.json({ ok: true, host, mode: map[req.params.deviceId!]!.mode });
  }),
);
fleetRouter.delete(
  "/:connectionId/:deviceId/lan",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = tenantContext(req).org.id;
    const { conn, map } = await readLanMap(orgId, req.params.connectionId!);
    if (!conn) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    delete map[req.params.deviceId!];
    await platform().devices.connections().update(orgId, conn.id, { creds: { bambu_lan: JSON.stringify(map) } });
    res.json({ ok: true });
  }),
);

// GET …/camera — one JPEG frame from the printer's LAN camera, over the bridge
// (Bambu A1/P1 chamber camera). A refreshing still; the modal polls it. LAN-only.
fleetRouter.get(
  "/:connectionId/:deviceId/camera",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const orgId = tenantContext(req).org.id;
    const driver = await bambuLanDriverFor(orgId, req.params.connectionId!, req.params.deviceId!);
    if (!driver?.getCameraFrame) return void res.status(501).json({ error: { code: "no_camera", message: "no LAN camera for this printer" } });
    const jpeg = await driver.getCameraFrame();
    if (!jpeg || jpeg.length === 0) return void res.status(502).json({ error: { code: "camera_failed", message: "couldn't grab a camera frame" } });
    // Cache the frame so the next modal-open can show it INSTANTLY (via /snapshot)
    // instead of 3s of "connecting" while the live grab runs. Best-effort.
    void putSnapshot(tenantDb(req), req.params.connectionId!, req.params.deviceId!, jpeg).catch(() => {});
    res.set("Content-Type", "image/jpeg").set("Cache-Control", "no-store").send(jpeg);
  }),
);

// ── Rich live detail — the captured Bambu MQTT report, distilled for the printer
// modal: AMS filament slots (color/material/remaining), chamber light, firmware
// update, HMS error count, temps. Empty for non-Bambu / no live stream.
function bHex(c: unknown): string | null {
  if (typeof c !== "string" || !/^[0-9a-fA-F]{6,8}$/.test(c)) return null;
  const rgb = c.slice(0, 6).toUpperCase();
  return rgb === "000000" && c.length === 8 && c.slice(6).toUpperCase() === "00" ? null : `#${rgb}`;
}
function bNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
fleetRouter.get(
  "/:connectionId/:deviceId/detail",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    // LAN config for this printer (hybrid) — surfaced so the modal can show the
    // "LAN access" state. Host only; never the access code.
    const { conn: lanConn, map: lanMap } = await readLanMap(tenantContext(req).org.id, req.params.connectionId!);
    const lanCfg = lanMap[req.params.deviceId!];
    // Camera available when LAN is configured (Bambu chamber cam via the bridge).
    const lan = { applicable: lanConn?.type === "bambu", configured: !!lanCfg, host: lanCfg?.host, mode: bambuLanMode(lanCfg), camera: !!lanCfg && bambuLanMode(lanCfg) !== "cloud" };
    const row = await tenantDb(req)
      .selectFrom("digifab_bambu_status")
      .select(["report", "updated_at"])
      .where("connection_id", "=", req.params.connectionId!)
      .where("serial", "=", req.params.deviceId!)
      .executeTakeFirst();
    if (!row?.report) {
      // No Bambu cloud MQTT report. For an edge-bridge machine (Duet, PrusaLink,
      // Moonraker) live temps + state come from the bridge's device list, not a
      // cloud pump — so pull them (cached, shared with the floor view) and report
      // them here instead of leaving the modal blank.
      try {
        const driver = await buildDriverById(tenantDb(req), tenantContext(req).org.id, req.params.connectionId!);
        if (driver) {
          const { devices, at } = await fetchDevicesCached(tenantDb(req), driver, req.params.connectionId!);
          const dev = devices.find((x) => x.id === req.params.deviceId);
          const t = dev?.temps;
          const st = dev?.state;
          if (t && (t.nozzle || t.bed || t.chamber)) {
            return void res.json({
              live: true,
              updated_at: new Date(at).toISOString(),
              telemetry: {
                nozzle: t.nozzle?.actual ?? null, nozzle_target: t.nozzle?.target ?? null,
                bed: t.bed?.actual ?? null, bed_target: t.bed?.target ?? null,
                chamber: t.chamber?.actual ?? null,
                light: null, speed_level: null, nozzle_diameter: null, nozzle_type: null,
                wifi: null, gcode_state: st ?? null, firmware_update: false, hms_count: 0,
                ams: [],
              },
              job: dev?.job ?? null,
              lan,
            });
          }
        }
      } catch {
        /* bridge unreachable → fall through to no-telemetry */
      }
      return void res.json({ live: false, telemetry: null, lan });
    }
    const p = row.report as Record<string, unknown>;
    const slots: { id: string; type: string | null; color: string | null; remain: number | null; brand: string | null }[] = [];
    const amsUnits = Array.isArray((p.ams as { ams?: unknown })?.ams) ? ((p.ams as { ams: Record<string, unknown>[] }).ams) : [];
    for (const unit of amsUnits) {
      const trays = Array.isArray(unit.tray) ? (unit.tray as Record<string, unknown>[]) : [];
      for (const t of trays) {
        if (!t.tray_type) continue; // empty slot
        slots.push({ id: `${unit.id}-${t.id}`, type: (t.tray_type as string) || null, color: bHex(t.tray_color), remain: bNum(t.remain), brand: (t.tray_sub_brands as string) || null });
      }
    }
    const vt = p.vt_tray as Record<string, unknown> | undefined;
    if (vt?.tray_type) slots.push({ id: "ext", type: (vt.tray_type as string) || null, color: bHex(vt.tray_color), remain: bNum(vt.remain), brand: (vt.tray_sub_brands as string) || null });
    const lights = Array.isArray(p.lights_report) ? (p.lights_report as { node?: string; mode?: string }[]) : [];
    const fwList = Array.isArray((p.upgrade_state as { new_ver_list?: unknown })?.new_ver_list) ? ((p.upgrade_state as { new_ver_list: { cur_ver?: string; new_ver?: string }[] }).new_ver_list) : [];
    res.json({
      live: true,
      updated_at: new Date(row.updated_at).toISOString(),
      telemetry: {
        nozzle: bNum(p.nozzle_temper), nozzle_target: bNum(p.nozzle_target_temper),
        bed: bNum(p.bed_temper), bed_target: bNum(p.bed_target_temper),
        chamber: bNum(p.chamber_temper),
        light: lights.find((l) => l.node === "chamber_light")?.mode ?? null,
        speed_level: bNum(p.spd_lvl),
        nozzle_diameter: (p.nozzle_diameter as string) ?? null,
        nozzle_type: (p.nozzle_type as string) ?? null,
        wifi: (p.wifi_signal as string) ?? null,
        gcode_state: (p.gcode_state as string) ?? null,
        firmware_update: fwList.some((v) => v.new_ver && v.cur_ver && v.new_ver !== v.cur_ver),
        hms_count: Array.isArray(p.hms) ? (p.hms as unknown[]).length : 0,
        ams: slots,
      },
      lan,
    });
  }),
);
