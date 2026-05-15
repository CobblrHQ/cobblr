// Action handlers + entity-kind resolvers. Registered at module
// load via api/index.ts's side-effect call.
//
// Replaces the old hardcoded inventory.stock.changed subscriber.
// The platform routes the projects:set-dep-satisfied action here;
// the user-configured wire decides when it fires (default seeded
// at signup is on inventory.stock.changed).

import type { Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import type { ProjectsDB } from "../db.js";

let registered = false;

export function registerProjectsHandlers(): void {
  if (registered) return;
  registered = true;

  // Entity-kind resolvers ─────────────────────────────────────────
  platform().entities.registerResolver(
    "projects:project",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<ProjectsDB>;
      const row = await db
        .selectFrom("projects_projects")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      const resolved: ResolvedEntity = {
        kind: "projects:project",
        id: row.id,
        title: row.name,
        subtitle: row.status,
        detailUrl: `/projects/${row.id}`,
        fields: {
          name: row.name,
          description: row.description,
          status: row.status,
          priority: row.priority,
          target_date: row.target_date,
        },
      };
      return resolved;
    },
  );

  platform().entities.registerResolver(
    "projects:task",
    async (orgId, id) => {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<ProjectsDB>;
      const row = await db
        .selectFrom("projects_tasks")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
      if (!row) return null;
      return {
        kind: "projects:task",
        id: row.id,
        title: row.title,
        subtitle: row.status,
        fields: {
          title: row.title,
          description: row.description,
          status: row.status,
          priority: row.priority,
          energy: row.energy,
          due_date: row.due_date,
        },
      };
    },
  );

  // Action handler ─────────────────────────────────────────────────
  // The platform calls this when a wire targeting
  // projects:set-dep-satisfied fires. The wire's event payload
  // tells us WHICH entity changed; we flip every matching task
  // dep to satisfied + emit a projects.task.unblocked event so
  // notifications / UI can react.
  platform().actions.registerHandler(
    "projects.set-dep-satisfied",
    async (ctx) => {
      if (!ctx.entityKind || !ctx.entityId) {
        return { ok: true, flipped: 0, reason: "no entity" };
      }
      // entityKind here looks like "inventory:part" (or whatever
      // the wire's source_kind was). We store the dep target as
      // (target_module, target_entity_type, target_entity_id) —
      // split the kind for lookup.
      const [module, entityType] = ctx.entityKind.split(":");
      if (!module || !entityType) {
        return { ok: true, flipped: 0, reason: "bad kind" };
      }
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<ProjectsDB>;
      const updated = await db
        .updateTable("projects_task_dependencies")
        .set({ satisfied: true })
        .where("target_module", "=", module)
        .where("target_entity_type", "=", entityType)
        .where("target_entity_id", "=", ctx.entityId)
        .where("satisfied", "=", false)
        .returning(["id", "task_id"])
        .execute();
      for (const dep of updated) {
        platform().events.emit("projects.task.unblocked", {
          orgId: ctx.orgId,
          taskId: dep.task_id,
          via: { kind: ctx.entityKind, id: ctx.entityId },
        });
      }
      return { ok: true, flipped: updated.length };
    },
  );
}
