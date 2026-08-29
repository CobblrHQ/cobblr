// "Email me my work" — the one thing a sandbox visitor takes with them.
//
// A sandbox is deliberately temporary and says so, and that promise is what
// makes handing out anonymous databases safe. This does not soften it. The
// tenant database is still dropped on the hour by the reaper. What survives is a
// single export, for somebody who asked for one by giving an address; anyone who
// does not ask leaves nothing behind, exactly as the page says.
//
// It is a BACKUP, not a blueprint. A blueprint is a workspace's shape and
// carries no records - which is precisely how the seed shipped a sandbox that
// came up correct and completely empty. Sending a blueprint labelled "your work"
// would repeat that, and hand somebody an empty structure at the one moment they
// care most. Backup is blueprint + data + files, and restores into a fresh
// workspace exactly, which is the same file whether they land on the hosted
// service or their own machine. That is what makes the two paths honest: the
// same export opens either door.
import { randomBytes, createHash } from "node:crypto";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { buildBackupZip } from "../routes/backup.js";

/** A sandbox is an hour of work behind an 8 MB upload ceiling, so a real one is
 *  small. This is the backstop, not the expectation: past it we would rather say
 *  no than quietly store something huge on somebody's behalf. */
export const MAX_EXPORT_BYTES = 25 * 1024 * 1024;

export function exportTtlMs(): number {
  return env.TRY_SANDBOX_EXPORT_DAYS * 86_400_000;
}

/** Same shape as the sandbox link's token: URL-safe, no padding, plenty of
 *  entropy, and only ever stored hashed. */
export function mintExportToken(): { plain: string; hash: string } {
  const plain = randomBytes(24).toString("base64url");
  return { plain, hash: hashExportToken(plain) };
}

export function hashExportToken(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

export type CreateExportResult =
  | { ok: true; token: string; filename: string; sizeBytes: number; expiresAt: Date }
  | { ok: false; reason: "too_large" };

/** Build the workspace's backup and keep it for the window, addressed by a token
 *  that goes out in one email and lives nowhere else. */
export async function createSandboxExport(
  orgId: string,
  slug: string,
  email: string,
  now: number = Date.now(),
): Promise<CreateExportResult> {
  const { buffer, filename } = await buildBackupZip(orgId, slug);
  if (buffer.length > MAX_EXPORT_BYTES) return { ok: false, reason: "too_large" };

  const { plain, hash } = mintExportToken();
  const expiresAt = new Date(now + exportTtlMs());

  // One live export per address: asking twice replaces the first rather than
  // stacking, so a loop cannot fill the table and the newest link is the one
  // that works.
  await meta.deleteFrom("try_sandbox_exports").where("email", "=", email).execute();
  await meta
    .insertInto("try_sandbox_exports")
    .values({
      org_id: orgId,
      email,
      token_hash: hash,
      filename,
      bytes: buffer,
      size_bytes: buffer.length,
      expires_at: expiresAt,
    })
    .execute();

  return { ok: true, token: plain, filename, sizeBytes: buffer.length, expiresAt };
}

export type ExportFetch =
  | { ok: true; bytes: Buffer; filename: string }
  | { ok: false; reason: "unknown" | "expired" };

/** Hand over the file. Deliberately NOT single-use: a link in an email gets
 *  clicked twice, and on a second device, and a download that only works once is
 *  a download that failed for anyone whose connection blinked. */
export async function fetchSandboxExport(plain: string, now: number = Date.now()): Promise<ExportFetch> {
  const row = await meta
    .selectFrom("try_sandbox_exports")
    .select(["id", "bytes", "filename", "expires_at"])
    .where("token_hash", "=", hashExportToken(plain))
    .executeTakeFirst();
  if (!row) return { ok: false, reason: "unknown" };
  if (new Date(row.expires_at).getTime() <= now) return { ok: false, reason: "expired" };

  await meta
    .updateTable("try_sandbox_exports")
    .set((eb) => ({
      first_downloaded_at: eb.fn.coalesce("first_downloaded_at", eb.val(new Date())),
      download_count: eb("download_count", "+", 1),
    }))
    .where("id", "=", row.id)
    .execute()
    .catch(() => {
      /* the counter is telemetry; never fail somebody's download over it */
    });

  return { ok: true, bytes: Buffer.from(row.bytes as unknown as Buffer), filename: row.filename };
}

/** Delete exports whose window has closed. Runs on the sandbox reaper's sweep,
 *  because they are the same promise: this is the only thing that outlives a
 *  sandbox, and it must not outlive it by long. */
export async function reapExpiredExports(now: number = Date.now()): Promise<number> {
  const res = await meta
    .deleteFrom("try_sandbox_exports")
    .where("expires_at", "<", new Date(now))
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0);
}
