// Backend-owned, durable cache of a printer's on-disk gcode files + the slicer
// thumbnail/estimate per file. The UI reads THIS (instant, always warm); the
// printer is touched only by the background warmer below — a self-perpetuating
// core-queue loop (same shape as the poll-worker, no cron). Thumbnails are
// immutable per (name,size,modified): fetched once, persisted, never re-pulled
// until the file actually changes. So opening a printer never hits the machine.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB, DigifabPrinterFilesTable } from "./db.js";
import type { MachineDriver, RemoteFile, RemoteFileInfo } from "./drivers/types.js";
import { buildDriverById } from "./jobs-core.js";

export const FILES_WARM_QUEUE = "digifab.files-warm";
const WARM_INTERVAL_MS = 15 * 60_000; // heartbeat once fully cached — keeps the list fresh
const BACKFILL_INTERVAL_MS = 45_000; // tighter cadence while thumbnails are still backfilling
const BACKFILL_BATCH = 25; // thumbnails fetched per warm tick — gentle on the printer
const WARM_ALIVE_MS = 2.5 * WARM_INTERVAL_MS; // a fresher heartbeat than this → a loop is alive

type FileRow = Omit<DigifabPrinterFilesTable, "list_seen_at">;

function rowToFile(r: { name: string; size: number | null; modified: string | null }): RemoteFile {
  return { name: r.name, ...(r.size != null ? { size: r.size } : {}), ...(r.modified ? { modified: r.modified } : {}) };
}
function rowToInfo(r: FileRow): RemoteFileInfo {
  return {
    name: r.name,
    ...(r.size != null ? { size: r.size } : {}),
    ...(r.print_time_sec != null ? { printTimeSec: r.print_time_sec } : {}),
    ...(r.filament_mm != null ? { filamentMm: r.filament_mm } : {}),
    ...(r.num_layers != null ? { numLayers: r.num_layers } : {}),
    ...(r.height != null ? { height: r.height } : {}),
    ...(r.generated_by ? { generatedBy: r.generated_by } : {}),
    ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}),
  };
}

/** The cached file list (+ when it was last pulled from the printer). */
export async function readCachedList(
  db: Kysely<DigifabDB>,
  connId: string,
  deviceId: string,
): Promise<{ files: RemoteFile[]; listFetchedAt: Date | null }> {
  const rows = await db
    .selectFrom("digifab_printer_files")
    .select(["name", "size", "modified"])
    .where("connection_id", "=", connId)
    .where("device_id", "=", deviceId)
    .execute();
  const meta = await db
    .selectFrom("digifab_printer_file_meta")
    .select("list_fetched_at")
    .where("connection_id", "=", connId)
    .where("device_id", "=", deviceId)
    .executeTakeFirst();
  return { files: rows.map(rowToFile), listFetchedAt: meta?.list_fetched_at ?? null };
}

/** One file's cached estimate+thumbnail. `fetched=false` → not pulled yet. */
export async function readCachedInfo(
  db: Kysely<DigifabDB>,
  connId: string,
  deviceId: string,
  name: string,
): Promise<{ info: RemoteFileInfo | null; fetched: boolean }> {
  const row = await db
    .selectFrom("digifab_printer_files")
    .selectAll()
    .where("connection_id", "=", connId)
    .where("device_id", "=", deviceId)
    .where("name", "=", name)
    .executeTakeFirst();
  if (!row) return { info: null, fetched: false };
  return { info: row.info_fetched_at ? rowToInfo(row) : null, fetched: !!row.info_fetched_at };
}

async function touchWarm(db: Kysely<DigifabDB>, connId: string, deviceId: string): Promise<void> {
  const now = new Date();
  await db
    .insertInto("digifab_printer_file_meta")
    .values({ connection_id: connId, device_id: deviceId, warm_at: now })
    .onConflict((oc) => oc.columns(["connection_id", "device_id"]).doUpdateSet({ warm_at: now }))
    .execute();
}

/** Pull the live list, upsert rows, drop vanished files, and invalidate the
 *  cached info of any file whose size/date changed (so its thumbnail re-pulls). */
export async function refreshList(
  db: Kysely<DigifabDB>,
  driver: MachineDriver,
  connId: string,
  deviceId: string,
): Promise<RemoteFile[]> {
  if (!driver.listFiles) return (await readCachedList(db, connId, deviceId)).files;
  const live = await driver.listFiles(deviceId);
  const existing = await db
    .selectFrom("digifab_printer_files")
    .select(["name", "size", "modified"])
    .where("connection_id", "=", connId)
    .where("device_id", "=", deviceId)
    .execute();
  const prev = new Map(existing.map((e) => [e.name, e]));
  const now = new Date();
  for (const f of live) {
    const p = prev.get(f.name);
    const changed = !!p && (p.size !== (f.size ?? null) || (p.modified ?? null) !== (f.modified ?? null));
    const invalidate = changed
      ? { print_time_sec: null, filament_mm: null, num_layers: null, height: null, generated_by: null, thumbnail: null, info_fetched_at: null }
      : {};
    await db
      .insertInto("digifab_printer_files")
      .values({ connection_id: connId, device_id: deviceId, name: f.name, size: f.size ?? null, modified: f.modified ?? null, list_seen_at: now })
      .onConflict((oc) =>
        oc.columns(["connection_id", "device_id", "name"]).doUpdateSet({ size: f.size ?? null, modified: f.modified ?? null, list_seen_at: now, ...invalidate }),
      )
      .execute();
  }
  const names = live.map((f) => f.name);
  let del = db.deleteFrom("digifab_printer_files").where("connection_id", "=", connId).where("device_id", "=", deviceId);
  if (names.length) del = del.where("name", "not in", names);
  await del.execute();
  await db
    .insertInto("digifab_printer_file_meta")
    .values({ connection_id: connId, device_id: deviceId, list_fetched_at: now, warm_at: now })
    .onConflict((oc) => oc.columns(["connection_id", "device_id"]).doUpdateSet({ list_fetched_at: now, warm_at: now }))
    .execute();
  return live;
}

