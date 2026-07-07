// AI print-failure detection — the "is this print turning into spaghetti?" watch.
//
// SHAPE (own model, no per-inference token cost by default):
//   • Detection runs behind a REGISTRY of detector packages (./detectors/*),
//     picked by the workspace's `backend` setting:
//       - EDGE     — the LOCAL model on the machine's bridge (driver.detectFailure);
//                    the frame never leaves the LAN and there's no token cost.
//       - LLM      — the workspace's configured vision AI (core-ai classify-image);
//                    the zero-model fallback (bills tokens on a paid provider).
//       - DETECTOR — a self-hosted external service (Obico ML API, PrintGuard, a
//                    generic LAN box) the operator points at a base URL; declared
//                    by a per-folder manifest, nothing hardcoded here.
//     `auto` = edge if the bridge offers it, else llm.
//   • A self-perpetuating core-queue loop (mirrors the file-warmer) samples each
//     PRINTING device every `sample_interval_sec`, folds the probability into an
//     exponentially-weighted score, and when it crosses `threshold` (and
//     auto_pause is on) PAUSES the job, flags the printer for attention, and
//     emits `digifab.print.failure_suspected` (→ the notification channels).
//
// Coordinate-not-control holds: we only ASK the manager to pause and read a
// frame; the model + the pause both live where the hardware is.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import { buildDriverById, bambuLanDriverFor } from "./jobs-core.js";
import { getSnapshot } from "./snapshot-store.js";
import type { MachineDriver } from "./drivers/types.js";
import { resolveDetector, runDetector } from "./detectors/registry.js";
import { ownedDeviceRefs } from "./detectors/owned.js";
import type { DetectorContext } from "./detectors/types.js";
// The vision constants + classify-image parse moved to the `llm` detector
// package; re-export for back-compat (older imports referenced them here).
export { FAILURE_LABELS, FAILURE_PROMPT, parseFailureProbability } from "./detectors/vision.js";

export const FAILURE_WATCH_QUEUE = "digifab.failure-watch";
const WATCH_ALIVE_MS = 90_000; // a heartbeat fresher than this → a loop is alive

// EWM smoothing: a single bad frame shouldn't trip the alarm, but a genuine
// failure should cross within a few samples. 0.4 → ~3 consistent bad frames to
// climb from 0 past a 0.6 threshold.
const EWM_ALPHA = 0.4;

// ── pure helpers (unit-tested) ───────────────────────────────────────────────
export function ewmUpdate(prev: number, p: number, alpha = EWM_ALPHA): number {
  const x = Math.max(0, Math.min(1, p));
  return Math.round((alpha * x + (1 - alpha) * prev) * 1000) / 1000;
}
export function crossed(score: number, threshold: number): boolean {
  return score >= threshold;
}

// ── config ───────────────────────────────────────────────────────────────────
export type FailureBackend = "auto" | "edge" | "llm" | "detector";
export interface FailureConfig {
  enabled: boolean;
  threshold: number;
  sample_interval_sec: number;
  auto_pause: boolean;
  backend: FailureBackend;
  /** When backend='detector', the digifab_detectors row to use. */
  detector_id: string | null;
}
const DEFAULT_CONFIG: FailureConfig = { enabled: false, threshold: 0.6, sample_interval_sec: 30, auto_pause: true, backend: "auto", detector_id: null };
const BACKENDS: FailureBackend[] = ["auto", "edge", "llm", "detector"];

export async function readFailureConfig(db: Kysely<DigifabDB>): Promise<FailureConfig> {
  const row = await db.selectFrom("digifab_failure_config").selectAll().where("id", "=", true).executeTakeFirst();
  if (!row) return { ...DEFAULT_CONFIG };
  return {
    enabled: !!row.enabled,
    threshold: Number(row.threshold),
    sample_interval_sec: Number(row.sample_interval_sec),
    auto_pause: !!row.auto_pause,
    backend: (BACKENDS.includes(row.backend as FailureBackend) ? row.backend : "auto") as FailureBackend,
    detector_id: row.detector_id ?? null,
  };
}

// ── frame + detection ────────────────────────────────────────────────────────
/** The LAN/edge driver for on-machine ops (camera + local model), else null. */
async function edgeDriverFor(db: Kysely<DigifabDB>, orgId: string, connId: string, deviceId: string): Promise<MachineDriver | null> {
  const lan = await bambuLanDriverFor(orgId, connId, deviceId);
  return lan ?? (await buildDriverById(db, orgId, connId));
}

/** One live frame for the vision path: the LAN camera (over the bridge), else
 *  the most recent relayed snapshot. */
async function grabFrame(db: Kysely<DigifabDB>, driver: MachineDriver | null, connId: string, deviceId: string): Promise<Buffer | null> {
  if (driver?.getCameraFrame) {
    try {
      const f = await driver.getCameraFrame();
      if (f && f.length > 0) return f;
    } catch {
      /* fall through to the snapshot */
    }
  }
  return getSnapshot(db, connId, deviceId);
}

/** The device's configured camera URL (for a url-mode external frame-scorer that
 *  fetches the frame itself). */
