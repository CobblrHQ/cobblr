// /orgs/:slug/instances + /orgs/:slug/entity-kind-overrides
//
// Workspace instance management (the funnel UI's POST target) and
// the presentation-overrides registry (renames / icons / hidden /
// ordering). Both are read-mostly from the web side; CRUD is workspace
// owner/admin only.

import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { getEntry } from "../modules/registry.js";
import {
  createInstance,
  deleteInstance,
  getInstance,
  listInstances,
} from "../platform/instances.js";
import {
  deleteOverride,
  listOverrides,
  upsertOverride,
  type OverrideTarget,
} from "../platform/entity-kind-overrides.js";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import { sql, type Kysely } from "kysely";

export const instancesRouter = Router({ mergeParams: true });
export const overridesRouter = Router({ mergeParams: true });

// ─────────────────────────── instances ─────────────────────────────

const CreateInstanceBody = z.object({
  module_name: z.string().min(1),
  instance_name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  display_name: z.string().min(1).max(160),
});

function role(req: Request): string | undefined {
  return (req as unknown as { tenant?: { role: string } }).tenant?.role;
}

function requireOwnerOrAdmin(req: Request, res: Response): boolean {
  const r = role(req);
  if (r === "owner" || r === "admin") return true;
  res.status(403).json({
    error: { code: "forbidden", message: "Requires owner or admin role." },
  });
  return false;
}

instancesRouter.get(
  "/",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const moduleName =
        typeof req.query.module === "string" ? req.query.module : undefined;
      const items = await listInstances(req.tenant!.org.id, moduleName);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

instancesRouter.post(
  "/",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireOwnerOrAdmin(req, res)) return;
      const parsed = CreateInstanceBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "invalid_body",
            message: "Bad request body",
            details: parsed.error.issues,
          },
        });
        return;
      }
      // Confirm the module is enabled for the workspace before creating
      // an instance of it.
      const enabled = await meta
        .selectFrom("org_modules")
        .select("module_name")
        .where("org_id", "=", req.tenant!.org.id)
        .where("module_name", "=", parsed.data.module_name)
        .executeTakeFirst();
      if (!enabled) {
        res.status(400).json({
          error: {
            code: "module_not_enabled",
            message: `Module '${parsed.data.module_name}' isn't enabled for this workspace. Enable it first.`,
          },
        });
        return;
      }
      // Confirm the instance_name doesn't collide with another instance
      // (workspace-unique across all modules).
      const collision = await getInstance(req.tenant!.org.id, parsed.data.instance_name);
      if (collision) {
        res.status(409).json({
          error: {
            code: "instance_name_taken",
            message: `Instance name '${parsed.data.instance_name}' is already used by ${collision.module_name}.`,
          },
        });
        return;
      }
      try {
        const created = await createInstance({
          orgId: req.tenant!.org.id,
          moduleName: parsed.data.module_name,
          instanceName: parsed.data.instance_name,
          displayName: parsed.data.display_name,
          isDefault: false,
        });
        // Seed a presentation override row so the new instance shows
        // up in the nav with its display name.
        await upsertOverride({
          orgId: req.tenant!.org.id,
          targetKind: "instance",
          targetId: `${parsed.data.module_name}:${parsed.data.instance_name}`,
          displayLabel: parsed.data.display_name,
          insertOnly: true,
        });
        res.status(201).json(created);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "invalid_slug" || code === "unknown_module" || code === "module_is_single_instance") {
          res.status(400).json({
            error: { code, message: (err as Error).message },
          });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  },
);

