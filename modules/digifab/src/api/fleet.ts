import { poolGroupCondition } from "../pool-groups.js";
import { machineHoldRefusal } from "../core/holds.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { isStopControl, RUN_MACHINES } from "../motion-gate.js";
import { plainDriverError } from "../job-truth.js";
import { runBench } from "../bench.js";
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

import { readBridgeConfig } from "../bridge-identity.js";
import { recordVerdictOnMake } from "../makes-core.js";
import { Router, raw } from "express";
import { isEdgeManagerUrl } from "@cobblr/platform-contract/edge-bridge-client";
import { z } from "zod";
import { cameraSourceFor, frameFromAddress } from "../camera-frame.js";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext, sessionUser } from "../db.js";
import { asyncHandler, requireRole } from "./util.js";
import { putSnapshot, getSnapshot, freshSnapshotKeys } from "../snapshot-store.js";
import { managerName, buildDriverById, runControlWithCloudFallback, recordJobOutcome } from "../jobs-core.js";
import { familyOutcome } from "../core/families.js";
import { ReviewRequired } from "../drivers/job-review.js";
import { familyControlFor, familyDeviceLan, familyDeviceTelemetry, familyFleetFields, familyFleetLive, familyLanCameras, familyManagedDevices, familyPreferredDriver, requireFamilyPrinting, requireFamilyProcess } from "../core/families.js";
import { LaserPlanRefusal, recordFinishedLayout } from "../sheet-layout.js";
import { recordRunVerdict } from "../runs-core.js";
import { availableDriverKeys } from "../drivers/registry.js";
import { lentDeviceRefs } from "../lent-machines.js";
import { classify, fleetState } from "../state.js";
import { offeredStationKind } from "../station-offer.js";
import type { MachineDriver, RemoteDevice } from "../drivers/types.js";
import { sql, type Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { readCachedList, readCachedInfo, refreshList, ensureInfo, ensureWarming } from "../printer-file-cache.js";
import { optionalField, optionalText } from "@cobblr/platform-contract/optional-fields";
import { fetchDevicesCached, withTimeout } from "./fleet-device-cache.js";

export const fleetRouter = Router({ mergeParams: true });

const TERMINAL = ["completed", "failed", "cancelled"];

// F-11 — the fan-out's third guard: at most this many managers asked at once,
// however big the fleet (the cache and the timeout live in fleet-device-cache.ts).
const MAX_CONCURRENT_LISTS = 6;

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
  const lan = await familyPreferredDriver(orgId, connId, deviceId);
  return lan ?? (await buildDriverById(db, orgId, connId));
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
      .select(["id", "connection_id", "target_device", "target_pool", "file_ref", "metadata", "status", "progress", "priority", "attempts", "max_attempts", "eta_sec", "created_at"])
      .where("status", "not in", TERMINAL)
      .execute();
    // A snapshot begun before completion can mistake the finished job for an external run.
    const finished = conns.length ? await db.selectFrom("digifab_jobs")
      .select(["connection_id", sql<Date>`max(updated_at)`.as("finished_at")])
      .where("connection_id", "in", conns.map(c => c.id))
      .where("status", "in", TERMINAL).groupBy("connection_id").execute() : [];
    const finishedByConnection = new Map(finished.map(j => [j.connection_id, new Date(j.finished_at).getTime()]));

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
      .where(poolGroupCondition("p.config"))
      .select(["m.connection_id", "m.remote_device_id", "p.id as pool_id", "p.name as pool_name"])
      .execute();

    // F-1: devices that finished/failed a print and need a human to clear the
    // bed before they can take new work (the assign worker skips these).
    const attention = await db
      .selectFrom("digifab_device_attention")
      .select(["connection_id", "remote_device_id", "reason", "created_at", "job_id"])
      .execute();
    // How many one plate makes, for the verdict's counts ("9 good, 1 scrap").
    // Only a plate that produces a build has a number worth splitting.
    const attJobIds = attention.map((a) => a.job_id).filter((id): id is string => !!id);
    const plateQty = new Map<string, number>();
    if (attJobIds.length > 0) {
      const attJobs = await db
        .selectFrom("digifab_jobs")
        .select(["id", "linked_build_id", "build_qty"])
        .where("id", "in", attJobIds)
        .execute();
      for (const j of attJobs) {
        if (j.linked_build_id) plateQty.set(j.id, j.build_qty != null ? Number(j.build_qty) : 1);
      }
    }

    // Cockpit: per-device manual overrides (a camera URL the manager doesn't
    // report). Merged over any driver-reported camera below.
    const settings = await db
      .selectFrom("digifab_device_settings")
      .select(["connection_id", "remote_device_id", "camera_url", "snapshot_relay", "grid_x", "grid_y", "sort_order", "row_break", "hour_rate", "hour_rate_currency"])
      .execute();
    const freshSnaps = await freshSnapshotKeys(db); // which devices have a recent relayed frame
    // AI failure-watch state per device (one query for the whole floor).
    const failureRows = await db
      .selectFrom("digifab_failure_watch")
      .select(["connection_id", "device_id", "score", "paused_at", "watch_at"])
      .execute();
    // Printers an external detector owns — Cobblr stands down its camera pull for
    // them (the detector handles detection); one query for the whole floor.
    const owned = await familyManagedDevices(db);
    // Printers lent out (record-loans.md): away, and the farm skips them.
    const lent = await lentDeviceRefs(db, orgId).catch(() => new Map<string, string>());

    const connections = await mapLimit(conns, MAX_CONCURRENT_LISTS, async (c) => {
        try {
          const bridge = c.type === "edge_adapter" ? (await readBridgeConfig(orgId, c.id)).bridge : undefined;
          const driver = await buildDriverById(db, orgId, c.id);
          if (!driver) {
            return { connection_id: c.id, label: c.label, type: c.type, error: "driver unavailable", fetched_at: null, devices: [] };
          }
          const { devices, at, stale, unreachable } = await fetchDevicesCached(db, driver, c.id, finishedByConnection.get(c.id));
          // The manager stopped answering: every device below is its last word, said at `at`.
          const outOfContact = unreachable ? { last_contact: new Date(at).toISOString(), error: unreachable } : null;
          // For a cloud Bambu, prefer the live MQTT telemetry the pump caches
          // (real-time temps/progress/state) over the slower HTTP list.
          const bambuLive = await familyFleetLive(db, c);
          // Per-printer LAN config → the cams wall knows this device has a real
          // camera reachable over the bridge (the cockpit's /camera route), even
          // with no manual camera_url and no snapshot relay.
          const lanCameras = await familyLanCameras(orgId, c);
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
            const state = fleetState(live?.state ?? d.state ?? "unknown", job?.status);
            // Owned by an external detector → the detector handles the camera +
            // detection; Cobblr reports no camera source so nothing here pulls it.
            const managedByDetector = owned.has(`${c.id}:${d.id}`);
            return {
              id: d.id,
              name: d.name,
              state,
              klass: classify(state),
              enabled: d.enabled,
              // Out of contact (#7902): its state, temperatures and progress are
              // the last reading, not now. The card says so, with the time.
              out_of_contact: outOfContact,
              ...familyFleetFields(d),
              laser_backend: d.raw?.laserBackend ?? null,
              laser_setup: d.raw?.laserSetup === true,
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
              station_kind: d.raw?.bench ? "bench" : offeredStationKind(d.station_kind, driver),
              monitor_only: d.raw?.monitorOnly === true,
              print_process: d.raw?.resin === true ? "resin" : null,
              // Current job sub-stage (preheating/leveling/…) when reported —
              // answers "why isn't it printing yet". Display-only.
              stage: live?.stage ?? d.stage ?? null,
              // Real-time print progress straight from the printer (Bambu cloud
              // MQTT, or the device read of any driver that reports its job),
              // also for a print Cobblr didn't start so there's no active_job.
              live: live
                ? { progress: live.progress, remaining_min: live.remaining_min, layer_num: live.layer_num, total_layers: live.total_layers }
                : d.job ? { progress: d.job.fractionPrinted != null ? d.job.fractionPrinted * 100 : null, remaining_min: d.job.timeLeftSec != null ? Math.ceil(d.job.timeLeftSec / 60) : null, layer_num: d.job.currentLayer ?? null, total_layers: null } : null,
              // An external detector owns this printer's detection + camera.
              managed_by_detector: managedByDetector,
              // Camera fields are suppressed for a detector-owned printer so
              // neither the camera wall nor the relay pulls the same stream the
              // detector already owns (the single-owner rule).
              camera_url: managedByDetector ? null : (setting?.camera_url ?? d.camera_url ?? null),
              // The server answers this printer's frames on the cockpit /camera
              // route: the bridge grabs its own camera, or the server fetches the
              // camera address saved or reported for it. Every screen polls that
              // route then, never the address itself: an http camera on the shop
              // network is blocked on an https page and unreachable off it (#7056).
              lan_camera: !managedByDetector && (d.camera_available === true || lanCameras.has(d.id) || !!(setting?.camera_url ?? d.camera_url)),
              // Which of those the route reads, in cameraSourceFor's order, so a
              // screen whose frames fail names the right thing to check.
              camera_source: managedByDetector ? null
                : lanCameras.has(d.id) ? "bridge"
                : setting?.camera_url ? "address"
                : d.camera_available === true ? "manager"
                : d.camera_url ? "address"
                : null,
              // Snapshot relay (opt-in, off by default). When on AND a fresh
              // agent-pushed frame exists, the web auth-fetches it from the
              // /snapshot route (remote-viewable) instead of the LAN camera_url.
              snapshot_relay: !managedByDetector && (setting?.snapshot_relay ?? false),
              // What an hour of this printer costs, when set (digifab:set-machine-hour-rate).
              hour_rate: setting?.hour_rate != null ? { amount: Number(setting.hour_rate), currency: setting.hour_rate_currency ?? "USD" } : null,
              snapshot_fresh: !managedByDetector && !!setting?.snapshot_relay && freshSnaps.has(`${c.id}:${d.id}`),
              // ⑦ Spatial floor position (null = unplaced, flows after placed).
              position: setting?.grid_x != null && setting?.grid_y != null ? { x: setting.grid_x, y: setting.grid_y } : null,
              // Free-form layout: order in the flow + explicit row start.
              sort_order: setting?.sort_order ?? null,
              row_break: setting?.row_break ?? false,
              // Lent out: "Lent to Sam Lee." The farm sends it nothing.
              lent: lent.get(`${c.id}:${d.id}`) ?? null,
              // F-1: needs a bed-clear ack before it's assignable again.
              needs_attention: att
                ? { reason: att.reason, since: att.created_at, plate_qty: att.job_id ? (plateQty.get(att.job_id) ?? null) : null }
                : null,
              // AI failure watch: live score while printing + whether it auto-paused.
              failure: fw && (fw.watch_at || fw.paused_at) ? { score: Number(fw.score), watching: !!fw.watch_at, paused: !!fw.paused_at } : null,
              active_job: job
                ? { id: job.id, file_ref: job.file_ref, metadata: job.metadata, status: job.status, progress: job.progress, priority: job.priority, attempts: job.attempts, max_attempts: job.max_attempts, eta_sec: job.eta_sec }
                : null,
              // What this machine will do next (queued to it or its pool).
              next_job: next ? { id: next.id, file_ref: next.file_ref, metadata: next.metadata, pooled: !!next.target_pool } : null,
            };
          });
          return { connection_id: c.id, label: c.label, type: c.type, bridge, error: null, fetched_at: new Date(at).toISOString(), stale, unreachable, devices: mapped };
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
//   scrapped → emit digifab.print.reversed → the machine's print count comes
//              back off; its hours and the filament the print used stay spent.
//              The task is NOT closed.
// Only a *completed*-print attention has effects to confirm/reverse; a
// failed-print attention just gets cleared (a failed print fired nothing).
// `good` / `scrap` counts (in builds) split a plate that came out partly good:
// "9 good, 1 scrap". Without them the verdict covers the whole plate.
const ReadyBody = z.object({
  outcome: z.enum(["good", "scrapped"]).default("good"),
  good: optionalField(z.number().int().min(0)),
  scrap: optionalField(z.number().int().min(0)),
});
// AI-REACH: action digifab:machine-outcome for CNC stock and bit use; print outcomes use digifab:record-outcome.
fleetRouter.post(
  "/:connectionId/:deviceId/ready",
  asyncHandler(async (req, res) => {
    // ADMIN-ONLY: recording a machine's outcome consumes stock and bit hours; it stays with the admin tier, at every door (#5170)
    if (!(await requireCapability(req, res, "digifab:machine-outcome"))) return;
    const orgId = tenantContext(req).org.id;
    const db = tenantDb(req);
    const connectionId = req.params.connectionId!;
    const deviceId = req.params.deviceId!;
    const att = await db.selectFrom("digifab_device_attention").select(["job_id", "reason"]).where("connection_id", "=", connectionId).where("remote_device_id", "=", deviceId).executeTakeFirst();
    // A family's own job (a CNC setup) records its own outcome; anything else is a good/scrap verdict.
    const own = await familyOutcome({ db, orgId, connectionId, deviceId, attentionJobId: att?.job_id ?? null, body: req.body, userId: sessionUser(req)?.id ?? null });
    if (own) return void res.status(own.status).json(own.body);
    const body = ReadyBody.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: { code: "bad_body", message: "outcome is good or scrapped; good and scrap are whole numbers" } });
    const counts = body.data.good != null || body.data.scrap != null ? { good: body.data.good ?? 0, scrap: body.data.scrap ?? 0 } : undefined;
    // Counts decide the outcome when given: any good part makes the plate good.
    const outcome: "good" | "scrapped" = counts ? (counts.good > 0 ? "good" : "scrapped") : body.data.outcome;

    if (att?.job_id && await db.selectFrom("digifab_cutter_plans").select("id").where("job_id", "=", att.job_id).executeTakeFirst()) return void res.status(409).json({ error: { code: "cutter_outcome_required", message: "Record the measured roll use and cutter outcome at its station." } });

    if (att?.job_id) {
      try { await recordFinishedLayout(db, orgId, att.job_id, sessionUser(req)?.id ?? null); }
      catch (e) { if (!(e instanceof LaserPlanRefusal)) throw e; return void res.status(409).json({ error: { code: "sheet_area_not_recorded", message: e.message } }); }
    }

    if (att?.job_id) {
      const resin = await db.selectFrom("digifab_jobs").select("resin_print").where("id", "=", att.job_id).executeTakeFirst();
      if (resin?.resin_print) {
        try { await requireFamilyProcess("resin").settle(db, orgId, att.job_id, outcome === "good" ? "good" : "scrap", sessionUser(req)?.id ?? null, { connectionId, deviceId }); }
        catch (e) { return void res.status(409).json({ error: { code: "resin_use_not_recorded", message: e instanceof Error ? e.message : "Check this print's stock use." } }); }
        if (att.reason !== "print-completed") await recordJobOutcome(db, orgId, att.job_id, outcome === "good" ? "good" : "scrap", "bed-clear", counts);
      }
    }

    // Resolve the print's downstream context from its job, for the wires.
    if (att?.reason === "print-completed" && att.job_id) {
      try { await requireFamilyPrinting().drawCompleted(db, orgId, { id: att.job_id }); }
      catch { return void res.status(409).json({ error: { code: "filament_accounting_pending", message: "Filament accounting is still pending. Try clearing the bed again shortly." } }); }
      // Production runs: the human verdict is what counts a plate — good
      // increments the run (and may close it), scrapped marks the plate
      // non-covering so the assign worker mints a replacement. Idempotent.
      await recordRunVerdict(db, orgId, att.job_id, outcome);
      await recordVerdictOnMake(db, orgId, att.job_id, outcome);
      // The plate's outcome: parts count as made here, on good, and never at
      // send (#4050). A whole-plate scrap reverses the build inside it.
      await recordJobOutcome(db, orgId, att.job_id, outcome === "good" ? "good" : "scrap", "bed-clear", counts);
      const job = await db
        .selectFrom("digifab_jobs")
        .select(["id", "linked_task_id", "linked_machine_id"])
        .where("id", "=", att.job_id)
        .executeTakeFirst();
      if (job) {
        if (outcome === "good") {
          // Fire the held-back consequential effect: close the linked task.
          // Awaited: the verdict answers and the page refetches the task and
          // the machine right away, so what this wire moves must be moved
          // before the answer leaves (#2826 audit; emit never rejects).
          await platform().events.emit("digifab.print.confirmed", {
            orgId,
            jobId: job.id,
            linkedTaskId: job.linked_task_id,
            linkedMachineId: job.linked_machine_id,
          });
        } else {
          // A scrapped print still melted its filament: no grams go back on any
          // spool (#7890). Only the print count comes back off the machine.
          // Awaited: the count is what the page reads next.
          await platform().events.emit("digifab.print.reversed", {
            orgId,
            jobId: job.id,
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
        const { sendAndWatch } = await import("./jobs.js");
        await sendAndWatch(db, orgId, h.id);
      } catch {
        /* left queued — visible in the queue with its retry note */
      }
    }
    // DETACHED: a nudge to the assign worker; its own sweep assigns the same work
    void import("../assign-worker.js").then((m) => m.kickAssign(orgId)).catch(() => {});
    res.json({ ok: true, outcome, resumed: held.length });
  }),
);

// Cockpit: set (or clear) a device's camera stream URL — a manual override for a
// manager that doesn't report one. Upserts the per-device settings row.
// ⑦ Pin (or unpin) a device to a floor-grid cell — the fleet arrange mode.
const PositionBody = z.object({ x: z.number().int().min(0).max(63).nullable(), y: z.number().int().min(0).max(255).nullable() });
// AI-REACH: exempt — the legacy cell grid for older clients; the assistant
// arranges the floor through digifab:arrange-floor, which writes the order
// the page shows now
// UI-REACH: legacy cell-grid coordinates for older fleet clients; Arrange saves the complete free-form floor through PUT /fleet/layout.
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
export const LayoutBody = z.object({
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
export type FloorItem = z.infer<typeof LayoutBody>["items"][number];

/** The floor's order as it stands: placed devices first, by their order. */
export async function readLayout(db: ReturnType<typeof tenantDb>): Promise<FloorItem[]> {
  const rows = await db
    .selectFrom("digifab_device_settings")
    .select(["connection_id", "remote_device_id", "row_break", "sort_order"])
    .where("sort_order", "is not", null)
    .orderBy("sort_order")
    .execute();
  return rows.map((r) => ({ connection_id: r.connection_id, device_id: r.remote_device_id, row_break: !!r.row_break }));
}

/** Lay the whole floor out in one go: the route's PUT and digifab:arrange-floor. */
export async function writeLayout(db: ReturnType<typeof tenantDb>, items: FloorItem[]): Promise<number> {
  // Clear stale order everywhere first, so a device dropped from the list
  // reverts to unplaced instead of keeping a phantom slot.
  await db.updateTable("digifab_device_settings").set({ sort_order: null, row_break: false, updated_at: new Date() }).execute();
  let i = 0;
  for (const it of items) {
    const fields = { sort_order: i * 10, row_break: it.row_break ?? false, updated_at: new Date() };
    await db
      .insertInto("digifab_device_settings")
      .values({ connection_id: it.connection_id, remote_device_id: it.device_id, ...fields })
      .onConflict((oc) => oc.columns(["connection_id", "remote_device_id"]).doUpdateSet(fields))
      .execute();
    i++;
  }
  return i;
}

// AI-ACTION: digifab:arrange-floor
fleetRouter.put(
  "/layout",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "digifab:arrange-floor"))) return;
    const parsed = LayoutBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "items: [{connection_id, device_id, row_break?}] required" } });
    res.json({ ok: true, placed: await writeLayout(tenantDb(req), parsed.data.items) });
  }),
);

