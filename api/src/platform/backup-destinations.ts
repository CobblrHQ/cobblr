// Backup destinations — Phase C of Blueprint/Backup/Export. Where a workspace's
// backups GO: a pluggable driver (filesystem / Google Drive / …) + config +
// encrypted credentials + a schedule. The cron builds a backup and pushes it
// through the driver; "Back up now" runs one immediately.
//
// Mirrors the digifab MachineDriver / FarmConnection pattern: a small driver
// interface + a registry. Credentials are AES-GCM at rest (encryptCredentials,
// per-org key) and never leave the server.
//
// Drivers shipped:
//   • filesystem  — write the zip to a server path (a NAS bind-mount, etc.).
//                   Verifiable; the default for self-hosters.
//   • google_drive — resumable upload to the user's Drive. Built here, but only
//                   AVAILABLE when GOOGLE_OAUTH_CLIENT_ID/SECRET are set (the
//                   operator registers a Google Cloud OAuth app); the OAuth
//                   connect flow lives in routes/backup.ts.

import { writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { AwsClient } from "aws4fetch";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { encryptCredentials, decryptCredentials } from "./integrations.js";
import { buildBackupZip } from "../routes/backup.js";
import { isRedundantScheduledRun } from "./backup-schedule.js";
import * as queue from "./queue.js";

// ── Driver seam ──────────────────────────────────────────────────────
export interface BackupPutArgs {
  orgId: string;
  filename: string;
  bytes: Buffer;
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
}
/** One backup that actually exists in the destination — what the UI lists so a
 *  user can SEE their backups, not just "last: ok". */
export interface BackupEntry {
  name: string;
  size: number | null;
  created_at: string | null;
  ref: string;
}
export interface BackupDestinationDriver {
  id: string;
  label: string;
  /** False when the driver needs operator setup that's missing (e.g. Google
   *  OAuth app env). Unavailable drivers are hidden from the create UI. */
  available(): boolean;
  /** Config fields the UI collects (path, folder id, …). A field marked
   *  `secret` is routed into the ENCRYPTED credentials, never plaintext config. */
  configFields(): Array<{ key: string; label: string; required: boolean; placeholder?: string; secret?: boolean }>;
  /** Push one backup. Returns an opaque ref (path / file id) for logging. */
  put(args: BackupPutArgs): Promise<{ ref: string }>;
  /** Optional: delete all but the newest `retention` backups. */
  prune?(args: { config: Record<string, unknown>; credentials: Record<string, unknown>; orgId: string; retention: number }): Promise<void>;
  /** Optional: the backups that currently exist in the destination, newest
   *  first. Powers the "your backups in <destination>" list. */
  list?(args: { config: Record<string, unknown>; credentials: Record<string, unknown>; orgId: string }): Promise<BackupEntry[]>;
}

const registry = new Map<string, BackupDestinationDriver>();
export function registerBackupDriver(d: BackupDestinationDriver): void {
  registry.set(d.id, d);
}
export function getBackupDriver(id: string): BackupDestinationDriver | undefined {
  return registry.get(id);
}
export function listBackupDrivers(): Array<{ id: string; label: string; available: boolean; configFields: ReturnType<BackupDestinationDriver["configFields"]> }> {
  return [...registry.values()].map((d) => ({ id: d.id, label: d.label, available: d.available(), configFields: d.configFields() }));
}

// ── filesystem driver ────────────────────────────────────────────────
// Writes under BACKUP_FS_ROOT/<org>/<subdir>. The subdir comes from config but
// is sanitised (no traversal) and always rooted at BACKUP_FS_ROOT — a workspace
// owner can't write arbitrary server paths.
const FS_ROOT = env.BACKUP_FS_ROOT || "/files/backups";
function safeSub(sub: unknown): string {
  const s = typeof sub === "string" ? sub : "";
  // Strip anything but a simple relative folder name.
  return s.replace(/\.\./g, "").replace(/^[/\\]+/, "").replace(/[^A-Za-z0-9_\-/]/g, "_");
}
function fsDirFor(orgId: string, config: Record<string, unknown>): string {
  const dir = resolve(FS_ROOT, orgId, safeSub(config.subdir));
  // Defence in depth: never escape FS_ROOT.
  if (!resolve(dir).startsWith(resolve(FS_ROOT) + sep) && resolve(dir) !== resolve(FS_ROOT)) {
    throw new Error("destination path escapes the backup root");
  }
  return dir;
}
registerBackupDriver({
  id: "filesystem",
  label: "Server path / NAS",
  available: () => true,
  configFields: () => [{ key: "subdir", label: "Sub-folder", required: false, placeholder: "e.g. nightly (optional)" }],
  async put({ orgId, filename, bytes, config }) {
    const dir = fsDirFor(orgId, config);
    await mkdir(dir, { recursive: true });
    const full = join(dir, filename);
    await writeFile(full, bytes);
    return { ref: full };
  },
  async prune({ orgId, config, retention }) {
    const dir = fsDirFor(orgId, config);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".zip"));
    } catch {
      return;
    }
    const withTime = await Promise.all(
      names.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })),
    );
    withTime.sort((a, b) => b.t - a.t);
    for (const old of withTime.slice(Math.max(1, retention))) {
      await unlink(join(dir, old.n)).catch(() => {});
    }
  },
  async list({ orgId, config }) {
    const dir = fsDirFor(orgId, config);
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: BackupEntry[] = [];
    for (const name of names.filter((n) => n.endsWith(".zip"))) {
      const st = await stat(join(dir, name)).catch(() => null);
      out.push({
        name,
        size: st?.size ?? null,
        created_at: st ? new Date(st.mtimeMs).toISOString() : null,
        ref: join(dir, name),
      });
    }
    out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return out;
  },
});