async function cameraUrlFor(db: Kysely<DigifabDB>, connId: string, deviceId: string): Promise<string | null> {
  const row = await db
    .selectFrom("digifab_device_settings")
    .select("camera_url")
    .where("connection_id", "=", connId)
    .where("remote_device_id", "=", deviceId)
    .executeTakeFirst();
  return row?.camera_url ?? null;
}

/** Load a configured external detector (decrypts its token, resolves the mapped
 *  camera id). Null when the row is missing/disabled or the package isn't wired. */
async function loadDetectorCtx(
  db: Kysely<DigifabDB>,
  orgId: string,
  connId: string,
  deviceId: string,
  detectorId: string,
  base: Omit<DetectorContext, "connection" | "cameraId">,
): Promise<{ pkg: ReturnType<typeof resolveDetector>; ctx: DetectorContext } | null> {
  const row = await db
    .selectFrom("digifab_detectors")
    .select(["key", "base_url", "credentials_enc", "config"])
    .where("id", "=", detectorId)
    .where("enabled", "=", true)
    .executeTakeFirst();
  if (!row) return null;
  const pkg = resolveDetector(row.key);
  if (!pkg) return null;
  let apiKey: string | null = null;
  if (row.credentials_enc) {
    try {
      const creds = await platform().integrations.decryptCredentials(orgId, row.credentials_enc);
      apiKey = (creds.apiKey as string | undefined) ?? null;
    } catch {
      /* undecryptable creds → treat as no auth */
    }
  }
  const map = ((row.config as { camera_map?: Record<string, string> })?.camera_map) ?? {};
  const cameraId = map[`${connId}:${deviceId}`] ?? null;
  return { pkg, ctx: { ...base, connection: { baseUrl: row.base_url, apiKey }, cameraId } };
}

export interface DetectResult { probability: number; source: "edge" | "llm" | "detector"; }

/** Sample once, via the backend the workspace configured. The two built-in
 *  backends (edge/llm) and the external services are all detector PACKAGES
 *  resolved from the registry — nothing about a specific service is hardcoded
 *  here. Null when the chosen backend could produce no reading. */
export async function detectOnce(
  db: Kysely<DigifabDB>,
  orgId: string,
  connId: string,
  deviceId: string,
  cfg: FailureConfig,
): Promise<DetectResult | null> {
  const driver = await edgeDriverFor(db, orgId, connId, deviceId);
  const base: Omit<DetectorContext, "connection" | "cameraId"> = {
    orgId,
    connId,
    deviceId,
    driver,
    grabFrame: () => grabFrame(db, driver, connId, deviceId),
    cameraUrl: null, // filled lazily below only when a url-mode detector needs it
  };

  // External detector — the whole reading comes from the configured service.
  if (cfg.backend === "detector") {
    if (!cfg.detector_id) return null;
    base.cameraUrl = await cameraUrlFor(db, connId, deviceId);
    const loaded = await loadDetectorCtx(db, orgId, connId, deviceId, cfg.detector_id, base);
    if (!loaded?.pkg) return null;
    try {
      const r = await runDetector(loaded.pkg, loaded.ctx);
      return r ? { probability: r.probability, source: "detector" } : null;
    } catch {
      return null; // service unreachable / bad response → no reading
    }
  }

  // EDGE first (when the backend allows + the bridge offers a model).
  if (cfg.backend === "auto" || cfg.backend === "edge") {
    const edge = resolveDetector("edge");
    if (edge) {
      try {
        const r = await runDetector(edge, { ...base, connection: null, cameraId: null });
        if (r) return { probability: r.probability, source: "edge" };
      } catch {
        /* bridge unreachable / no model → fall through unless edge-only */
      }
    }
    if (cfg.backend === "edge") return null; // edge-only + no model on the bridge
  }

  // LLM fallback (auto + no edge reading, or backend=llm).
  const llm = resolveDetector("llm");
  if (!llm) return null;
  try {
    const r = await runDetector(llm, { ...base, connection: null, cameraId: null });
    return r ? { probability: r.probability, source: "llm" } : null;
  } catch {
    return null; // no AI provider / not entitled → detection just idles
  }
}

// ── watch state ──────────────────────────────────────────────────────────────
/** The Cobblr job printing on a device right now (the pausable handle), or null. */
async function printingJob(db: Kysely<DigifabDB>, connId: string, deviceId: string) {
  return db
    .selectFrom("digifab_jobs")
    .select(["id", "remote_job_id", "status", "file_ref"])
    .where("connection_id", "=", connId)
    .where("target_device", "=", deviceId)
    .where("status", "=", "printing")
    .orderBy("updated_at", "desc")
    .executeTakeFirst();
}

async function touchWatch(db: Kysely<DigifabDB>, connId: string, deviceId: string): Promise<void> {
  const now = new Date();
  await db
    .insertInto("digifab_failure_watch")
    .values({ connection_id: connId, device_id: deviceId, watch_at: now })
    .onConflict((oc) => oc.columns(["connection_id", "device_id"]).doUpdateSet({ watch_at: now }))
    .execute();
}

