// Save a template (core-templates:save-template): the handler its manifest entry names. Wired in ./index.ts.
// The assistant's form of POST and PATCH /templates: one name per kind, so
// saving under a name that exists changes that template.
import { platform, readJsonArg, readListArg } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { CoreTemplatesDB } from "../db.js";
import { findTemplate, templateKind } from "./template-lookup.js";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function registerSaveTemplateAction(): void {
  platform().actions.registerHandler("core-templates.save-template", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const name = str(args.name).slice(0, 160);
    if (!name) return { ok: false, error: "Say what to call the template." };
    const kind = await templateKind(ctx.orgId, str(args.kind));
    if ("error" in kind) return { ok: false, error: kind.error };
    const values = readJsonArg<Record<string, unknown>>(args, "values");
    if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values))) {
      return { ok: false, error: "The values are field names with what each starts as." };
    }
    const tags = args.tags === undefined ? undefined : readListArg(args, "tags").slice(0, 50);
    const description = args.description === undefined ? undefined : str(args.description).slice(0, 2000) || null;

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreTemplatesDB>;
    const existing = await findTemplate(db, name, kind.id);
    if (existing && "error" in existing) return { ok: false, error: existing.error };
    if (existing) {
      const before = { kind: existing.target_kind, name: existing.name, values: existing.defaults, tags: existing.default_tags, description: existing.description ?? "" };
      const set: Record<string, unknown> = { updated_at: new Date() };
      if (values !== undefined) set.defaults = sql`${JSON.stringify(values)}::jsonb`;
      if (tags !== undefined) set.default_tags = sql`${JSON.stringify(tags)}::jsonb`;
      if (description !== undefined) set.description = description;
      await db.updateTable("core_templates_templates").set(set as never).where("id", "=", existing.id).execute();
      void platform().events.emit("core-templates.template.updated", { orgId: ctx.orgId, templateId: existing.id });
      return { ok: true, summary: `The ${existing.name} template for a new ${kind.words.toLowerCase()} is changed.`, data: { id: existing.id, created: false, before } };
    }
    const row = await db
      .insertInto("core_templates_templates")
      .values({
        target_kind: kind.id,
        name,
        description: description ?? null,
        defaults: sql`${JSON.stringify(values ?? {})}::jsonb` as never,
        default_tags: sql`${JSON.stringify(tags ?? [])}::jsonb` as never,
      })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();
    void platform().events.emit("core-templates.template.created", { orgId: ctx.orgId, templateId: row.id, targetKind: kind.id });
    return { ok: true, summary: `Saved the ${row.name} template for a new ${kind.words.toLowerCase()}.`, data: { id: row.id, kind: kind.id, created: true } };
  });
  // A template this run made is deleted again; one it changed gets its old values back.
  platform().actions.registerUndo("core-templates.save-template", (result) => {
    const d = (result as { ok?: unknown; data?: { id?: string; kind?: string; created?: boolean; before?: Record<string, unknown> } } | null);
    if (d?.ok !== true || !d.data?.id) return null;
    if (d.data.created) return { action_id: "core-templates:delete-template", args: { template: d.data.id } };
    return d.data.before ? { action_id: "core-templates:save-template", args: d.data.before } : null;
  });
}
