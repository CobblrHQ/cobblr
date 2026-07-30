// Backup — a full point-in-time copy of a workspace: the Blueprint (its
// setup) + every tenant-DB row + every uploaded file. Restoring a backup
// into a fresh workspace reproduces it exactly. See
// docs/architecture/blueprint-backup-export.md.
//
//   Backup = Blueprint + Data + Files.
//
// Archive layout (a zip):
//   manifest.json          — the blueprint (kind:"cobblr.backup") + data_index
//   data/<table>.jsonl     — one tenant-DB table per file, JSON-lines (ids kept)
//   files/<file_id>        — the original bytes of every uploaded file
//
// Restore preserves entity ids (so foreign keys just work — no remap) and
// only re-mints FILE ids (files.write owns the core_files row + re-derives
// image variants); file references in rows are value-swapped old→new.
//
// Mounted at /api/v1/orgs/:slug/backup. Owner/admin only.

import { Router } from "express";
import multer from "multer";
import { ZipArchive } from "archiver";
import unzipper from "unzipper";
import { Client } from "pg";
import { z } from "zod";
import { SignJWT, jwtVerify } from "jose";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import { env } from "../env.js";
import {
  listBackupDrivers,
  getBackupDriver,
  runDestination,
  listDestinationBackups,
  nextRunFrom,
  encryptDestCredentials,
  googleDriveConfigured,
  brokerClientConfigured,
  brokerServerEnabled,
  googleDriveUsable,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
} from "../platform/backup-destinations.js";
import { randomBytes } from "node:crypto";
import * as activity from "../platform/activity.js";
import { captureBlueprint, applyBlueprint, type BlueprintManifestT } from "./blueprint.js";

// Tables the generic dump/restore must never touch:
//  - `migrations`  — the tenant migration runner's bookkeeping; the fresh
//                    target already has the correct rows.
//  - `core_files`  — handled specially (files.write owns the row + re-derives
//                    variants on restore).
const EXCLUDED_TABLES = new Set(["migrations", "core_files"]);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

interface CoreFilesRow {
  id: string;
  filename: string | null;
  mime_type: string | null;
}
interface BackupTenantDB {
  core_files: CoreFilesRow;
}

interface DataIndexTable {
  table: string;
  file: string;
  row_count: number;
}
interface DataIndexFile {
  file_id: string;
  name: string;
  mime: string;
}

/** A one-off SUPERUSER connection to a specific tenant DB. The per-tenant role
 *  (from db_credentials) can't `SET session_replication_role`, so the FK-free
 *  bulk restore runs as the platform superuser instead (same role provisioning
 *  uses). Caller must `end()` it. */
function superuserTenantClient(dbName: string): Client {
  const url = new URL(env.SUPERUSER_DATABASE_URL);
  return new Client({
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: dbName,
  });
}

