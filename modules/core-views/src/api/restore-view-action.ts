// Put a removed view back (core-views:restore-view): the handler its manifest entry names. Wired in ./index.ts.
// The way back for delete-view: the row as it was, same id and same owner, so
// a private view comes back private and a dashboard pin comes back pinned.
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreViewsDB } from "../db.js";
import type { ViewRow } from "./view-lookup.js";

export function registerRestoreViewAction(): void {
  platform().actions.registerHandler("core-views.restore-view", async (ctx) => {
    const v = readJsonArg<Partial<ViewRow>>(ctx.args, "view");
    if (!v?.id || !v.entity_kind || !v.name || !v.view_type) return { ok: false, error: "missing the view to put back" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreViewsDB>;
    const row = await db
      .insertInto("core_views_views")
      .values({
        id: v.id,
        entity_kind: v.entity_kind,
        name: v.name,
        view_type: v.view_type,
        config: (v.config ?? {}) as never,
        is_default: !!v.is_default,
        pinned: !!v.pinned,
        owner_user_id: v.owner_user_id ?? null,
        bundle_id: v.bundle_id ?? null,
        source_module: v.source_module ?? null,
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!row) return { ok: true, skipped: true, summary: `The ${v.name} view is already there.` };
    await platform().events.emit("core-views.view.created", { orgId: ctx.orgId, viewId: row.id, entity_kind: v.entity_kind, view_type: v.view_type });
    return { ok: true, summary: `The ${row.name} view is back.`, data: { id: row.id } };
  });
}
