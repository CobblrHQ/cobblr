// Instance-resolution middleware for /orgs/:slug/instances/:name/items.
//
// Resolves the URL's instance slug → (module, instance) via
// workspace_module_instances, then stamps req.instance + req.instanceModule
// so the dispatched module CRUD can scope every query to the instance.
// Composes AFTER requireAuth + withTenant (needs req.tenant.org.id).
//
// See docs/architecture/instances.md §5.

import type { NextFunction, Request, Response } from "express";
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
    next();
  } catch (err) {
    next(err);
  }
}
