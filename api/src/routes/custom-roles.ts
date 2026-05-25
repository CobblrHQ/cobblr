// Custom-role management — admin-only.
//
// Workspace admins define named roles ("Sorter", "Buyer") that bundle
// multiple per-action capabilities. Members can be assigned one or
// more custom roles in addition to their stock role.
//
// See docs/design-decisions/member-portal-and-permissions.md §7 +
// 2026-05-25-audit.md S2.

import { Router } from "express";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import * as activity from "../platform/activity.js";

export const customRolesRouter = Router({ mergeParams: true });

function requireAdmin(req: Parameters<typeof requireAuth>[0], res: Parameters<typeof requireAuth>[1]): boolean {
  if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
    res.status(403).json({ error: { code: "forbidden", message: "Admins only." } });
    return false;
  }
  return true;
}

// GET /orgs/:slug/roles — list custom roles in this workspace with
// their capability lists.
customRolesRouter.get(
  "/:slug/roles",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const orgId = req.tenant!.org.id;
      const roles = await meta
        .selectFrom("workspace_roles")
        .selectAll()
        .where("org_id", "=", orgId)
        .orderBy("name")
        .execute();
      const caps =
        roles.length > 0
          ? await meta
              .selectFrom("workspace_role_capabilities")
              .select(["role_id", "action_id"])
              .where(
                "role_id",
                "in",
                roles.map((r) => r.id),
              )
              .execute()
          : [];
      const capsByRole = new Map<string, string[]>();
      for (const c of caps) {
        const list = capsByRole.get(c.role_id) ?? [];
        list.push(c.action_id);
        capsByRole.set(c.role_id, list);
      }
      // Member-count per role for the matrix UI.
      const counts =
        roles.length > 0
          ? await meta
              .selectFrom("workspace_role_assignments")
              .select(["role_id", meta.fn.count<number>("user_id").as("count")])
              .where("org_id", "=", orgId)
              .where(
                "role_id",
                "in",
                roles.map((r) => r.id),
              )
              .groupBy("role_id")
              .execute()
          : [];
      const countByRole = new Map(counts.map((c) => [c.role_id, Number(c.count)]));
      res.json({
        items: roles.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          created_at: r.created_at,
          capabilities: capsByRole.get(r.id) ?? [],
          member_count: countByRole.get(r.id) ?? 0,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

const CreateRole = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  capabilities: z.array(z.string().min(1).max(120)).default([]),
});

// POST /orgs/:slug/roles — define a new custom role.
customRolesRouter.post(
  "/:slug/roles",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const parsed = CreateRole.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues },
        });
        return;
      }
      const orgId = req.tenant!.org.id;
      const created = await meta.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto("workspace_roles")
          .values({
            org_id: orgId,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            created_by: req.session!.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (parsed.data.capabilities.length > 0) {
          await trx
            .insertInto("workspace_role_capabilities")
            .values(
              parsed.data.capabilities.map((cap) => ({
                role_id: row.id,
                action_id: cap,
              })),
            )
            .execute();
        }
        return row;
      });
      await activity
        .log({
          orgId,
          userId: req.session!.id,
          action: "custom_role_created",
          ref: { module: null, entityType: "workspace_role", entityId: created.id },
          diff: { name: parsed.data.name, capabilities: parsed.data.capabilities },
        })
        .catch((err) => console.error("[custom-roles] log failed:", err));
      res.status(201).json({ role: created, capabilities: parsed.data.capabilities });
    } catch (err) {
      next(err);
    }
  },
);

const UpdateRole = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  /** Full replacement of the capability list. Pass an empty array to
   *  clear all capabilities. */
  capabilities: z.array(z.string().min(1).max(120)).optional(),
});

// PATCH /orgs/:slug/roles/:id — update name/description/capabilities.
customRolesRouter.patch(
  "/:slug/roles/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const parsed = UpdateRole.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues },
        });
        return;
      }
      const orgId = req.tenant!.org.id;
      const id = req.params.id!;
      await meta.transaction().execute(async (trx) => {
        if (parsed.data.name !== undefined || parsed.data.description !== undefined) {
          const set: { name?: string; description?: string | null } = {};
          if (parsed.data.name !== undefined) set.name = parsed.data.name;
          if (parsed.data.description !== undefined) set.description = parsed.data.description;
          await trx
            .updateTable("workspace_roles")
            .set(set)
            .where("id", "=", id)
            .where("org_id", "=", orgId)
            .execute();
        }
        if (parsed.data.capabilities !== undefined) {
          await trx
            .deleteFrom("workspace_role_capabilities")
            .where("role_id", "=", id)
            .execute();
          if (parsed.data.capabilities.length > 0) {
            await trx
              .insertInto("workspace_role_capabilities")
              .values(
                parsed.data.capabilities.map((cap) => ({
                  role_id: id,
                  action_id: cap,
                })),
              )
              .execute();
          }
        }
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /orgs/:slug/roles/:id — drop the role. Cascade clears
// assignments + capabilities.
customRolesRouter.delete(
  "/:slug/roles/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const orgId = req.tenant!.org.id;
      const id = req.params.id!;
      await meta
        .deleteFrom("workspace_roles")
        .where("id", "=", id)
        .where("org_id", "=", orgId)
        .execute();
      await activity
        .log({
          orgId,
          userId: req.session!.id,
          action: "custom_role_deleted",
          ref: { module: null, entityType: "workspace_role", entityId: id },
        })
        .catch((err) => console.error("[custom-roles] log failed:", err));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

const AssignmentBody = z.object({
  user_id: z.string().uuid(),
  role_id: z.string().uuid(),
});

// POST /orgs/:slug/role-assignments — assign a custom role to a member.
customRolesRouter.post(
  "/:slug/role-assignments",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const parsed = AssignmentBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues },
        });
        return;
      }
      const orgId = req.tenant!.org.id;
      // Verify target user is a member of this workspace.
      const member = await meta
        .selectFrom("org_memberships")
        .select("user_id")
        .where("org_id", "=", orgId)
        .where("user_id", "=", parsed.data.user_id)
        .executeTakeFirst();
      if (!member) {
        res.status(404).json({ error: { code: "not_member", message: "User isn't a member." } });
        return;
      }
      // Verify the role belongs to this workspace.
      const role = await meta
        .selectFrom("workspace_roles")
        .select("id")
        .where("id", "=", parsed.data.role_id)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (!role) {
        res.status(404).json({ error: { code: "not_found", message: "Role not found." } });
        return;
      }
      await meta
        .insertInto("workspace_role_assignments")
        .values({
          org_id: orgId,
          user_id: parsed.data.user_id,
          role_id: parsed.data.role_id,
          assigned_by: req.session!.id,
        })
        .onConflict((c) => c.columns(["org_id", "user_id", "role_id"]).doNothing())
        .execute();
      res.status(201).end();
    } catch (err) {
      next(err);
    }
  },
);

customRolesRouter.delete(
  "/:slug/role-assignments",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const parsed = AssignmentBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues },
        });
        return;
      }
      const orgId = req.tenant!.org.id;
      await meta
        .deleteFrom("workspace_role_assignments")
        .where("org_id", "=", orgId)
        .where("user_id", "=", parsed.data.user_id)
        .where("role_id", "=", parsed.data.role_id)
        .execute();
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);