const CameraBody = z.object({ camera_url: z.string().url().max(1000).nullable() });
// AI-REACH: exempt — an address the server then fetches camera frames from;
// a chat must never point the server at hosts on someone's network
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
// AI-REACH: exempt — opts a camera in to sending its frames to the cloud;
// pictures leaving the workshop are the owner's call, never a chat's
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
  const edge = conns.filter((c) => c.enabled && c.type === "edge_adapter" && isEdgeManagerUrl(c.base_url));
  return edge.length === 1 ? edge[0]!.id : (edge[0]?.id ?? null);
}

// The edge agent PUSHES the latest webcam frame here (raw JPEG body) — only when
// the workspace owner enabled the relay for this device. Stored in the tenant DB
// + served back by GET below. The agent dials out, so this is a normal
// authenticated POST. Use connectionId "self" to auto-resolve (no id to paste).
// AI-REACH: exempt — the bridge pushing a camera frame with its own token: the
// device wire, never something a person or the assistant starts
// UI-REACH: the machine's agent posts its camera frames here; the fleet screen shows them
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
    try {
      const driver = await buildDriverById(tenantDb(req), orgId, req.params.connectionId!);
      const controls = driver?.listControls ? await driver.listControls(req.params.deviceId!) : [];
      res.json({ controls });
    } catch (error) {
      res.status(502).json({ error: { code: "controls_unavailable", message: plainDriverError(error, await managerName(orgId, req.params.connectionId!), "reading the printer's controls") } });
    }
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
    let error: string | null = null;
    if (refresh || cached.listFetchedAt == null) {
      try {
        const driver = await fileDriverFor(db, orgId, connId, deviceId);
        if (driver?.listFiles) {
          files = await withTimeout(refreshList(db, driver, connId, deviceId), 15_000, "listFiles timed out");
          live = true;
        }
      } catch (e) {
        error = plainDriverError(e, await managerName(orgId, connId), "reading the printer's files");
      }
    }
    await ensureWarming(db, orgId, connId, deviceId).catch(() => {});
    res.json({ files, cached: !live, error, at: (cached.listFetchedAt ?? new Date()).toISOString() });
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
// AI-REACH: exempt — a raw printer control (heat, move, light, resume) runs the
// machine; the assistant stops and pauses through digifab:stop, and the rest
// through each machine's own control action, which keep Start at the station
fleetRouter.post(
  "/:connectionId/:deviceId/control",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ControlBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "control id required" } });
    // A stop or a pause is every member's; anything else runs the machine, the operator's (#6785).
    if (!isStopControl(parsed.data.id) && !(await requireCapability(req, res, RUN_MACHINES))) return;
    const orgId = tenantContext(req).org.id;
    // Prefer the LAN driver when this printer has LAN configured (more reliable
    // than cloud, and the only path that works if cloud rejects the command) — but
    // fall back to cloud if the LAN/edge-bridge path fails, so a flaky bridge can't
    // block a command the cloud broker can also send (light / pause / temps).
    const lan = await familyPreferredDriver(orgId, req.params.connectionId!, req.params.deviceId!);
    const driver = lan ?? (await buildDriverById(tenantDb(req), orgId, req.params.connectionId!));
    if (driver?.benchInstrument===true) {
      if(parsed.data.id!=="output-off")return void res.status(409).json({error:{code:"bench_control_required",message:"Use the bench panel to confirm and log supply changes."}});
      const link=await tenantDb(req).selectFrom("digifab_device_links").select("machine_id").where("connection_id","=",req.params.connectionId!).where("remote_device_id","=",req.params.deviceId!).executeTakeFirst();
      if(!link)return void res.status(409).json({error:{code:"bench_link_required",message:"Link the instrument to a machine first."}});
      const result=await runBench(tenantDb(req),orgId,{machine_id:link.machine_id,operation:"output_off"},sessionUser(req)?.id || null);
      return void res.json({ok:"off" in result && result.off===true});
    }
    const own = await familyControlFor(driver, parsed.data.id);
    if (driver && own) {
      const result = await own.run(tenantDb(req), orgId, driver, req.params.deviceId!, parsed.data.id, parsed.data.params ?? {}, req.params.connectionId!);
      if (!result.ok) return void res.status(502).json({ error: { code: "control_failed", message: result.detail } });
      return void res.json(result);
    }
    if (!driver?.runControl) return void res.status(501).json({ error: { code: "unsupported", message: "this printer can't be controlled here" } });
    const r = await runControlWithCloudFallback({
      primary: driver,
      lanPrimary: !!lan,
      buildCloud: () => buildDriverById(tenantDb(req), orgId, req.params.connectionId!),
      deviceId: req.params.deviceId!,
      id: parsed.data.id,
      params: parsed.data.params ?? {},
      onFallback: (detail) =>
        console.warn(`[digifab] control "${parsed.data.id}" — LAN/bridge failed (${detail ?? "?"}); sent via cloud instead`),
    });
    if (!r.ok) return void res.status(502).json({ error: { code: "control_failed", message: r.detail ?? "command not accepted by the printer" } });
    res.json({ ok: true, ref: r.ref });
  }),
);