async function listTenantTables(tdb: Kysely<unknown>): Promise<string[]> {
  const r = await sql<{ table_name: string }>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `.execute(tdb);
  return r.rows.map((x) => x.table_name).filter((t) => t !== "migrations");
}

export const backupRouter = Router({ mergeParams: true });

// ── Build the backup zip (reused by GET /export AND the destinations cron) ──
/** Snapshot a workspace into a backup zip buffer: manifest.json (the blueprint
 *  + data_index) + data/<table>.jsonl (every row) + files/<id> (original bytes).
 *  Personal-scale: buffered in memory; a streaming dump is a future option. */
export async function buildBackupZip(orgId: string, slug: string): Promise<{ buffer: Buffer; filename: string }> {
  const blueprint = await captureBlueprint(orgId);
  const tdb = (await getTenantDb(orgId)) as unknown as Kysely<BackupTenantDB>;
  const allTables = await listTenantTables(tdb as unknown as Kysely<unknown>);
  const hasFiles = allTables.includes("core_files");
  const tables = allTables.filter((t) => t !== "core_files");

  const dataFiles: Array<{ file: string; jsonl: string; index: DataIndexTable }> = [];
  for (const table of tables) {
    const rows = (await sql<Record<string, unknown>>`select * from ${sql.ref(table)}`.execute(tdb as unknown as Kysely<unknown>)).rows;
    dataFiles.push({
      file: `data/${table}.jsonl`,
      jsonl: rows.map((r) => JSON.stringify(r)).join("\n"),
      index: { table, file: `data/${table}.jsonl`, row_count: rows.length },
    });
  }

  const fileRows = hasFiles
    ? await (tdb as Kysely<BackupTenantDB>).selectFrom("core_files").select(["id", "filename", "mime_type"]).execute()
    : [];
  const fileBlobs: Array<{ name: string; bytes: Buffer; index: DataIndexFile }> = [];
  for (const f of fileRows) {
    const got = await platform().files.read(orgId, f.id, "original");
    if (!got) continue;
    fileBlobs.push({
      name: `files/${f.id}`,
      bytes: Buffer.from(got.bytes),
      index: { file_id: f.id, name: got.filename || f.filename || f.id, mime: got.mimeType || f.mime_type || "application/octet-stream" },
    });
  }

  const manifest = {
    ...blueprint,
    kind: "cobblr.backup" as const,
    data_index: { tables: dataFiles.map((d) => d.index), files: fileBlobs.map((b) => b.index) },
  };

  const archive = new ZipArchive({ zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on("end", resolve);
    archive.on("error", reject);
  });
  archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  for (const d of dataFiles) archive.append(d.jsonl, { name: d.file });
  for (const b of fileBlobs) archive.append(b.bytes, { name: b.name });
  await archive.finalize();
  await done;

  // Seconds-granular so two runs in the same minute don't collide on one name
  // (a filesystem would overwrite; Google Drive allows dup names → duplicates).
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return { buffer: Buffer.concat(chunks), filename: `backup-${slug}-${stamp}.zip` };
}

// ── Export: download the backup zip ──────────────────────────────────
backupRouter.get("/export", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const { buffer, filename } = await buildBackupZip(req.tenant!.org.id, req.tenant!.org.slug);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// ── Restore ──────────────────────────────────────────────────────────

/** Deep-swap any string value matching an old file id for its new id.
 *  Covers `image_file_id`, ids embedded in `metadata`/`config` jsonb, etc.
 *  in one generic pass — file ids are UUIDs, so value-equality is safe. */
function remapFileIds(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapFileIds(v, map));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = remapFileIds(v, map);
    return out;
  }
  return value;
}

interface ColumnInfo {
  jsonb: Set<string>;
  /** GENERATED ALWAYS columns (e.g. tsvector search_blob) — cannot be inserted
   *  into; Postgres recomputes them. We skip them on restore. */
  generated: Set<string>;
}
async function columnInfo(tdb: Kysely<unknown>, table: string): Promise<ColumnInfo> {
  const r = await sql<{ column_name: string; data_type: string; is_generated: string }>`
    select column_name, data_type, is_generated from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `.execute(tdb);
  return {
    jsonb: new Set(r.rows.filter((c) => c.data_type === "jsonb" || c.data_type === "json").map((c) => c.column_name)),
    generated: new Set(r.rows.filter((c) => c.is_generated === "ALWAYS").map((c) => c.column_name)),
  };
}

interface ParsedBackup {
  manifest: BlueprintManifestT & { data_index?: { tables: DataIndexTable[]; files: DataIndexFile[] } };
  tables: Map<string, Array<Record<string, unknown>>>;
  files: Map<string, Buffer>;
}

async function parseBackupZip(buf: Buffer): Promise<ParsedBackup> {
  const dir = await unzipper.Open.buffer(buf);
  let manifest: ParsedBackup["manifest"] | null = null;
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const files = new Map<string, Buffer>();
  for (const entry of dir.files) {
    if (entry.type !== "File") continue;
    if (entry.path === "manifest.json") {
      manifest = JSON.parse((await entry.buffer()).toString("utf8"));
    } else if (entry.path.startsWith("data/") && entry.path.endsWith(".jsonl")) {
      const table = entry.path.slice("data/".length, -".jsonl".length);
      const text = (await entry.buffer()).toString("utf8");
      const rows = text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      tables.set(table, rows);
    } else if (entry.path.startsWith("files/")) {
      files.set(entry.path.slice("files/".length), await entry.buffer());
    }
  }
  if (!manifest) throw Object.assign(new Error("manifest.json missing from backup"), { code: "bad_archive" });
  return { manifest, tables, files };
}

backupRouter.post("/restore", requireAuth, withTenant, upload.single("file"), async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = req.tenant!.org.id;
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file?.buffer) {
      res.status(400).json({ error: { code: "missing_file", message: "Multipart field 'file' (the backup .zip) is required." } });
      return;
    }
    const confirm = String((req.body as { confirm?: unknown }).confirm ?? "");

    let parsed: ParsedBackup;
    try {
      parsed = await parseBackupZip(file.buffer);
    } catch (err) {
      res.status(400).json({ error: { code: "bad_archive", message: (err as Error).message } });
      return;
    }
    const { manifest, tables, files } = parsed;

    const tdb = (await getTenantDb(orgId)) as unknown as Kysely<unknown>;

    // Guard: refuse to clobber a populated workspace unless explicitly told to.
    // Checked against the tables that exist NOW (the module tables don't exist
    // until the blueprint apply below — but if the user already has data, the
    // foundational/enabled tables that overlap the dump will show it).
    const existingNow = new Set((await listTenantTables(tdb)).filter((t) => !EXCLUDED_TABLES.has(t)));
    let targetHasData = false;
    for (const t of [...tables.keys()].filter((t) => existingNow.has(t))) {
      const c = await sql<{ n: number }>`select count(*)::int as n from ${sql.ref(t)}`.execute(tdb);
      if ((c.rows[0]?.n ?? 0) > 0) {
        targetHasData = true;
        break;
      }
    }

    // Total rows we'll restore = every dumped row (the blueprint apply creates
    // the module tables to receive them).
    const totalRows = [...tables.values()].reduce((n, rows) => n + rows.length, 0);

    // Dry-run (audit F8): validate the archive + report exactly what a real
    // restore WOULD do — parse, manifest check, row/file/table/bundle counts,
    // whether the target has data — as a 200, never mutating anything. Turns
    // "you discover schema mismatches at commit time" into a preflight.
    if (String((req.body as { dry_run?: unknown }).dry_run ?? "") === "true") {
      res.json({
        ok: true,
        dry_run: true,
        would: {
          restore_rows: totalRows,
          restore_files: files.size,
          restore_tables: tables.size,
          install_bundles: (manifest.bundles ?? []).length,
          replace_existing_data: targetHasData,
        },
        tables: [...tables.entries()].map(([name, rows]) => ({ name, rows: rows.length })),
      });
      return;
    }

    if (confirm !== "replace" && confirm !== "true") {
      res.status(409).json({
        error: {
          code: "needs_consent",
          message: targetHasData
            ? "This workspace already has data. Restoring REPLACES it. Re-POST with confirm=replace to proceed."
            : "Restore will recreate this workspace from the backup. Re-POST with confirm=true to proceed.",
          details: {
            restore_rows: totalRows,
            restore_files: files.size,
            restore_tables: tables.size,
            install_bundles: (manifest.bundles ?? []).length,
            target_not_empty: targetHasData,
          },
        },
      });
      return;
    }

    const sess = {
      id: req.session!.id,
      display_name: req.session!.display_name ?? null,
      auth_method: req.session!.auth_method,
      api_token_id: req.session!.api_token_id ?? null,
    };

    // 1. Apply the blueprint — enables modules so every module table EXISTS
    //    (the data tables don't exist in a fresh workspace until now).
    const blueprintApplied = await applyBlueprint(orgId, sess, manifest);

    // 2. Now that the schema is complete, figure out which dumped tables we can
    //    load (intersection with the post-apply table set).
    const targetTables = new Set((await listTenantTables(tdb)).filter((t) => !EXCLUDED_TABLES.has(t)));
    const restorable = [...tables.keys()].filter((t) => targetTables.has(t) && !EXCLUDED_TABLES.has(t));

    // 3. Restore files → build old→new id map (files.write re-derives image
    //    variants + owns the core_files row). File ids in rows are value-swapped.
    const fileMap = new Map<string, string>();
    let filesRestored = 0;
    const indexByOld = new Map((manifest.data_index?.files ?? []).map((f) => [f.file_id, f]));
    for (const [oldId, bytes] of files) {
      const idx = indexByOld.get(oldId);
      const w = await platform().files.write(orgId, bytes, {
        filename: idx?.name ?? oldId,
        mimeType: idx?.mime ?? "application/octet-stream",
      });
      if (w?.fileId) {
        fileMap.set(oldId, w.fileId);
        filesRestored++;
      }
    }

    // 4. Bulk-load rows in ONE transaction so SET LOCAL session_replication_role
    //    pins to this connection: FK triggers off (ids preserved → references
    //    just work, any order), atomic, and reverts on commit. Requires the
    //    app's DB role to be superuser (it is — see CLAUDE.md DB setup).
    const tableMeta = new Map<string, ColumnInfo>();
    for (const t of restorable) tableMeta.set(t, await columnInfo(tdb, t));

    const dbName = (await meta.selectFrom("orgs").select("db_name").where("id", "=", orgId).executeTakeFirstOrThrow()).db_name;
    const client = superuserTenantClient(dbName);
    await client.connect();
    let rowsRestored = 0;
    try {
      // session_replication_role=replica turns OFF FK enforcement: ids are
      // preserved so references just work in ANY insert order, and DELETE
      // won't trip "referenced by a FK". Requires superuser — hence this
      // dedicated connection (the per-tenant role can't set it). Atomic.
      await client.query("SET session_replication_role = replica");
      await client.query("BEGIN");
      for (const t of restorable) await client.query(`DELETE FROM "${t}"`);
      for (const t of restorable) {
        const rows = tables.get(t) ?? [];
        const info = tableMeta.get(t) ?? { jsonb: new Set<string>(), generated: new Set<string>() };
        for (const raw of rows) {
          const row = remapFileIds(raw, fileMap) as Record<string, unknown>;
          // Skip GENERATED columns — Postgres recomputes them on insert.
          const cols = Object.keys(row).filter((c) => !info.generated.has(c));
          if (cols.length === 0) continue;
          const placeholders = cols.map((c, i) => (info.jsonb.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`));
          const params = cols.map((c) => {
            const v = row[c];
            if (v === null || v === undefined) return null;
            return info.jsonb.has(c) ? JSON.stringify(v) : (v as unknown);
          });
          const colList = cols.map((c) => `"${c}"`).join(", ");
          await client.query(`INSERT INTO "${t}" (${colList}) VALUES (${placeholders.join(", ")})`, params);
          rowsRestored++;
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      await client.end();
    }

    await activity.log({ orgId, action: "backup_restored", ref: { module: null, entityType: "backup", entityId: manifest.id } });
    res.status(201).json({
      restored: {
        blueprint: blueprintApplied,
        tables: restorable.length,
        rows: rowsRestored,
        files: filesRestored,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Destinations (Phase C) — where automatic backups go ──────────────
// A destination = driver + config + (encrypted) credentials + schedule. The
// cron pushes a backup on schedule; "Back up now" runs one immediately. Owner/
// admin only. Credentials are never returned.

function publicDest(d: {
  id: string;
  driver: string;
  label: string;
  config: Record<string, unknown>;
  credentials_enc: string;
  schedule: string;
  retention: number;
  enabled: boolean;
  last_run_at: Date | null;
  last_status: string | null;
  next_run_at: Date | null;
}) {
  return {
    id: d.id,
    driver: d.driver,
    label: d.label,
    config: d.config,
    connected: !!d.credentials_enc,
    schedule: d.schedule,
    retention: d.retention,
    enabled: d.enabled,
    last_run_at: d.last_run_at,
    last_status: d.last_status,
    next_run_at: d.next_run_at,
  };
}

// List destinations + the available drivers (so the UI can offer a create form).
backupRouter.get("/destinations", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const rows = await meta
      .selectFrom("backup_destinations")
      .selectAll()
      .where("org_id", "=", req.tenant!.org.id)
      .orderBy("created_at", "asc")
      .execute();
    res.json({ destinations: rows.map(publicDest), drivers: listBackupDrivers() });
  } catch (err) {
    next(err);
  }
});

/** Move a driver's `secret`-flagged config fields out of (plaintext) config into
 *  a secrets object that gets encrypted. Empty values are dropped (so editing a
 *  non-secret field with the secret left blank preserves the stored secret). */
function splitSecrets(driverId: string, config: Record<string, unknown>): { publicConfig: Record<string, unknown>; secrets: Record<string, unknown> } {
  const secretKeys = new Set((getBackupDriver(driverId)?.configFields() ?? []).filter((f) => f.secret).map((f) => f.key));
  const publicConfig: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (secretKeys.has(k)) {
      if (v !== "" && v != null) secrets[k] = v;
    } else {
      publicConfig[k] = v;
    }
  }
  return { publicConfig, secrets };
}

