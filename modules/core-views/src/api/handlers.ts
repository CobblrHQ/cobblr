// core-views:save-view — the AI-reachable form of POST /views.
//
// Saved views were unreachable for the same reason the rest of the workspace's
// setup was: a view is not a record, so "declare your entity kinds" never
// applied to core-views (it declares none). Reading them is get_workspace_setup;
// CREATING one is this, a workspace-scoped action, so it rides invoke_action and
// inherits the confirm gate, the permission check and the change ledger rather
// than needing a bespoke write tool per setting. Pattern: labels:set-code.
//
// Shares ViewCreate with the HTTP route, so what counts as a valid view cannot
// mean one thing when a person saves one and another when the assistant does.

import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import { ViewCreate } from "./views.js";
import type { CoreViewsDB } from "../db.js";

/** The renderers core-views ships. A model asked for "a board" means kanban and
 *  "a timeline" means gantt; mapping the words it actually uses is cheaper than
 *  bouncing the proposal back to the user over a vocabulary mismatch. */
const VIEW_TYPE_WORDS: Record<string, string> = {
  board: "kanban",
  kanban: "kanban",
  calendar: "calendar",
  timeline: "gantt",
  gantt: "gantt",
  table: "table",
  grid: "table",
  list: "list",
};

export function registerViewsHandlers(): void {
  platform().actions.registerHandler("core-views.save-view", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const wantedType =
      typeof args.view_type === "string" ? args.view_type.trim().toLowerCase() : "";
    const viewType = VIEW_TYPE_WORDS[wantedType];
    if (!viewType) {
      return {
        ok: false,
        error: `"${wantedType || "(none)"}" is not a view type — use one of: table, list, kanban, calendar, gantt`,
      };
    }
    const parsed = ViewCreate.safeParse({
      entity_kind: typeof args.entity_kind === "string" ? args.entity_kind.trim() : "",
      name: typeof args.name === "string" ? args.name.trim() : "",
      view_type: viewType,
      // readJsonArg, not a typeof check: the same `config` arrives as an
      // object from invoke_action and as JSON text from a wire's arg field,
      // and the typeof check silently discarded the second.
      ...(() => {
        const config = readJsonArg<Record<string, unknown>>(args, "config");
        return config && typeof config === "object" ? { config } : {};
      })(),
      ...(typeof args.pinned === "boolean" ? { pinned: args.pinned } : {}),
      // A view made on request is for the workspace, not squirrelled away as the
      // private view of whoever happened to be talking to the assistant.
      shared: true,
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }

    // The kind has to exist, or the view saves fine and then shows nothing —
    // a failure the user only discovers when they open it.
    const kinds = await platform().entities.listKindsForOrg(ctx.orgId);
    if (!kinds.some((k) => k.id === parsed.data.entity_kind)) {
      return {
        ok: false,
        error: `this workspace has no "${parsed.data.entity_kind}" to build a view of — check the record kinds first`,
      };
    }

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreViewsDB>;
    const row = await db
      .insertInto("core_views_views")
      .values({
        entity_kind: parsed.data.entity_kind,
        name: parsed.data.name,
        view_type: parsed.data.view_type,
        config: parsed.data.config ?? {},
        is_default: false,
        pinned: parsed.data.pinned ?? false,
        owner_user_id: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await platform().events.emit("core-views.view.created", {
      orgId: ctx.orgId,
      viewId: row.id,
      entity_kind: row.entity_kind,
      view_type: row.view_type,
    });

    return {
      ok: true,
      summary: `"${row.name}" saved as a ${row.view_type} view of ${row.entity_kind}${row.pinned ? ", pinned to the dashboard" : ""}`,
      data: { id: row.id, name: row.name, entity_kind: row.entity_kind, view_type: row.view_type },
    };
  });
}
