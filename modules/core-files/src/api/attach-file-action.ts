// Attach a file (core-files:attach-file): the handler its manifest entry names. Wired in ./index.ts.
// The assistant's form of POST /attachments, for a file already in Files.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { CoreFilesDB } from "../db.js";

export function registerAttachFileAction(): void {
  platform().actions.registerHandler("core-files.attach-file", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const want = typeof ctx.args?.file === "string" ? ctx.args.file.trim() : "";
    if (!want) return { ok: false, error: "Say which file." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreFilesDB>;
    const live = db.selectFrom("core_files_files").select(["id", "filename"]).where("deleted_at", "is", null).where("same_as", "is", null);
    const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(want);
    const byId = isId ? await live.where("id", "=", want).executeTakeFirst() : undefined;
    const named = byId ? [byId] : await live.where((eb) => eb(eb.fn("lower", ["filename"]), "=", want.toLowerCase())).execute();
    if (named.length > 1) return { ok: false, error: `More than one file is called "${want}". Say which by its id.` };
    const file = named[0];
    if (!file) return { ok: false, error: `There is no file called "${want}" in Files.` };
    const [sourceModule, sourceType] = entity.kind.split(":");
    // The table's key counts a NULL role as distinct, so it cannot refuse a
    // second link of the same file; the lock makes the look and the write one
    // step, so two presses at once still leave one link.
    const row = await db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`core-files.attach:${file.id}:${entity.id}`}))`.execute(trx);
      const had = await trx
        .selectFrom("core_files_attachments")
        .select("id")
        .where("file_id", "=", file.id)
        .where("source_module", "=", sourceModule!)
        .where("source_type", "=", sourceType!)
        .where("source_id", "=", entity.id)
        .where("role", "is", null)
        .executeTakeFirst();
      if (had) return null;
      return trx
        .insertInto("core_files_attachments")
        .values({ file_id: file.id, source_module: sourceModule!, source_type: sourceType!, source_id: entity.id, role: null, sort_order: 0 })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    if (!row) return { ok: true, skipped: true, summary: `${file.filename} is already on it.` };
    await platform().events.emit("core-files.attachment.created", {
      orgId: ctx.orgId,
      attachmentId: row.id,
      fileId: row.file_id,
      source_module: row.source_module,
      source_type: row.source_type,
      source_id: row.source_id,
      role: row.role,
    });
    return { ok: true, summary: `Attached ${file.filename}.`, data: { file_id: file.id, filename: file.filename } };
  });
  platform().actions.registerUndo("core-files.attach-file", (result, uctx) => {
    const d = (result as { ok?: unknown; skipped?: unknown; data?: { file_id?: string } } | null);
    if (d?.ok !== true || d.skipped || !d.data?.file_id) return null;
    return { action_id: "core-files:detach-file", args: { file: d.data.file_id }, ...(uctx.entity ? { entity_kind: uctx.entity.kind, entity_id: uctx.entity.id } : {}) };
  });
}