const DestCreate = z.object({
  driver: z.string().min(1),
  label: z.string().min(1).max(120),
  config: z.record(z.unknown()).optional(),
  credentials: z.record(z.unknown()).optional(),
  schedule: z.enum(["off", "daily", "weekly"]).optional(),
  retention: z.number().int().min(1).max(365).optional(),
});
backupRouter.post("/destinations", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const body = DestCreate.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad destination", details: body.error.issues } });
      return;
    }
    const driver = getBackupDriver(body.data.driver);
    if (!driver || !driver.available()) {
      res.status(400).json({ error: { code: "driver_unavailable", message: `Driver '${body.data.driver}' is not available.` } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const schedule = body.data.schedule ?? "off";
    const { publicConfig, secrets } = splitSecrets(body.data.driver, body.data.config ?? {});
    const allCreds = { ...secrets, ...(body.data.credentials ?? {}) };
    const credEnc = Object.keys(allCreds).length > 0 ? await encryptDestCredentials(orgId, allCreds) : "";
    const row = await meta
      .insertInto("backup_destinations")
      .values({
        org_id: orgId,
        driver: body.data.driver,
        label: body.data.label,
        config: sql`${JSON.stringify(publicConfig)}::jsonb`,
        credentials_enc: credEnc,
        schedule,
        retention: body.data.retention ?? 7,
        next_run_at: schedule === "off" ? null : nextRunFrom(schedule, new Date()),
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ destination: publicDest(row) });
  } catch (err) {
    next(err);
  }
});

