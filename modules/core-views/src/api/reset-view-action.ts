// Put a view back as its bundle made it (core-views:reset-view): the handler its manifest entry names. Wired in ./index.ts.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreViewsDB } from "../db.js";
import { findVisibleView } from "./view-lookup.js";
import { resetViewToBundle, type ViewBefore } from "./reset-bundle-view.js";

export function registerResetViewAction(): void {
  platform().actions.registerHandler("core-views.reset-view", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreViewsDB>;
    const view = await findVisibleView(db, ctx.userId, typeof args.view === "string" ? args.view : "");
    if ("error" in view) return { ok: false, error: view.error };
    const out = await resetViewToBundle(db, view);
    if (!out.ok) return { ok: false, error: out.error };
    if (!out.changed) return { ok: true, skipped: true, summary: `The "${view.name}" view is already as its bundle made it.` };
    await platform().events.emit("core-views.view.updated", { orgId: ctx.orgId, viewId: out.row.id });
    return { ok: true, summary: `The "${out.row.name}" view is back as its bundle made it.`, data: { id: out.row.id, name: out.row.name, before: out.before } };
  });
  platform().actions.registerUndo("core-views.reset-view", (result) => {
    const d = result as { ok?: unknown; data?: { id?: string; before?: ViewBefore } } | null;
    if (d?.ok !== true || !d.data?.id || !d.data.before) return null;
    const b = d.data.before;
    return { action_id: "core-views:edit-view", args: { view: d.data.id, name: b.name, view_type: b.view_type, config: b.config, pinned: b.pinned } };
  });
}
