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
import { getMover } from "../platform/move-records.js";
import {
  provisionInstance,
  getInstance,
  listInstances,
  setScanFallback,
  countInstanceItems,
  tearDownInstance,
} from "../platform/instances.js";
import { promoteCategory, demoteInstance } from "../platform/instance-promote.js";
import {
  deleteOverride,
  listOverrides,
  upsertOverride,
  type OverrideTarget,
} from "../platform/entity-kind-overrides.js";

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
      const orgId = req.tenant!.org.id;
      const items = await listInstances(orgId, moduleName);
      // Enrich with the primary-item count per instance (null if the module
      // registered no counter). Lets the nav hide an empty default instance.
      const enriched = await Promise.all(
        items.map(async (it) => ({
          ...it,
          item_count: await countInstanceItems(orgId, it.module_name, it.instance_name),
          // Whether records here can be moved to a sibling instance. A module
          // opts in by registering a mover, so the UI can hide "Move to..."
          // rather than offering an action that would 400. Modules that have
          // not considered their instance-scoped foreign keys stay out.
          movable: getMover(it.module_name) !== undefined,
        })),
      );
      res.json({ items: enriched });
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
      // The full birth — enabled check, collision check, create, presentation
      // seed — lives in platform/instances.ts (provisionInstance), shared with
      // the platform:create-instance action handler so an instance is born the
      // same way whichever surface asks.
      const result = await provisionInstance({
        orgId: req.tenant!.org.id,
        moduleName: parsed.data.module_name,
        instanceName: parsed.data.instance_name,
        displayName: parsed.data.display_name,
      });
      if (!result.ok) {
        res.status(result.code === "instance_name_taken" ? 409 : 400).json({
          error: { code: result.code, message: result.message },
        });
        return;
      }
      res.status(201).json(result.instance);
    } catch (err) {
      next(err);
    }
  },
);

// A category that outgrew its table gets one of its own — and can be folded back.
//
// The pair is deliberately symmetric: promote → demote → promote must land you
// exactly where you started. That reversibility is the whole point. It means you
// don't have to decide your table structure before you've scanned anything; you
// scan, categories emerge from real data, and the ones that earn a table get one.
const PromoteBody = z.object({
  category: z.string().min(1).max(60),
  instance_name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  display_name: z.string().min(1).max(160),
});

instancesRouter.post(
  "/:instanceName/promote-category",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireOwnerOrAdmin(req, res)) return;
      const parentInstance = req.params.instanceName;
      const parsed = PromoteBody.safeParse(req.body);
      if (!parentInstance || !parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad request body", details: parsed.error?.issues },
        });
        return;
      }
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
      const out = await promoteCategory({
        orgId: req.tenant!.org.id,
        parentInstance,
        category: parsed.data.category,
        instanceName: parsed.data.instance_name,
        displayName: parsed.data.display_name,
      });
      res.status(201).json(out);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "instance_not_found" || code === "no_schema") {
        res.status(400).json({ error: { code, message: (err as Error).message } });
        return;
      }
      next(err);
    }
  },
);

const DemoteBody = z.object({
  parent_instance: z.string().min(1),
  /** The category the demoted items take on. Defaults to the instance's display
   *  name — it IS the category, that's why it was promoted. */
  category: z.string().min(1).max(60).optional(),
});

instancesRouter.post(
  "/:instanceName/demote-to-category",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireOwnerOrAdmin(req, res)) return;
      const instanceName = req.params.instanceName;
      const parsed = DemoteBody.safeParse(req.body);
      if (!instanceName || !parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad request body", details: parsed.error?.issues },
        });
        return;
      }
      const inst = await getInstance(req.tenant!.org.id, instanceName);
      if (!inst) {
        res.status(404).json({ error: { code: "not_found", message: "instance not found" } });
        return;
      }
      const out = await demoteInstance({
        orgId: req.tenant!.org.id,
        instanceName,
        parentInstance: parsed.data.parent_instance,
        category: parsed.data.category ?? inst.display_name,
      });
      res.json(out);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "instance_not_found" || code === "is_default" || code === "bad_parent" || code === "no_schema") {
        res.status(400).json({ error: { code, message: (err as Error).message } });
        return;
      }
      next(err);
    }
  },
);

// Designate this instance as its module's scan catch-all — where a scan that
// matches no table IN PARTICULAR lands, to then be told apart by its category.
// Exclusive per module; setting a new one clears the old.
instancesRouter.post(
  "/:instanceName/scan-fallback",
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
      const inst = await setScanFallback(req.tenant!.org.id, instanceName);
      res.json(inst);
    } catch (err) {
      if ((err as { code?: string }).code === "instance_not_found") {
        res.status(404).json({ error: { code: "not_found", message: "instance not found" } });
        return;
      }
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
      // Full teardown via the SHARED helper: tenant-side rows for this
      // instance, the workspace_module_instances row, its presentation
      // override, AND its navbar-menu (nav-heading) membership. Previously this
      // route hand-rolled the first three and silently skipped the membership —
      // so a deleted category lingered in the "Inventory" menu's member table
      // and could resurrect on a same-named recreate. One helper = no drift.
      await tearDownInstance(req.tenant!.org.id, instanceName);
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
  // Free-form presentation config. Today carries `group_label` — the
  // custom heading for this module's specialisations/instances dropdown
  // (overrides the default "<module> specialisations"). Stored wholesale
  // on the override's JSONB column, so callers read-modify-write it.
  config: z.record(z.unknown()).optional(),
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
        config: parsed.data.config,
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