const DestPatch = z.object({
  label: z.string().min(1).max(120).optional(),
  config: z.record(z.unknown()).optional(),
  credentials: z.record(z.unknown()).optional(),
  schedule: z.enum(["off", "daily", "weekly"]).optional(),
  retention: z.number().int().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
});
backupRouter.patch("/destinations/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const body = DestPatch.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad patch", details: body.error.issues } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const existing = await meta
      .selectFrom("backup_destinations")
      .selectAll()
      .where("id", "=", req.params.id!)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!existing) {
      res.status(404).json({ error: { code: "not_found", message: "destination not found" } });
      return;
    }
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (body.data.label !== undefined) patch.label = body.data.label;
    if (body.data.retention !== undefined) patch.retention = body.data.retention;
    if (body.data.enabled !== undefined) patch.enabled = body.data.enabled;
    // Config may carry secret fields — split them out into encrypted creds, and
    // only touch credentials_enc when new secrets / creds are actually supplied
    // (so a plain field edit with the secret left blank preserves it).
    if (body.data.config !== undefined) {
      const { publicConfig, secrets } = splitSecrets(existing.driver, body.data.config);
      patch.config = sql`${JSON.stringify(publicConfig)}::jsonb`;
      const allCreds = { ...secrets, ...(body.data.credentials ?? {}) };
      if (Object.keys(allCreds).length) patch.credentials_enc = await encryptDestCredentials(orgId, allCreds);
    } else if (body.data.credentials !== undefined) {
      patch.credentials_enc = Object.keys(body.data.credentials).length ? await encryptDestCredentials(orgId, body.data.credentials) : "";
    }
    const schedule = body.data.schedule ?? existing.schedule;
    if (body.data.schedule !== undefined) {
      patch.schedule = schedule;
      patch.next_run_at = schedule === "off" ? null : nextRunFrom(schedule, new Date());
    }
    const row = await meta
      .updateTable("backup_destinations")
      .set(patch as never)
      .where("id", "=", req.params.id!)
      .where("org_id", "=", orgId)
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json({ destination: publicDest(row) });
  } catch (err) {
    next(err);
  }
});