/** Fetch + persist one file's estimate+thumbnail if not cached yet; return it. */
export async function ensureInfo(
  db: Kysely<DigifabDB>,
  driver: MachineDriver,
  connId: string,
  deviceId: string,
  name: string,
): Promise<RemoteFileInfo | null> {
  const cached = await readCachedInfo(db, connId, deviceId, name);
  if (cached.fetched) return cached.info;
  if (!driver.fileInfo) return null;
  const info = await driver.fileInfo(deviceId, name);
  const now = new Date();
  const fields = {
    print_time_sec: info?.printTimeSec ?? null,
    filament_mm: info?.filamentMm ?? null,
    num_layers: info?.numLayers ?? null,
    height: info?.height ?? null,
    generated_by: info?.generatedBy ?? null,
    thumbnail: info?.thumbnail ?? null,
    info_fetched_at: now,
  };
  await db
    .insertInto("digifab_printer_files")
    .values({ connection_id: connId, device_id: deviceId, name, size: info?.size ?? null, list_seen_at: now, ...fields })
    .onConflict((oc) => oc.columns(["connection_id", "device_id", "name"]).doUpdateSet(fields))
    .execute();
  return info;
}

/** Backfill up to `limit` files lacking info; return how many remain missing. */
async function backfillMissing(
  db: Kysely<DigifabDB>,
  driver: MachineDriver,
  connId: string,
  deviceId: string,
  limit: number,
): Promise<number> {
  const missing = await db
    .selectFrom("digifab_printer_files")
    .select("name")
    .where("connection_id", "=", connId)
    .where("device_id", "=", deviceId)
    .where("info_fetched_at", "is", null)
    .limit(limit)
    .execute();
  for (const m of missing) {
    try {
      await ensureInfo(db, driver, connId, deviceId, m.name);
    } catch {
      /* unreachable file → leave it pending, retry next tick */
    }
  }
  const remain = await db
    .selectFrom("digifab_printer_files")
    .select((eb) => eb.fn.countAll<number>().as("c"))
    .where("connection_id", "=", connId)
    .where("device_id", "=", deviceId)
    .where("info_fetched_at", "is", null)
    .executeTakeFirst();
  return Number(remain?.c ?? 0);
}

/** Start the background warm loop for a device, unless one is already alive
 *  (heartbeat fresher than WARM_ALIVE_MS). Claims the heartbeat slot first to
 *  avoid two loops racing from concurrent opens. Cheap + idempotent — safe to
 *  call on every request. */
export async function ensureWarming(db: Kysely<DigifabDB>, orgId: string, connId: string, deviceId: string): Promise<void> {
  const meta = await db
    .selectFrom("digifab_printer_file_meta")
    .select("warm_at")
    .where("connection_id", "=", connId)
    .where("device_id", "=", deviceId)
    .executeTakeFirst();
  if (meta?.warm_at && Date.now() - new Date(meta.warm_at).getTime() < WARM_ALIVE_MS) return; // a loop is alive
  await touchWarm(db, connId, deviceId); // claim the slot
  await platform().queue.enqueue({ orgId, queue: FILES_WARM_QUEUE, payload: { connId, deviceId }, runAt: new Date(Date.now() + 500) });
}

let warmerRegistered = false;
export function registerFileWarmer(): void {
  if (warmerRegistered) return;
  warmerRegistered = true;
  platform().queue.registerWorker(FILES_WARM_QUEUE, async (job) => {
    const { connId, deviceId } = (job.payload ?? {}) as { connId?: string; deviceId?: string };
    if (!connId || !deviceId) return;
    const db = (await platform().tenants.getDb(job.orgId)) as Kysely<DigifabDB>;
    const driver = await buildDriverById(db, job.orgId, connId);
    if (!driver?.listFiles) return; // connection gone / can't list files → let the loop die
    let listOk = false;
    try {
      await refreshList(db, driver, connId, deviceId);
      listOk = true;
    } catch {
      /* printer briefly unreachable → keep the loop alive, retry on the slow cadence */
    }
    let remaining = 0;
    if (listOk) {
      try {
        remaining = await backfillMissing(db, driver, connId, deviceId, BACKFILL_BATCH);
      } catch {
        /* ignore — next tick retries */
      }
    }
    await touchWarm(db, connId, deviceId);
    // Fast cadence only while reachable AND still backfilling; otherwise the slow heartbeat.
    const next = listOk && remaining > 0 ? BACKFILL_INTERVAL_MS : WARM_INTERVAL_MS;
    await platform().queue.enqueue({ orgId: job.orgId, queue: FILES_WARM_QUEUE, payload: { connId, deviceId }, runAt: new Date(Date.now() + next) });
  });
}