// ── google_drive driver ──────────────────────────────────────────────
// Resumable-less simple upload (multipart) to Drive v3. Credentials carry a
// long-lived refresh_token (obtained via the OAuth connect flow); we exchange it
// for a short-lived access token per push. Only AVAILABLE when the operator has
// configured a Google OAuth app. NOT live-verified in this change (no creds in
// the test env) — built against the documented Drive v3 API.
export const GOOGLE_AUTH_URL = (): string => env.GOOGLE_OAUTH_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = (): string => env.GOOGLE_OAUTH_TOKEN_URL || "https://oauth2.googleapis.com/token";

/** This instance has its OWN Google app (direct connect + can act as a broker). */
export function googleDriveConfigured(): boolean {
  return !!env.GOOGLE_OAUTH_CLIENT_ID && !!env.GOOGLE_OAUTH_CLIENT_SECRET;
}
/** This instance points at a broker for the connect (no local Google app needed). */
export function brokerClientConfigured(): boolean {
  return !!env.BACKUP_OAUTH_BROKER_URL && !!env.BACKUP_BROKER_SHARED_SECRET;
}
/** This instance will broker for OTHERS (has a Google app + a shared secret). */
export function brokerServerEnabled(): boolean {
  return googleDriveConfigured() && !!env.BACKUP_BROKER_SHARED_SECRET;
}
/** Either path gives the user a working "Connect Google Drive". */
export function googleDriveUsable(): boolean {
  return googleDriveConfigured() || brokerClientConfigured();
}
async function googleAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const j = (await res.json()) as { access_token?: string };
  if (!j.access_token) throw new Error("Google token exchange returned no access_token");
  return j.access_token;
}
registerBackupDriver({
  id: "google_drive",
  label: "Google Drive",
  available: () => googleDriveUsable(),
  configFields: () => [{ key: "folder_id", label: "Drive folder ID", required: false, placeholder: "optional — defaults to a Cobblr Backups folder" }],
  async put({ filename, bytes, config, credentials }) {
    const refresh = typeof credentials.refresh_token === "string" ? credentials.refresh_token : "";
    if (!refresh) throw new Error("Google Drive not connected (no refresh token)");
    const accessToken = await googleAccessToken(refresh);
    const metadata: Record<string, unknown> = { name: filename };
    if (typeof config.folder_id === "string" && config.folder_id) metadata.parents = [config.folder_id];
    // Multipart upload (one round trip; fine for personal-scale backups).
    const boundary = "cobblrbackup" + bytes.length.toString(36);
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = Buffer.concat([Buffer.from(head, "utf8"), bytes, Buffer.from(tail, "utf8")]);
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/related; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`Drive upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { id?: string };
    return { ref: j.id ?? "uploaded" };
  },
  async list({ config, credentials }) {
    const refresh = typeof credentials.refresh_token === "string" ? credentials.refresh_token : "";
    if (!refresh) return [];
    const accessToken = await googleAccessToken(refresh);
    const folder = typeof config.folder_id === "string" && config.folder_id ? config.folder_id : null;
    // Scope to the backup folder when one is set; otherwise the files sit in My
    // Drive root, so filter by the backup name shape (backup-<slug>-<stamp>.zip)
    // to avoid listing the user's whole Drive.
    const q = [folder ? `'${folder}' in parents` : null, "trashed = false"].filter(Boolean).join(" and ");
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
      `&orderBy=createdTime desc&pageSize=100&fields=${encodeURIComponent("files(id,name,size,createdTime)")}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
    const j = (await res.json()) as {
      files?: Array<{ id?: string; name?: string; size?: string; createdTime?: string }>;
    };
    return (j.files ?? [])
      .filter((f) => /^backup-.*\.zip$/.test(f.name ?? ""))
      .map((f) => ({
        name: f.name ?? "(unnamed)",
        size: f.size ? Number(f.size) : null,
        created_at: f.createdTime ?? null,
        ref: f.id ?? "",
      }));
  },
  async prune({ config, credentials, retention }) {
    // Drive had NO prune, so backups piled up forever (the author saw 100+). Keep the
    // newest `retention`, delete the rest. Scoped to backup-*.zip so we never
    // touch anything else in the folder / My Drive.
    const refresh = typeof credentials.refresh_token === "string" ? credentials.refresh_token : "";
    if (!refresh) return;
    const accessToken = await googleAccessToken(refresh);
    const folder = typeof config.folder_id === "string" && config.folder_id ? config.folder_id : null;
    const q = [folder ? `'${folder}' in parents` : null, "trashed = false"].filter(Boolean).join(" and ");
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
      `&orderBy=createdTime desc&pageSize=1000&fields=${encodeURIComponent("files(id,name,createdTime)")}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return;
    const files = ((await res.json()) as { files?: Array<{ id?: string; name?: string }> }).files ?? [];
    const backups = files.filter((f) => /^backup-.*\.zip$/.test(f.name ?? "") && f.id);
    const toDelete = backups.slice(Math.max(1, retention));
    // Delete in parallel batches, not one-at-a-time: a big backlog (the author hit 1500+
    // because Drive never pruned before) took 10+ minutes sequentially and got
    // killed before finishing. Batches of 15 clear even a large backlog in seconds.
    const CONCURRENCY = 15;
    for (let i = 0; i < toDelete.length; i += CONCURRENCY) {
      await Promise.all(
        toDelete.slice(i, i + CONCURRENCY).map((old) =>
          fetch(`https://www.googleapis.com/drive/v3/files/${old.id}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(30000),
          }).catch(() => {}),
        ),
      );
    }
  },
});