backupRouter.delete("/destinations/:id", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    await meta
      .deleteFrom("backup_destinations")
      .where("id", "=", req.params.id!)
      .where("org_id", "=", req.tenant!.org.id)
      .execute();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Run a destination now (inline — build + push + record).
backupRouter.post("/destinations/:id/run", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const dest = await meta
      .selectFrom("backup_destinations")
      .select("id")
      .where("id", "=", req.params.id!)
      .where("org_id", "=", req.tenant!.org.id)
      .executeTakeFirst();
    if (!dest) {
      res.status(404).json({ error: { code: "not_found", message: "destination not found" } });
      return;
    }
    const result = await runDestination(req.params.id!, new Date());
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    next(err);
  }
});

// The backups that actually exist in the destination right now — a live listing
// (Drive files.list / NAS readdir / S3 list), so a user can SEE their backups
// with real timestamps + sizes instead of just "last: ok".
backupRouter.get("/destinations/:id/backups", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const dest = await meta
      .selectFrom("backup_destinations")
      .select("id")
      .where("id", "=", req.params.id!)
      .where("org_id", "=", req.tenant!.org.id)
      .executeTakeFirst();
    if (!dest) {
      res.status(404).json({ error: { code: "not_found", message: "destination not found" } });
      return;
    }
    try {
      const backups = await listDestinationBackups(req.params.id!, req.tenant!.org.id);
      res.json({ backups });
    } catch (err) {
      // A live-list failure (expired Drive token, unreachable NAS) is not a 500 —
      // surface it so the UI can say "couldn't list" instead of blanking the page.
      res.status(502).json({ error: { code: "list_failed", message: (err as Error).message.slice(0, 200) } });
    }
  } catch (err) {
    next(err);
  }
});

