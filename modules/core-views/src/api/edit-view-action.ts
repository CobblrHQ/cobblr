// Change a saved view (core-views:edit-view): the handler its manifest entry names. Wired in ./index.ts.
// The assistant's form of PATCH /views/:id, minus taking a shared view private
// (an owner's or admin's call there) and changing which kind it shows.
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { withArticle } from "@cobblr/platform-contract/plural";
import type { CoreViewsDB } from "../db.js";
import { findVisibleView } from "./view-lookup.js";

const VIEW_TYPES: Record<string, string> = { board: "kanban", kanban: "kanban", calendar: "calendar", timeline: "gantt", gantt: "gantt", table: "table", grid: "table", list: "list" };

export function registerEditViewAction(): void {
  platform().actions.registerHandler("core-views.edit-view", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreViewsDB>;
    const view = await findVisibleView(db, ctx.userId, typeof args.view === "string" ? args.view : "");
    if ("error" in view) return { ok: false, error: view.error };

    const patch: Record<string, unknown> = {};
    if (typeof args.name === "string" && args.name.trim()) patch.name = args.name.trim().slice(0, 160);
    if (typeof args.view_type === "string" && args.view_type.trim()) {
      const t = VIEW_TYPES[args.view_type.trim().toLowerCase()];
      if (!t) return { ok: false, error: `"${args.view_type}" is not a layout. Use table, list, kanban, calendar or gantt.` };
      patch.view_type = t;
    }
    const config = readJsonArg<Record<string, unknown>>(args, "config");
    if (config !== undefined) {
      if (!config || typeof config !== "object" || Array.isArray(config)) return { ok: false, error: "The configuration is an object of columns, grouping and filters." };
      patch.config = config;
    }
    const pinned = args.pinned === true || args.pinned === "true" ? true : args.pinned === false || args.pinned === "false" ? false : undefined;
    if (pinned !== undefined) patch.pinned = pinned;
    if (!Object.keys(patch).length) return { ok: false, error: "Say what to change: its name, layout, configuration or whether it is pinned." };

    const before = { name: view.name, view_type: view.view_type, config: view.config, pinned: view.pinned };
    const row = await db
      .updateTable("core_views_views")
      .set({ ...patch, updated_at: new Date() } as never)
      .where("id", "=", view.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("core-views.view.updated", { orgId: ctx.orgId, viewId: row.id });
    const said = [
      ...(patch.name ? [`renamed to "${row.name}"`] : []),
      ...(patch.view_type ? [`now ${withArticle(row.view_type)}`] : []),
      ...(patch.config ? ["its columns and filters changed"] : []),
      ...(pinned !== undefined ? [pinned ? "pinned to the dashboard" : "unpinned"] : []),
    ];
    return { ok: true, summary: `The "${view.name}" view: ${said.join(", ")}.`, data: { id: row.id, name: row.name, before } };
  });
  platform().actions.registerUndo("core-views.edit-view", (result) => {
    const d = (result as { ok?: unknown; data?: { id?: string; before?: { name: string; view_type: string; config: unknown; pinned: boolean } } } | null);
    if (d?.ok !== true || !d.data?.id || !d.data.before) return null;
    const b = d.data.before;
    return { action_id: "core-views:edit-view", args: { view: d.data.id, name: b.name, view_type: b.view_type, config: b.config, pinned: b.pinned } };
  });
}