// ── S3-compatible driver ─────────────────────────────────────────────
// AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, … — anything that speaks
// the S3 API. Signed with AWS Sig V4 via aws4fetch (tiny, no AWS SDK). Path-style
// addressing (`<endpoint>/<bucket>/<key>`) for max compatibility (MinIO/R2/B2).
// Credentials = access key + secret (no OAuth) → no broker needed; the driver is
// always "available", the user supplies creds + bucket at create time.
function s3Client(creds: Record<string, unknown>, region: string): AwsClient {
  return new AwsClient({
    accessKeyId: String(creds.access_key_id ?? ""),
    secretAccessKey: String(creds.secret_access_key ?? ""),
    region,
    service: "s3",
  });
}
function s3Endpoint(config: Record<string, unknown>, region: string): string {
  const ep = typeof config.endpoint === "string" && config.endpoint ? config.endpoint : `https://s3.${region}.amazonaws.com`;
  return ep.replace(/\/+$/, "");
}
function s3Prefix(config: Record<string, unknown>): string {
  const p = typeof config.prefix === "string" ? config.prefix.replace(/^\/+/, "") : "";
  return p && !p.endsWith("/") ? p + "/" : p;
}
registerBackupDriver({
  id: "s3",
  label: "S3 / R2 / Backblaze / MinIO",
  available: () => true,
  configFields: () => [
    { key: "bucket", label: "Bucket", required: true, placeholder: "my-cobblr-backups" },
    { key: "region", label: "Region", required: false, placeholder: "us-east-1" },
    { key: "endpoint", label: "Endpoint URL", required: false, placeholder: "blank for AWS; e.g. https://<acct>.r2.cloudflarestorage.com" },
    { key: "prefix", label: "Key prefix", required: false, placeholder: "optional folder, e.g. backups/" },
    { key: "access_key_id", label: "Access key ID", required: true, secret: true },
    { key: "secret_access_key", label: "Secret access key", required: true, secret: true },
  ],
  async put({ filename, bytes, config, credentials }) {
    // Creds may be supplied as config fields (the generic create form) or as the
    // encrypted credentials blob — accept either, prefer the encrypted ones.
    const creds = {
      access_key_id: credentials.access_key_id ?? config.access_key_id,
      secret_access_key: credentials.secret_access_key ?? config.secret_access_key,
    };
    const region = String(config.region || "us-east-1");
    const bucket = String(config.bucket || "");
    if (!bucket) throw new Error("S3 destination missing a bucket");
    const key = s3Prefix(config) + filename;
    const aws = s3Client(creds, region);
    const res = await aws.fetch(`${s3Endpoint(config, region)}/${bucket}/${encodeURI(key)}`, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "application/zip" },
    });
    if (!res.ok) throw new Error(`S3 upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return { ref: `${bucket}/${key}` };
  },
  async prune({ config, credentials, retention }) {
    const creds = {
      access_key_id: credentials.access_key_id ?? config.access_key_id,
      secret_access_key: credentials.secret_access_key ?? config.secret_access_key,
    };
    const region = String(config.region || "us-east-1");
    const bucket = String(config.bucket || "");
    const prefix = s3Prefix(config);
    if (!bucket) return;
    const aws = s3Client(creds, region);
    const base = `${s3Endpoint(config, region)}/${bucket}`;
    const listRes = await aws.fetch(`${base}?list-type=2&prefix=${encodeURIComponent(prefix)}`);
    if (!listRes.ok) return;
    const xml = await listRes.text();
    // Minimal ListObjectsV2 parse — pull (Key, LastModified) per <Contents>.
    const objs: Array<{ key: string; t: number }> = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = m[1]!;
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
      const lm = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(body)?.[1];
      if (key && key.endsWith(".zip")) objs.push({ key, t: lm ? Date.parse(lm) : 0 });
    }
    objs.sort((a, b) => b.t - a.t);
    for (const old of objs.slice(Math.max(1, retention))) {
      await aws.fetch(`${base}/${encodeURI(old.key)}`, { method: "DELETE" }).catch(() => {});
    }
  },
  async list({ config, credentials }) {
    const creds = {
      access_key_id: credentials.access_key_id ?? config.access_key_id,
      secret_access_key: credentials.secret_access_key ?? config.secret_access_key,
    };
    const region = String(config.region || "us-east-1");
    const bucket = String(config.bucket || "");
    const prefix = s3Prefix(config);
    if (!bucket) return [];
    const aws = s3Client(creds, region);
    const base = `${s3Endpoint(config, region)}/${bucket}`;
    const listRes = await aws.fetch(`${base}?list-type=2&prefix=${encodeURIComponent(prefix)}`);
    if (!listRes.ok) throw new Error(`S3 list failed (${listRes.status})`);
    const xml = await listRes.text();
    const out: BackupEntry[] = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const b = m[1]!;
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(b)?.[1];
      const size = /<Size>([\s\S]*?)<\/Size>/.exec(b)?.[1];
      const lm = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(b)?.[1];
      if (key && key.endsWith(".zip"))
        out.push({ name: key.split("/").pop() ?? key, size: size ? Number(size) : null, created_at: lm ?? null, ref: `${bucket}/${key}` });
    }
    out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return out;
  },
});

// ── list the backups that actually exist in a destination ────────────
export async function listDestinationBackups(destId: string, orgId: string): Promise<BackupEntry[]> {
  const dest = await meta
    .selectFrom("backup_destinations")
    .selectAll()
    .where("id", "=", destId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  if (!dest) throw new Error("destination not found");
  const driver = getBackupDriver(dest.driver);
  if (!driver?.list) return [];
  const credentials = dest.credentials_enc ? await decryptCredentials(dest.org_id, dest.credentials_enc) : {};
  return driver.list({ orgId: dest.org_id, config: dest.config, credentials });
}

// ── schedule helpers ─────────────────────────────────────────────────
export function nextRunFrom(schedule: string, from: Date): Date | null {
  if (schedule === "daily") return new Date(from.getTime() + 24 * 3600 * 1000);
  if (schedule === "weekly") return new Date(from.getTime() + 7 * 24 * 3600 * 1000);
  return null;
}

// ── run one destination (build → push → prune → record) ──────────────
const QUEUE = "backup-destination";

export async function runDestination(destId: string, now: Date): Promise<{ ok: boolean; ref?: string; error?: string }> {
  const dest = await meta.selectFrom("backup_destinations").selectAll().where("id", "=", destId).executeTakeFirst();
  if (!dest) return { ok: false, error: "destination not found" };
  const org = await meta.selectFrom("orgs").select(["id", "slug"]).where("id", "=", dest.org_id).executeTakeFirst();
  if (!org) return { ok: false, error: "org not found" };
  const driver = getBackupDriver(dest.driver);
  if (!driver || !driver.available()) return { ok: false, error: `driver '${dest.driver}' unavailable` };
  try {
    const credentials = dest.credentials_enc ? await decryptCredentials(dest.org_id, dest.credentials_enc) : {};
    const { buffer, filename } = await buildBackupZip(org.id, org.slug);
    const { ref } = await driver.put({ orgId: org.id, filename, bytes: buffer, config: dest.config, credentials });
    // Record success the moment the backup is safely uploaded — pruning is
    // cleanup and must NOT gate the run record. A large first-run backlog made
    // prune take many minutes; if the process was recycled mid-prune, the whole
    // run (and the schedule advance) was silently lost. Mark ok now, prune after.
    await meta
      .updateTable("backup_destinations")
      .set({ last_run_at: now, last_status: "ok", updated_at: now })
      .where("id", "=", destId)
      .execute();
    if (driver.prune)
      await driver
        .prune({ orgId: org.id, config: dest.config, credentials, retention: dest.retention })
        .catch((e) => console.warn(`[backup] prune failed for ${destId}:`, (e as Error).message));
    return { ok: true, ref };
  } catch (err) {
    await meta
      .updateTable("backup_destinations")
      .set({ last_run_at: now, last_status: (err as Error).message.slice(0, 300), updated_at: now })
      .where("id", "=", destId)
      .execute();
    return { ok: false, error: (err as Error).message };
  }
}

// ── cron: a self-rescheduling per-destination job ────────────────────
export function registerBackupCron(): void {
  queue.registerWorker(QUEUE, async (job) => {
    const destId = String((job.payload as { destinationId?: unknown }).destinationId ?? "");
    if (!destId) return;
    const dest = await meta
      .selectFrom("backup_destinations")
      .select(["id", "enabled", "schedule", "last_run_at"])
      .where("id", "=", destId)
      .executeTakeFirst();
    if (!dest || !dest.enabled || dest.schedule === "off") return; // descheduled
    const now = new Date();
    // De-dupe redundant ticks. `seedBackupSchedules` re-enqueues a tick on every
    // boot when next_run_at is past, and a blue-green deploy briefly runs two api
    // containers that both process the queue — so a deploy used to fire several
    // backups minutes apart (the author saw 100). If a backup already ran within most of
    // this schedule's interval, this tick is a duplicate: skip the run, but still
    // reschedule the next so the cadence continues.
    const ranRecently = isRedundantScheduledRun(dest.schedule, dest.last_run_at ? new Date(dest.last_run_at) : null, now);
    if (!ranRecently) await runDestination(destId, now);
    const next = nextRunFrom(dest.schedule, now);
    if (next) {
      await meta.updateTable("backup_destinations").set({ next_run_at: next }).where("id", "=", destId).execute();
      await queue.enqueue({ orgId: (await meta.selectFrom("backup_destinations").select("org_id").where("id", "=", destId).executeTakeFirstOrThrow()).org_id, queue: QUEUE, payload: { destinationId: destId }, runAt: next });
    }
  });
}

/** Boot: ensure every enabled, scheduled destination has a pending tick. Idempotent
 *  enough — a duplicate tick just runs a backup early then reschedules. */
export async function seedBackupSchedules(): Promise<void> {
  const due = await meta
    .selectFrom("backup_destinations")
    .select(["id", "org_id", "schedule", "next_run_at"])
    .where("enabled", "=", true)
    .where("schedule", "<>", "off")
    .execute();
  const now = new Date();
  for (const d of due) {
    const runAt = d.next_run_at && d.next_run_at > now ? d.next_run_at : now;
    await queue.enqueue({ orgId: d.org_id, queue: QUEUE, payload: { destinationId: d.id }, runAt }).catch(() => {});
  }
}

export async function encryptDestCredentials(orgId: string, creds: Record<string, unknown>): Promise<string> {
  return encryptCredentials(orgId, creds);
}
