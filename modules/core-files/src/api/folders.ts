// /folders — where files live, nested, as a person arranges them (#3753).
//
// A folder is only a place. Nothing here deletes a file: removing a folder
// that still holds files or folders is refused with what it holds, and a
// move that would put a folder inside itself is refused, so tidying can
// never lose anything.

import { Router } from "express";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb, type CoreFilesDB } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const foldersRouter = Router({ mergeParams: true });

const Name = z.string().trim().min(1).max(120);
const CreateBody = z.object({ name: Name, parent_id: z.string().uuid().nullable().optional() });
const PatchBody = z.object({ name: Name.optional(), parent_id: z.string().uuid().nullable().optional() }).refine((b) => b.name !== undefined || b.parent_id !== undefined, "name or parent_id");

const isUnique = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";

/** The folder ids from `id` up to the top, `id` first. */
export async function ancestry(db: Kysely<CoreFilesDB>, id: string): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    with recursive up(id, parent_id, depth) as (
      select id, parent_id, 0 from core_files_folders where id = ${id}
      union all
      select f.id, f.parent_id, up.depth + 1 from core_files_folders f join up on f.id = up.parent_id where up.depth < 64
    )
    select id from up order by depth`.execute(db);
  return rows.rows.map((r) => r.id);
}

foldersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const folders = await db.selectFrom("core_files_folders").select(["id", "parent_id", "name", "created_at"]).orderBy("name").execute();
    const counts = await db
      .selectFrom("core_files_files")
      .select(["folder_id", db.fn.countAll<string>().as("n")])
      .where("deleted_at", "is", null)
      .where("same_as", "is", null)
      .groupBy("folder_id")
      .execute();
    const byFolder = new Map(counts.map((c) => [c.folder_id ?? "", Number(c.n)]));
    res.json({
      items: folders.map((f) => ({ ...f, file_count: byFolder.get(f.id) ?? 0 })),
      top_level_file_count: byFolder.get("") ?? 0,
    });
  }),
);

// AI-REACH: exempt — arranging the Files page by hand; Cobb files a record by moving it (core-files:file update, folder_id)
foldersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const parent = parsed.data.parent_id ?? null;
    if (parent && !(await db.selectFrom("core_files_folders").select("id").where("id", "=", parent).executeTakeFirst())) {
      res.status(404).json({ error: { code: "parent_not_found", message: "That folder does not exist any more." } });
      return;
    }
    try {
      const row = await db
        .insertInto("core_files_folders")
        .values({ name: parsed.data.name, parent_id: parent })
        .returning(["id", "parent_id", "name", "created_at"])
        .executeTakeFirstOrThrow();
      await platform().activity.log({
        orgId: tenantContext(req).org.id,
        userId: sessionUser(req)?.id ?? null,
        action: "folder_created",
        ref: { module: "core-files", entityType: "folder", entityId: row.id },
        diff: { name: row.name },
      });
      res.status(201).json({ ...row, file_count: 0 });
    } catch (err) {
      if (isUnique(err)) {
        res.status(409).json({ error: { code: "name_taken", message: `There is already a folder called "${parsed.data.name}" here.` } });
        return;
      }
      throw err;
    }
  }),
);

// AI-REACH: exempt — arranging the Files page by hand; Cobb files a record by moving it (core-files:file update, folder_id)
foldersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const id = req.params.id!;
    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    await tenantDb(req).transaction().execute(async (db) => {
      const current = await db.selectFrom("core_files_folders").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
      if (!current) {
        res.status(404).json({ error: { code: "not_found", message: "folder not found" } });
        return;
      }
      if (await platform().http.refuseStaleEdit(req, res, id, current)) return;
      const parent = parsed.data.parent_id;
      if (parent) {
        const up = await ancestry(db, parent);
        if (up.length === 0) {
          res.status(404).json({ error: { code: "parent_not_found", message: "That folder does not exist any more." } });
          return;
        }
        if (up.includes(id)) {
          res.status(409).json({ error: { code: "into_itself", message: "A folder cannot go inside itself or one of its own folders." } });
          return;
        }
      }
      try {
        const row = await db
          .updateTable("core_files_folders")
          .set({ ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}), ...(parent !== undefined ? { parent_id: parent } : {}) })
          .where("id", "=", id)
          .returning(["id", "parent_id", "name", "created_at"])
          .executeTakeFirstOrThrow();
        res.json(row);
      } catch (err) {
        if (isUnique(err)) {
          res.status(409).json({ error: { code: "name_taken", message: `There is already a folder called "${parsed.data.name ?? current.name}" there.` } });
          return;
        }
        throw err;
      }
    });
  }),
);

// AI-REACH: exempt — arranging the Files page by hand; Cobb files a record by moving it (core-files:file update, folder_id)
foldersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "editor", "member")) return;
    const id = req.params.id!;
    const db = tenantDb(req);
    const [files, children] = await Promise.all([
      db.selectFrom("core_files_files").select(db.fn.countAll<string>().as("n")).where("folder_id", "=", id).where("deleted_at", "is", null).executeTakeFirst(),
      db.selectFrom("core_files_folders").select(db.fn.countAll<string>().as("n")).where("parent_id", "=", id).executeTakeFirst(),
    ]);
    const nFiles = Number(files?.n ?? 0);
    const nFolders = Number(children?.n ?? 0);
    if (nFiles > 0 || nFolders > 0) {
      const what = [nFiles ? `${nFiles} file${nFiles === 1 ? "" : "s"}` : "", nFolders ? `${nFolders} folder${nFolders === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
      res.status(409).json({ error: { code: "not_empty", message: `This folder still holds ${what}. Move them out first.`, files: nFiles, folders: nFolders } });
      return;
    }
    const gone = await db.deleteFrom("core_files_folders").where("id", "=", id).returning("name").executeTakeFirst();
    if (!gone) {
      res.status(404).json({ error: { code: "not_found", message: "folder not found" } });
      return;
    }
    await platform().activity.log({
      orgId: tenantContext(req).org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "folder_deleted",
      ref: { module: "core-files", entityType: "folder", entityId: id },
      diff: { name: gone.name },
    });
    res.status(204).end();
  }),
);