/** Start the watch loop for a device that just started printing, unless one is
 *  already alive. Cheap + idempotent — safe to call on every poll. No-op when
 *  detection is disabled for the workspace. */
export async function ensureFailureWatch(db: Kysely<DigifabDB>, orgId: string, connId: string, deviceId: string): Promise<void> {
  const cfg = await readFailureConfig(db);
  if (!cfg.enabled) return;
  // Single-owner: if an external detector owns this printer, IT does detection —
  // Cobblr must not also sample the same camera (the double-pull we're avoiding).
  if ((await ownedDeviceRefs(db)).has(`${connId}:${deviceId}`)) return;
  const w = await db
    .selectFrom("digifab_failure_watch")
    .select("watch_at")
    .where("connection_id", "=", connId)
    .where("device_id", "=", deviceId)
    .executeTakeFirst();
  if (w?.watch_at && Date.now() - new Date(w.watch_at).getTime() < WATCH_ALIVE_MS) return; // a loop is alive
  await touchWatch(db, connId, deviceId);
  await platform().queue.enqueue({ orgId, queue: FAILURE_WATCH_QUEUE, payload: { connId, deviceId }, runAt: new Date(Date.now() + 1000) });
}

let watcherRegistered = false;
export function registerFailureWatcher(): void {
  if (watcherRegistered) return;
  watcherRegistered = true;
  platform().queue.registerWorker(FAILURE_WATCH_QUEUE, async (job) => {
    const { connId, deviceId } = (job.payload ?? {}) as { connId?: string; deviceId?: string };
    if (!connId || !deviceId) return;
    const db = (await platform().tenants.getDb(job.orgId)) as Kysely<DigifabDB>;
    try {
      const cfg = await readFailureConfig(db);
      if (!cfg.enabled) return; // disabled → let the loop die

      const active = await printingJob(db, connId, deviceId);
      const prev = await db
        .selectFrom("digifab_failure_watch")
        .selectAll()
        .where("connection_id", "=", connId)
        .where("device_id", "=", deviceId)
        .executeTakeFirst();

      // Not printing anymore → stop sampling (keep the row so the fleet can show
      // the last verdict until the next print). Don't re-enqueue.
      if (!active) {
        if (prev) await db.updateTable("digifab_failure_watch").set({ watch_at: null, updated_at: new Date() }).where("connection_id", "=", connId).where("device_id", "=", deviceId).execute();
        return;
      }

      // A new print → reset the score + the paused flag.
      const sameJob = prev?.job_key === active.id;
      let score = sameJob ? Number(prev!.score) : 0;
      let samples = sameJob ? Number(prev!.samples) : 0;
      let pausedAt = sameJob ? prev!.paused_at : null;

      const res = await detectOnce(db, job.orgId, connId, deviceId, cfg);
      const now = new Date();
      if (res) {
        score = ewmUpdate(score, res.probability);
        samples += 1;
      }

      // Trip once per print: pause + attention + notify.
      if (res && !pausedAt && cfg.auto_pause && crossed(score, cfg.threshold)) {
        pausedAt = now;
        try {
          const driver = await buildDriverById(db, job.orgId, connId);
          if (driver?.pauseJob && active.remote_job_id) await driver.pauseJob(active.remote_job_id);
        } catch {
          /* couldn't reach the manager — still flag it so a human looks */
        }
        await db.updateTable("digifab_jobs").set({ status: "paused", updated_at: now }).where("id", "=", active.id).execute();
        await db
          .insertInto("digifab_device_attention")
          .values({ connection_id: connId, remote_device_id: deviceId, job_id: active.id, reason: "failure-suspected", note: `AI failure score ${score.toFixed(2)}` })
          .onConflict((oc) => oc.columns(["connection_id", "remote_device_id"]).doNothing())
          .execute();
        void platform().events.emit("digifab.print.failure_suspected", {
          orgId: job.orgId,
          connectionId: connId,
          deviceId,
          jobId: active.id,
          fileRef: active.file_ref,
          score,
          source: res.source,
        });
      }

      await db
        .insertInto("digifab_failure_watch")
        .values({
          connection_id: connId,
          device_id: deviceId,
          job_key: active.id,
          score,
          samples,
          last_probability: res?.probability ?? null,
          last_source: res?.source ?? null,
          paused_at: pausedAt,
          last_sample_at: now,
          watch_at: now,
          updated_at: now,
        })
        .onConflict((oc) =>
          oc.columns(["connection_id", "device_id"]).doUpdateSet({
            job_key: active.id,
            score,
            samples,
            last_probability: res?.probability ?? null,
            last_source: res?.source ?? null,
            paused_at: pausedAt,
            last_sample_at: now,
            watch_at: now,
            updated_at: now,
          }),
        )
        .execute();

      // Keep sampling while it's still printing and we haven't already tripped.
      if (!pausedAt) {
        await platform().queue.enqueue({
          orgId: job.orgId,
          queue: FAILURE_WATCH_QUEUE,
          payload: { connId, deviceId },
          runAt: new Date(Date.now() + Math.max(5, cfg.sample_interval_sec) * 1000),
        });
      }
    } finally {
      await platform().tenants.releaseIdleDb(job.orgId);
    }
  });
}
