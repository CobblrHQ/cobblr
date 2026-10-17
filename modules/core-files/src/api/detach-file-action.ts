// Take a file off (core-files:detach-file): the handler its manifest entry names. Wired in ./index.ts.
// The assistant's form of DELETE /attachments/:id: the link goes, the file stays.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreFilesDB } from "../db.js";

export function registerDetachFileAction(): void {
  platform().actions.registerHandler("core-files.detach-file", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const want = typeof ctx.args?.file === "string" ? ctx.args.file.trim() : "";
    if (!want) return { ok: false, error: "Say which file." };
    const [sourceModule, sourceType] = entity.kind.split(":");
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreFilesDB>;
    const on = await db
      .selectFrom("core_files_attachments as a")
      .innerJoin("core_files_files as f", "f.id", "a.file_id")
      .select(["a.id", "a.file_id", "a.role", "f.filename"])
      .where("a.source_module", "=", sourceModule!)
      .where("a.source_type", "=", sourceType!)
      .where("a.source_id", "=", entity.id)
      .execute();
    const named = on.filter((r) => r.file_id === want || r.filename.toLowerCase() === want.toLowerCase());
    if (named.length > 1) return { ok: false, error: `More than one file on it is called "${want}". Say which by its id.` };
    const hit = named[0];
    if (!hit) return on.length ? { ok: false, error: `No file called "${want}" is on it. It has ${on.map((r) => r.filename).join(", ")}.` } : { ok: true, skipped: true, summary: "It has no files on it." };
    const row = await db.deleteFrom("core_files_attachments").where("id", "=", hit.id).returningAll().executeTakeFirst();
    if (!row) return { ok: true, skipped: true, summary: `${hit.filename} was already off.` };
    await platform().events.emit("core-files.attachment.deleted", {
      orgId: ctx.orgId,
      attachmentId: row.id,
      fileId: row.file_id,
      source_module: row.source_module,
      source_type: row.source_type,
      source_id: row.source_id,
      role: row.role,
    });
    return { ok: true, summary: `Took ${hit.filename} off. It is still in Files.`, data: { file_id: hit.file_id, filename: hit.filename } };
  });
  platform().actions.registerUndo("core-files.detach-file", (result, uctx) => {
    const d = (result as { ok?: unknown; skipped?: unknown; data?: { file_id?: string } } | null);
    if (d?.ok !== true || d.skipped || !d.data?.file_id) return null;
    return { action_id: "core-files:attach-file", args: { file: d.data.file_id }, ...(uctx.entity ? { entity_kind: uctx.entity.kind, entity_id: uctx.entity.id } : {}) };
  });
}