// Start a file ALREADY on the printer's storage (from the file list) — no upload.
const PrintBody = z.object({ name: z.string().min(1).max(300) });
// AI-REACH: exempt — starts a file already on the printer, a physical Start;
// that stays a person's press at the machine
fleetRouter.post(
  "/:connectionId/:deviceId/print",
  asyncHandler(async (req, res) => {
    // The admin tier, or an operator: starting a file already on the machine (#6672).
    if (!(await requireCapability(req, res, "digifab:operate"))) return;
    const parsed = PrintBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "file name required" } });
    const held = await machineHoldRefusal(tenantDb(req), req.params.connectionId!, req.params.deviceId!);
    if (held) return void res.status(409).json({ error: { code: "machine_held", message: held } });
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
// AI-REACH: exempt — stores a printer's LAN access code, a credential; the
// assistant never handles a secret
fleetRouter.put(
  "/:connectionId/:deviceId/lan",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const own = familyDeviceLan();
    if (!own) return void res.status(400).json({ error: { code: "not_bambu", message: "LAN access is for Bambu connections" } });
    const r = await own.write(tenantContext(req).org.id, req.params.connectionId!, req.params.deviceId!, req.body);
    res.status(r.status).json(r.body);
  }),
);
// AI-REACH: exempt — deletes a printer's stored LAN access code for good; no
// undo can bring a secret back
fleetRouter.delete(
  "/:connectionId/:deviceId/lan",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = tenantContext(req).org.id;
    const own = familyDeviceLan();
    if (!own) return void res.status(404).json({ error: { code: "not_found", message: "no such connection" } });
    const r = await own.remove(orgId, req.params.connectionId!, req.params.deviceId!);
    res.status(r.status).json(r.body);
  }),
);

