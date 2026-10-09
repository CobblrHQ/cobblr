// The backup kept after a workspace set to be deleted is dropped.
//
// CLAUDE.md section 7: a workspace ends with an export, a grace period, then
// the drop. The grace period is the owner's chance to download a backup
// themselves; this is the one taken for them regardless, just before the drop,
// so a deleted workspace is never gone without a copy. reap-deletions.ts takes
// it first and drops the workspace only if it landed: the file written and
// synced, its size checked, and its row in workspace_final_exports.
//
// The zip lives on disk beside the uploaded files, under `_retained/` (a name
// the per-workspace folders, which are uuids, can never take), so it rides the
// same volume and the same off-box copy. Every owner of the workspace at the
// moment it went can download it from their account until `expires_at`
// (COBBLR_WORKSPACE_FINAL_EXPORT_DAYS, default 30); the same sweep then removes
// the file and the row.

import { open, mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { meta } from "../db/meta.js";

export function finalExportDays(env: NodeJS.ProcessEnv = process.env): number {
  const d = Number(env.COBBLR_WORKSPACE_FINAL_EXPORT_DAYS);
  return Number.isFinite(d) && d >= 1 ? d : 30;
}

function retainedRoot(): string {
  if (process.env.COBBLR_RETAINED_ROOT) return resolve(process.env.COBBLR_RETAINED_ROOT);
  return process.env.COBBLR_FILES_ROOT ? join(resolve(process.env.COBBLR_FILES_ROOT), "_retained") : resolve("_retained");
}

export function finalExportPath(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`not an export id: ${id}`);
  return join(retainedRoot(), `${id}.zip`);
}

/** Take and keep the final backup of a workspace. Throws unless the whole of
 *  it landed; the caller must not drop the workspace then. */
export async function takeFinalExport(orgId: string): Promise<{ id: string; size: number }> {
  const org = await meta.selectFrom("orgs").select("slug").where("id", "=", orgId).executeTakeFirstOrThrow();
  // Lazily: the backup route pulls in most of the api, which nothing that only
  // keeps or lists these backups needs.
  const { buildBackupZip } = await import("../routes/backup.js");
  const { buffer, filename } = await buildBackupZip(orgId, org.slug);
  return keepFinalExport(orgId, buffer, filename);
}

/** Keep a workspace's backup: written, synced and size-checked on disk, then
 *  its row, owned by the workspace's owners as they are now. Throws unless all
 *  of it landed. */
export async function keepFinalExport(orgId: string, buffer: Buffer, filename: string): Promise<{ id: string; size: number }> {
  const org = await meta.selectFrom("orgs").select(["name", "slug"]).where("id", "=", orgId).executeTakeFirstOrThrow();
  const owners = await meta
    .selectFrom("org_memberships")
    .select("user_id")
    .where("org_id", "=", orgId)
    .where("role", "=", "owner")
    .execute();
  if (buffer.length === 0) throw new Error(`final backup of ${org.slug} is empty`);

  const id = randomUUID();
  const path = finalExportPath(id);
  await mkdir(retainedRoot(), { recursive: true });
  const part = `${path}.part`;
  const fh = await open(part, "w");
  try {
    await fh.writeFile(buffer);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(part, path);
  const written = (await stat(path)).size;
  if (written !== buffer.length) {
    await rm(path, { force: true });
    throw new Error(`final backup of ${org.slug} wrote ${written} of ${buffer.length} bytes`);
  }
  await meta
    .insertInto("workspace_final_exports")
    .values({
      id,
      org_id: orgId,
      org_name: org.name,
      owner_ids: owners.map((o) => o.user_id),
      filename,
      size_bytes: buffer.length,
      expires_at: new Date(Date.now() + finalExportDays() * 86_400_000),
    })
    .execute();
  return { id, size: buffer.length };
}

/** The kept backups this person may download, newest first. */
export async function finalExportsFor(userId: string) {
  return meta
    .selectFrom("workspace_final_exports")
    .select(["id", "org_name", "filename", "size_bytes", "created_at", "expires_at"])
    .where((eb) => eb(eb.val(userId), "=", eb.fn.any("owner_ids")))
    .where("expires_at", ">", new Date())
    .orderBy("created_at", "desc")
    .execute();
}

/** Remove the backups whose time is up: the file, then the row. */
export async function expireFinalExports(now: Date = new Date()): Promise<number> {
  const due = await meta.selectFrom("workspace_final_exports").select("id").where("expires_at", "<=", now).execute();
  for (const { id } of due) {
    await rm(finalExportPath(id), { force: true });
    await meta.deleteFrom("workspace_final_exports").where("id", "=", id).execute();
  }
  return due.length;
}