// ── Google Drive connect (OAuth) — direct + broker ───────────────────
// Two ways to connect (see docs/operations/google-drive-backup-setup.md):
//  • DIRECT — this instance has its own Google app (GOOGLE_OAUTH_*); it runs
//    the whole OAuth itself.
//  • BROKER — this instance has BACKUP_OAUTH_BROKER_URL + SHARED_SECRET and no
//    Google app; it borrows a broker (an instance that HAS a Google app, e.g.
//    cobblr.me). The refresh token comes back server-to-server (one-time
//    link code), never through a browser URL. This instance can ALSO be a
//    broker for others when brokerServerEnabled().
//
// Drive itself is NOT live-verified in CI (no real Google app); the broker
// dance IS verified end-to-end against a stub Google + this instance acting
// as both client and broker.
const googleSecret = () => new TextEncoder().encode(env.JWT_SECRET);
const SCOPE = "https://www.googleapis.com/auth/drive.file";

// Broker-side, in-memory link store: link_code → refresh_token, single-use +
// short TTL. The api is single-process per instance; a restart just makes the
// user retry. The token only ever travels server-to-server (start/redeem).
const brokerLinks = new Map<string, { refresh: string; exp: number }>();
function putBrokerLink(refresh: string): string {
  const code = randomBytes(24).toString("base64url");
  brokerLinks.set(code, { refresh, exp: Date.now() + 5 * 60 * 1000 });
  return code;
}
function takeBrokerLink(code: string): string | null {
  const e = brokerLinks.get(code);
  if (!e) return null;
  brokerLinks.delete(code); // single use
  if (e.exp < Date.now()) return null;
  return e.refresh;
}

function googleConsentUrl(state: string, redirectUri: string): string {
  const url = new URL(GOOGLE_AUTH_URL());
  url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}