// GET …/camera — one JPEG frame from the printer's LAN camera: over the bridge
// (Bambu A1/P1 chamber camera), or, for any other device, fetched by the server
// from the camera address saved for it (a snapshot URL or an MJPEG stream), so a
// page served over https can show a camera that speaks only http on the LAN.
// A refreshing still; the page polls it.
fleetRouter.get(
  "/:connectionId/:deviceId/camera",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const orgId = tenantContext(req).org.id;
    const lan = await familyPreferredDriver(orgId, req.params.connectionId!, req.params.deviceId!);
    const setting = await tenantDb(req).selectFrom("digifab_device_settings").select("camera_url")
      .where("connection_id", "=", req.params.connectionId!).where("remote_device_id", "=", req.params.deviceId!).executeTakeFirst();
    const source = await cameraSourceFor(
      lan,
      setting?.camera_url,
      () => buildDriverById(tenantDb(req), orgId, req.params.connectionId!),
      async (driver) => (await fetchDevicesCached(tenantDb(req), driver, req.params.connectionId!)).devices.find((x) => x.id === req.params.deviceId)?.camera_url,
    );
    if (!source) return void res.status(501).json({ error: { code: "no_camera", message: "no camera address saved for this machine" } });
    if ("address" in source) {
      const frame = await frameFromAddress(source.address);
      if (!frame) return void res.status(502).json({ error: { code: "camera_failed", message: "the camera did not answer with a picture. Check its address is a snapshot or MJPEG stream URL." } });
      // DETACHED: caching the frame for the next open; the frame is served without it
      if (frame.type === "image/jpeg") void putSnapshot(tenantDb(req), req.params.connectionId!, req.params.deviceId!, frame.bytes).catch(() => {});
      return void res.set("Content-Type", frame.type).set("Cache-Control", "no-store").send(frame.bytes);
    }
    const driver = source.driver;
    const jpeg = await driver.getCameraFrame!();
    if (!jpeg || jpeg.length === 0) return void res.status(502).json({ error: { code: "camera_failed", message: "couldn't grab a camera frame" } });
    // A manager's snapshot can be a PNG (PrusaLink's is).
    const png = jpeg[0] === 0x89 && jpeg[1] === 0x50;
    // Cache the frame so the next modal-open can show it INSTANTLY (via /snapshot)
    // instead of 3s of "connecting" while the live grab runs. Best-effort.
    // DETACHED: caching the frame for the next open; the frame is served without it
    if (!png) void putSnapshot(tenantDb(req), req.params.connectionId!, req.params.deviceId!, jpeg).catch(() => {});
    res.set("Content-Type", png ? "image/png" : "image/jpeg").set("Cache-Control", "no-store").send(jpeg);
  }),
);

// ── Rich live detail: a family's own telemetry (a Bambu account's cloud
// report, core/families.ts deviceTelemetry), else the bridge's device list.
fleetRouter.get(
  "/:connectionId/:deviceId/detail",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    // LAN config for this printer (hybrid) — surfaced so the modal can show the
    // "LAN access" state. Host only; never the access code.
    // Camera available when LAN is configured (Bambu chamber cam via the bridge).
    const lan = (await familyDeviceLan()?.read(tenantContext(req).org.id, req.params.connectionId!, req.params.deviceId!)) ?? { applicable: false, configured: false, host: undefined, mode: "cloud", camera: false };
    const own = await familyDeviceTelemetry(tenantDb(req), req.params.connectionId!, req.params.deviceId!);
    if (!own) {
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
    res.json({
      live: true,
      ...own,
      lan,
    });
  }),
);
