// Delete a template (core-templates:delete-template): the handler its manifest entry names. Wired in ./index.ts.
// The same delete as on /configuration/templates (DELETE /templates/:id); the
// records made from it are untouched.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreTemplatesDB } from "../db.js";
import { findTemplate, templateKind } from "./template-lookup.js";

export function registerDeleteTemplateAction(): void {
  platform().actions.registerHandler("core-templates.delete-template", async (ctx) => {
    const name = typeof ctx.args?.template === "string" ? ctx.args.template.trim() : "";
    if (!name) return { ok: false, error: "Say which template." };
    let kindId: string | undefined;
    if (typeof ctx.args?.kind === "string" && ctx.args.kind.trim()) {
      const kind = await templateKind(ctx.orgId, ctx.args.kind);
      if ("error" in kind) return { ok: false, error: kind.error };
      kindId = kind.id;
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreTemplatesDB>;
    const t = await findTemplate(db, name, kindId);
    if (t && "error" in t) return { ok: false, error: t.error };
    if (!t) return { ok: true, skipped: true, summary: `There is no template called "${name}".` };
    await db.deleteFrom("core_templates_templates").where("id", "=", t.id).execute();
    void platform().events.emit("core-templates.template.deleted", { orgId: ctx.orgId, templateId: t.id });
    return { ok: true, summary: `Deleted the ${t.name} template. Records made from it are unchanged.`, data: { id: t.id } };
  });
}