async function exchangeCode(code: string, redirectUri: string): Promise<string | null> {
  const r = await fetch(GOOGLE_TOKEN_URL(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const j = (await r.json()) as { refresh_token?: string };
  return r.ok ? j.refresh_token ?? null : null;
}
async function storeGoogleDest(orgId: string, label: string, refresh: string): Promise<void> {
  const credEnc = await encryptDestCredentials(orgId, { refresh_token: refresh });
  const existing = await meta.selectFrom("backup_destinations").select("id").where("org_id", "=", orgId).where("driver", "=", "google_drive").executeTakeFirst();
  if (existing) {
    await meta.updateTable("backup_destinations").set({ credentials_enc: credEnc, updated_at: new Date() }).where("id", "=", existing.id).execute();
  } else {
    await meta
      .insertInto("backup_destinations")
      .values({ org_id: orgId, driver: "google_drive", label, config: sql`'{}'::jsonb`, credentials_enc: credEnc, schedule: "off", retention: 7 } as never)
      .execute();
  }
}

// CLIENT: start the connect (direct OR via broker). Returns the URL to send the
// user's browser to.
backupRouter.post("/destinations/google/connect", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    if (!googleDriveUsable()) {
      res.status(400).json({ error: { code: "google_not_configured", message: "Google Drive isn't set up on this server (a Google app or a broker)." } });
      return;
    }
    const orgId = req.tenant!.org.id;
    const label = typeof req.body?.label === "string" ? req.body.label : "Google Drive";

    if (googleDriveConfigured() && env.GOOGLE_OAUTH_REDIRECT_URL) {
      // DIRECT
      const state = await new SignJWT({ org: orgId, label })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("cobblr")
        .setAudience("backup-google")
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .sign(googleSecret());
      res.json({ url: googleConsentUrl(state, env.GOOGLE_OAUTH_REDIRECT_URL) });
      return;
    }

    // BROKER CLIENT — ask the broker for a consent URL. Our org rides in a
    // client_state WE sign (the broker echoes it back opaquely; our /return
    // verifies it).
    const clientState = await new SignJWT({ org: orgId, label })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("cobblr")
      .setAudience("backup-google-client")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(googleSecret());
    const base = (req.protocol + "://" + req.get("host")) as string;
    const returnUrl = `${base}/api/v1/backup/google/broker/return`;
    const br = await fetch(`${env.BACKUP_OAUTH_BROKER_URL}/api/v1/backup/google/broker/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-broker-secret": env.BACKUP_BROKER_SHARED_SECRET! },
      body: JSON.stringify({ return_url: returnUrl, client_state: clientState }),
      signal: AbortSignal.timeout(15000),
    });
    const bj = (await br.json()) as { url?: string; error?: { message?: string } };
    if (!br.ok || !bj.url) {
      res.status(502).json({ error: { code: "broker_error", message: bj.error?.message ?? `Broker rejected the request (${br.status})` } });
      return;
    }
    res.json({ url: bj.url });
  } catch (err) {
    next(err);
  }
});

// Top-level routes (browser redirects + server-to-server; not org-scoped).
export const backupGoogleCallbackRouter = Router();

// BROKER SERVER: a client asks us to broker a consent. We must have a Google app
// + a shared secret. We wrap the client's opaque state in OUR broker-signed
// state and hand back a consent URL pointing at OUR callback.
backupGoogleCallbackRouter.post("/backup/google/broker/start", async (req, res, next) => {
  try {
    if (!brokerServerEnabled() || !env.GOOGLE_OAUTH_REDIRECT_URL) {
      res.status(400).json({ error: { code: "not_a_broker", message: "This instance isn't a backup broker." } });
      return;
    }
    if (req.get("x-broker-secret") !== env.BACKUP_BROKER_SHARED_SECRET) {
      res.status(401).json({ error: { code: "bad_secret", message: "Bad broker secret." } });
      return;
    }
    const returnUrl = typeof req.body?.return_url === "string" ? req.body.return_url : "";
    const clientState = typeof req.body?.client_state === "string" ? req.body.client_state : "";
    if (!returnUrl || !clientState) {
      res.status(400).json({ error: { code: "bad_request", message: "return_url + client_state required" } });
      return;
    }
    const brokerState = await new SignJWT({ return_url: returnUrl, client_state: clientState })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("cobblr")
      .setAudience("backup-google-broker")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(googleSecret());
    res.json({ url: googleConsentUrl(brokerState, env.GOOGLE_OAUTH_REDIRECT_URL) });
  } catch (err) {
    next(err);
  }
});

// Google's redirect URI — handles BOTH a direct connect (state.aud=backup-google,
// store on our own org) and a broker relay (state.aud=backup-google-broker,
// mint a link code + bounce back to the client's return_url).
backupGoogleCallbackRouter.get("/backup/google/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const stateTok = typeof req.query.state === "string" ? req.query.state : "";
    if (!code || !stateTok || !googleDriveConfigured() || !env.GOOGLE_OAUTH_REDIRECT_URL) {
      res.status(400).send("Missing code/state or Google not configured.");
      return;
    }
    // Broker relay?
    try {
      const { payload } = await jwtVerify(stateTok, googleSecret(), { issuer: "cobblr", audience: "backup-google-broker" });
      const refresh = await exchangeCode(code, env.GOOGLE_OAUTH_REDIRECT_URL);
      if (!refresh) {
        res.status(502).send("Google did not return a refresh token. Revoke prior access and retry.");
        return;
      }
      const linkCode = putBrokerLink(refresh);
      const ret = new URL(String(payload.return_url));
      ret.searchParams.set("link_code", linkCode);
      ret.searchParams.set("client_state", String(payload.client_state));
      res.redirect(ret.toString());
      return;
    } catch {
      /* not a broker state — fall through to direct */
    }
    // Direct connect on this instance.
    let orgId: string, label: string;
    try {
      const { payload } = await jwtVerify(stateTok, googleSecret(), { issuer: "cobblr", audience: "backup-google" });
      orgId = String(payload.org);
      label = typeof payload.label === "string" ? payload.label : "Google Drive";
    } catch {
      res.status(400).send("Invalid state.");
      return;
    }
    const refresh = await exchangeCode(code, env.GOOGLE_OAUTH_REDIRECT_URL);
    if (!refresh) {
      res.status(502).send("Google did not return a refresh token. Revoke prior access and retry.");
      return;
    }
    await storeGoogleDest(orgId, label, refresh);
    res.redirect("/configuration/backup?google=connected");
  } catch (err) {
    next(err);
  }
});

// BROKER SERVER: the client redeems a link code for the refresh token,
// server-to-server, authenticated by the shared secret. Single-use.
backupGoogleCallbackRouter.post("/backup/google/broker/redeem", async (req, res, next) => {
  try {
    if (!brokerServerEnabled()) {
      res.status(400).json({ error: { code: "not_a_broker", message: "This instance isn't a backup broker." } });
      return;
    }
    if (req.get("x-broker-secret") !== env.BACKUP_BROKER_SHARED_SECRET) {
      res.status(401).json({ error: { code: "bad_secret", message: "Bad broker secret." } });
      return;
    }
    const code = typeof req.body?.link_code === "string" ? req.body.link_code : "";
    const refresh = code ? takeBrokerLink(code) : null;
    if (!refresh) {
      res.status(410).json({ error: { code: "expired", message: "link code invalid or expired" } });
      return;
    }
    res.json({ refresh_token: refresh });
  } catch (err) {
    next(err);
  }
});

// CLIENT: the broker bounced the browser back here. Verify OUR client_state to
// recover the org, redeem the link code server-to-server at the broker, store.
backupGoogleCallbackRouter.get("/backup/google/broker/return", async (req, res, next) => {
  try {
    if (!brokerClientConfigured()) {
      res.status(400).send("Broker not configured on this instance.");
      return;
    }
    const linkCode = typeof req.query.link_code === "string" ? req.query.link_code : "";
    const clientState = typeof req.query.client_state === "string" ? req.query.client_state : "";
    let orgId: string, label: string;
    try {
      const { payload } = await jwtVerify(clientState, googleSecret(), { issuer: "cobblr", audience: "backup-google-client" });
      orgId = String(payload.org);
      label = typeof payload.label === "string" ? payload.label : "Google Drive";
    } catch {
      res.status(400).send("Invalid state.");
      return;
    }
    const rr = await fetch(`${env.BACKUP_OAUTH_BROKER_URL}/api/v1/backup/google/broker/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-broker-secret": env.BACKUP_BROKER_SHARED_SECRET! },
      body: JSON.stringify({ link_code: linkCode }),
      signal: AbortSignal.timeout(15000),
    });
    const rj = (await rr.json()) as { refresh_token?: string };
    if (!rr.ok || !rj.refresh_token) {
      res.status(502).send("Could not finish the Google connection (broker redeem failed).");
      return;
    }
    await storeGoogleDest(orgId, label, rj.refresh_token);
    res.redirect("/configuration/backup?google=connected");
  } catch (err) {
    next(err);
  }
});
