// Instance-resolution middleware for /orgs/:slug/instances/:name/items.
//
// Resolves the URL's instance slug → (module, instance) via
// workspace_module_instances, then stamps req.instance + req.instanceModule
// so the dispatched module CRUD can scope every query to the instance.
// Composes AFTER requireAuth + withTenant (needs req.tenant.org.id).
//
// See docs/architecture/instances.md §5.

import type { NextFunction, Request, Response } from "express";
import { getOverrideConfig } from "../platform/entity-kind-overrides.js";
import { getInstance } from "../platform/instances.js";

declare module "express-serve-static-core" {
  interface Request {
    /** The resolved instance slug (e.g. "screws"). Module CRUD reads
     *  this to scope queries; absent on legacy /modules/<m>/<r> routes,
     *  where the module's `instanceOf` helper falls back to the default
     *  (the module name, matching the DB column default). */
    instance?: string;
    /** The module that owns the resolved instance (e.g. "inventory"). */
    instanceModule?: string;
    /** The instance's config blob (item_noun, qty_unit, …) so module CRUD
     *  can apply instance defaults (a "yarn" instance creates parts in
     *  skeins) without reading kernel tables. */
    instanceConfig?: Record<string, unknown>;
  }
}

export async function resolveInstance(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const orgId = req.tenant?.org.id;
    if (!orgId) {
      res.status(400).json({
        error: { code: "no_tenant", message: "tenant context required" },
      });
      return;
    }
    const name = req.params.instanceName;
    if (!name) {
      res.status(400).json({
        error: { code: "missing_instance", message: "instance name required" },
      });
      return;
    }
    const inst = await getInstance(orgId, name);
    if (!inst) {
      res.status(404).json({
        error: { code: "instance_not_found", message: `No instance '${name}' in this workspace.` },
      });
      return;
    }
    req.instance = inst.instance_name;
    req.instanceModule = inst.module_name;
    // Instance presentation/config (item_noun, qty_unit, …) lives on the
    // entity-kind-override row bundle install writes (target "instance"),
    // not the instance row itself — merge both so module CRUD sees one blob.
    const overrideCfg = await getOverrideConfig(
      orgId,
      "instance",
      `${inst.module_name}:${inst.instance_name}`,
    );
    req.instanceConfig = { ...inst.config, ...overrideCfg };
    next();
  } catch (err) {
    next(err);
  }
}
