// Taking a file in: the one path from bytes to a stored file row, for the
// upload route and the zip import alike, so the two cannot disagree about
// what "already here" means, where the bytes go, or what is metered and
// logged.

import { readableFilename } from "./filename.js";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreFilesDB } from "../db.js";
import { removeStoredFile, storeUpload, type FileSourceIn, type Fingerprint, type StoredFile } from "./storage.js";

/** The file already holding these exact bytes (the oldest), if any, with
 *  the names of the folders it sits in (top first; empty at the top level).
 *  The names come with the answer because a caller cannot look them up
 *  itself: a zip can make the folder in the same request, after the page
 *  last read its folder list. */
export async function sameBytes(db: Kysely<CoreFilesDB>, fp: Fingerprint) {
  const row = await db
    .selectFrom("core_files_files")
    .select(["id", "filename", "folder_id", "mime_type", "kind", "width", "height", "created_at", "size_bytes", "variants", "sha256"])
    .where("sha256", "=", fp.sha256)
    .where("size_bytes", "=", String(fp.size))
    .where("deleted_at", "is", null)
    .orderBy("created_at", "asc")
    .executeTakeFirst();
  return row && { ...row, folder_names: await folderNames(db, row.folder_id) };
}

/** A folder's names from the top down ("Blankets", "Baby"); [] for none. */
export async function folderNames(db: Kysely<CoreFilesDB>, folderId: string | null): Promise<string[]> {
  const names: string[] = [];
  const seen = new Set<string>();
  let cur = folderId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = await db.selectFrom("core_files_folders").select(["name", "parent_id"]).where("id", "=", cur).executeTakeFirst();
    if (!f) break;
    names.unshift(f.name);
    cur = f.parent_id;
  }
  return names;
}

export interface Intake {
  /** Bytes in hand, or a file on disk (an upload) moved in without a read. */
  source: FileSourceIn;
  /** The fingerprint, when the caller already has it (the door hashed the
   *  upload as it arrived). */
  fingerprint?: Fingerprint;
  filename: string;
  mime: string;
  folderId: string | null;
}

/** Store the bytes and insert the row; meter, emit and log it. On a failed
 *  insert the stored bytes are removed again. */
export async function intakeFile(db: Kysely<CoreFilesDB>, orgId: string, userId: string | null, f: Intake): Promise<{ row: { id: string; filename: string; mime_type: string; kind: string; width: number | null; height: number | null; created_at: Date; folder_id: string | null }; stored: StoredFile }> {
  const fileId = randomUUID();
  const stored = await storeUpload(orgId, fileId, f.source, f.mime || "application/octet-stream", f.fingerprint);
  try {
    const row = await db
      .insertInto("core_files_files")
      .values({
        id: fileId,
        org_id: orgId,
        owner_user_id: userId,
        filename: readableFilename(f.filename),
        mime_type: stored.mime_type,
        size_bytes: String(stored.size_bytes),
        sha256: stored.sha256,
        variants: stored.variants,
        kind: stored.kind,
        width: stored.width,
        height: stored.height,
        folder_id: f.folderId,
      })
      .returning(["id", "filename", "mime_type", "kind", "width", "height", "created_at", "folder_id"])
      .executeTakeFirstOrThrow();
    // Usage-metering seam: the hosted overlay aggregates stored bytes for
    // plan limits / billing. No-op in open core.
    platform().metering.record({ orgId, kind: "files.bytes_stored", quantity: stored.size_bytes, meta: { fileId: row.id, kind: stored.kind } });
    await platform().events.emit("core-files.file.uploaded", { orgId, fileId: row.id, kind: stored.kind, size_bytes: stored.size_bytes });
    await platform().activity.log({
      orgId,
      userId,
      action: "file_created",
      ref: { module: "core-files", entityType: "file", entityId: row.id },
      diff: { name: row.filename, kind: stored.kind },
    });
    return { row, stored };
  } catch (err) {
    await removeStoredFile(orgId, fileId).catch(() => {});
    throw err;
  }
}

/** The folder at `names` under `parent`, made where missing. A name is one
 *  per level case-insensitively, so "Patterns" and "patterns" are one. */
export async function ensureFolderPath(db: Kysely<CoreFilesDB>, parent: string | null, names: string[], cache: Map<string, string | null>): Promise<string | null> {
  let cur = parent;
  for (const raw of names) {
    const name = raw.trim().slice(0, 120);
    if (!name) continue;
    const key = `${cur ?? ""}/${name.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cur = hit;
      continue;
    }
    const find = () => {
      let q = db.selectFrom("core_files_folders").select("id").where((eb) => eb(eb.fn("lower", [eb.fn("btrim", ["name"])]), "=", name.toLowerCase()));
      q = cur ? q.where("parent_id", "=", cur) : q.where("parent_id", "is", null);
      return q.executeTakeFirst();
    };
    let row = await find();
    if (!row) {
      try {
        row = await db.insertInto("core_files_folders").values({ name, parent_id: cur }).returning("id").executeTakeFirstOrThrow();
      } catch {
        row = await find(); // made meanwhile by another import
      }
    }
    cur = row?.id ?? cur;
    cache.set(key, cur);
  }
  return cur;
}

/** Where a request's file goes: `folder_id` (checked), then `folder_path`
 *  under it ("Patterns/Blankets", made where missing). Null is the top
 *  level; "missing" is a folder_id that no longer exists. */
export async function resolveTarget(db: Kysely<CoreFilesDB>, folderId: string | null, folderPath: string | null): Promise<string | null | "missing"> {
  let base: string | null = null;
  if (folderId) {
    const ok = /^[0-9a-f-]{36}$/i.test(folderId) && (await db.selectFrom("core_files_folders").select("id").where("id", "=", folderId).executeTakeFirst());
    if (!ok) return "missing";
    base = folderId;
  }
  const names = (folderPath ?? "").split("/").map((n) => n.trim()).filter(Boolean);
  return names.length ? ensureFolderPath(db, base, names, new Map()) : base;
}