instancesRouter.delete(
  "/:instanceName",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireOwnerOrAdmin(req, res)) return;
      const instanceName = req.params.instanceName;
      if (!instanceName) {
        res.status(400).json({ error: { code: "missing_id", message: "instance name required" } });
        return;
      }
      const inst = await getInstance(req.tenant!.org.id, instanceName);
      if (!inst) {
        res.status(404).json({ error: { code: "not_found", message: "instance not found" } });
        return;
      }
      if (inst.is_default) {
        res.status(400).json({
          error: {
            code: "cannot_delete_default",
            message: `Cannot delete the default instance '${instanceName}' — disable the module instead.`,
          },
        });
        return;
      }
      // Best-effort: delete the module's tenant-side rows for this
      // instance. The platform doesn't know which tables the module
      // owns, but we know the module name + prefix. Iterate the
      // manifest's expected tables via tablePrefix.
      const entry = getEntry(inst.module_name);
      if (entry?.manifest.schema) {
        const prefix = entry.manifest.schema.tablePrefix;
        try {
          const tdb = (await getTenantDb(inst.org_id)) as unknown as Kysely<Record<string, { instance: string }>>;
          // Get the list of tables matching the prefix from
          // information_schema, then DELETE per-table where instance
          // matches.
          const { rows } = await (tdb as unknown as { executeQuery: (sql: unknown) => Promise<{ rows: Array<{ table_name: string }> }> }).executeQuery(
            sql`select table_name from information_schema.tables where table_schema='public' and table_name like ${prefix + "%"}`.compile(tdb as never),
          );
          for (const r of rows) {
            await (tdb as unknown as { executeQuery: (sql: unknown) => Promise<unknown> }).executeQuery(
              sql.raw(`delete from "${r.table_name}" where instance = '${inst.instance_name}'`).compile(tdb as never),
            );
          }
        } catch (err) {
          console.error(
            `[instances] tenant cleanup for ${inst.module_name}/${inst.instance_name} failed:`,
            err,
          );
          // Continue — orphaned rows are a smaller problem than a
          // half-uninstalled instance row in meta.
        }
      }
      await deleteInstance(inst.org_id, instanceName);
      await deleteOverride(req.tenant!.org.id, "instance", `${inst.module_name}:${inst.instance_name}`);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────────── entity-kind-overrides ────────────────────────

const UpsertOverrideBody = z.object({
  target_kind: z.enum(["entity_kind", "instance", "bundle"]),
  target_id: z.string().min(1),
  display_label: z.string().max(160).nullable().optional(),
  display_label_plural: z.string().max(160).nullable().optional(),
  icon: z.string().max(80).nullable().optional(),
  hidden: z.boolean().optional(),
  nav_order: z.number().int().nullable().optional(),
});

overridesRouter.get(
  "/",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const items = await listOverrides(req.tenant!.org.id);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

overridesRouter.put(
  "/",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireOwnerOrAdmin(req, res)) return;
      const parsed = UpsertOverrideBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "invalid_body",
            message: "Bad request body",
            details: parsed.error.issues,
          },
        });
        return;
      }
      const row = await upsertOverride({
        orgId: req.tenant!.org.id,
        targetKind: parsed.data.target_kind as OverrideTarget,
        targetId: parsed.data.target_id,
        displayLabel: parsed.data.display_label,
        displayLabelPlural: parsed.data.display_label_plural,
        icon: parsed.data.icon,
        hidden: parsed.data.hidden,
        navOrder: parsed.data.nav_order,
      });
      res.json(row);
    } catch (err) {
      next(err);
    }
  },
);

overridesRouter.delete(
  "/:targetKind/:targetId",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireOwnerOrAdmin(req, res)) return;
      const tk = req.params.targetKind;
      const tid = req.params.targetId;
      if (tk !== "entity_kind" && tk !== "instance" && tk !== "bundle") {
        res.status(400).json({ error: { code: "invalid_target_kind", message: "bad target_kind" } });
        return;
      }
      if (!tid) {
        res.status(400).json({ error: { code: "missing_id", message: "target_id required" } });
        return;
      }
      await deleteOverride(req.tenant!.org.id, tk as OverrideTarget, tid);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// Tiny type punning so TS doesn't complain about req in the helpers
// defined above the imports.
type Request = import("express").Request;
type Response = import("express").Response;
