// Module-router mounting. Each registered module can ship a default
// Express Router via the manifest's `api` import. The platform mounts
// it at /api/v1/orgs/:slug/modules/<name>/ with requireAuth +
// withTenant pre-applied — handlers don't have to repeat auth and
// tenant resolution.
//
// Modules can also expose API methods callable from other modules
// (manifest.exposes.api) — that's a separate phase-2 surface and
// not part of this mount step. For now the mount only wires HTTP.

import type { Router, Request, Response, NextFunction } from "express";
import type { Application } from "express";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { listEntries } from "./registry.js";

export interface ModuleApiModule {
  default: Router;
  /** Optional: a module's primary-entity CRUD sub-router (e.g. inventory's
   *  parts router). When present, the platform can dispatch
   *  /orgs/:slug/instances/:name/items to it with an instance scope. */
  primaryRouter?: Router;
}

/** Track which modules we've already mounted so a runtime install
 *  can re-trigger mount safely without double-registering routes. */
const mountedNames = new Set<string>();
/** moduleName → its primary-entity router, for instance-scoped item CRUD. */
import { applyComputedFields } from "../platform/computed-fields.js";

const primaryRouters = new Map<string, Router>();
let appRef: Application | null = null;


/** Middleware for /orgs/:slug/instances/:name/items — dispatches to the
 *  resolved module's primary router (req.instanceModule is set by
 *  resolveInstance). The module CRUD reads req.instance and scopes every
 *  query. Modules that haven't exposed a primaryRouter yet get a clean
 *  501 rather than a confusing 404. */
export function dispatchInstanceItems(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const moduleName = req.instanceModule;
  const router = moduleName ? primaryRouters.get(moduleName) : undefined;
  if (!router) {
    res.status(501).json({
      error: {
        code: "instance_items_unsupported",
        message: `Item CRUD for '${moduleName ?? "this"}' instances isn't available yet.`,
      },
    });
    return;
  }

  // COMPUTED FIELDS ON THE WAY OUT.
  //
  // A module's own list route is a second read path, and the platform's entity
  // resolver is what applies computed fields — so an instance table, which reads
  // through here, got raw columns and no computed values at all. A bundle could
  // declare a column, the value would resolve correctly through
  // /entities/<kind>/<id>, and the table it was declared for rendered it blank.
  // (The same "second read path must not skip a platform step" note already
  // exists on withFieldLabels in the contract; this is the same trap one step
  // over.)
  //
  // Wrapping the response here rather than in each module's list route means
  // every instance of every module gets it, including ones written later.
  // The presentation kind for an instance is "<instance_name>:item" — the same
  // string a bundle's field defs are registered under.
  const kind = req.instance ? `${req.instance}:item` : undefined;
  const orgId = req.tenant?.org.id;
  if (kind && orgId) {
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      void (async () => {
        try {
          sendJson(await withComputedFields(orgId, kind, body));
        } catch (err) {
          // Never fail a list because a computed template did: the raw rows are
          // still the truth, the column just stays blank.
          console.error("[instances] computed fields skipped:", (err as Error).message);
          sendJson(body);
        }
      })();
      return res;
    }) as Response["json"];
  }

  router(req, res, next);
}

/** Run a module list/detail payload through the computed-field resolver.
 *  Handles the two shapes a module returns: `{ items: [...] }` and a bare
 *  entity. Rows keep their own shape — computed values are merged into
 *  `metadata`, which is where a table column reads them from. */
async function withComputedFields(orgId: string, kind: string, body: unknown): Promise<unknown> {
  if (!body || typeof body !== "object") return body;
  const rows = Array.isArray((body as { items?: unknown }).items)
    ? ((body as { items: Record<string, unknown>[] }).items)
    : null;
  const one = rows ? null : (body as Record<string, unknown>);
  if (!rows && (!one || typeof one.id !== "string")) return body;

  const apply = async (row: Record<string, unknown>) => {
    if (typeof row.id !== "string") return row;
    const resolved = await applyComputedFields(orgId, {
      kind,
      id: row.id,
      title: String(row.name ?? ""),
      fields: row,
    } as Parameters<typeof applyComputedFields>[1]);
    return { ...row, metadata: resolved.fields.metadata };
  };

  if (rows) return { ...(body as object), items: await Promise.all(rows.map(apply)) };
  return await apply(one!);
}

/** Gate a module's data routes on the module being enabled for the
 *  caller's org. Without this, a deep link to a not-yet-enabled module
 *  (e.g. /inventory before the user turns it on) runs queries against
 *  tenant tables that don't exist yet and leaks a raw Postgres
 *  `relation "…" does not exist` 500. Returns a clean 409 the client
 *  can render as "enable this module first". requireAuth + withTenant
 *  run before this, so req.tenant.org.id is populated. */
function requireModuleEnabled(moduleName: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const orgId = req.tenant?.org.id;
    if (!orgId) {
      // withTenant should always set this; if it somehow didn't, let
      // the downstream handler surface its own error rather than
      // masking it here.
      next();
      return;
    }
    const row = await meta
      .selectFrom("org_modules")
      .select("module_name")
      .where("org_id", "=", orgId)
      .where("module_name", "=", moduleName)
      .executeTakeFirst();
    if (!row) {
      res.status(409).json({
        error: {
          code: "module_not_enabled",
          message: `The "${moduleName}" module isn't enabled for this workspace. Enable it in Configuration → Modules.`,
        },
      });
      return;
    }
    next();
  };
}

export async function mountModules(app: Application): Promise<{
  mounted: string[];
}> {
  appRef = app;
  const mounted: string[] = [];
  for (const entry of listEntries()) {
    if (await mountSingleEntry(app, entry)) mounted.push(entry.manifest.name);
  }
  return { mounted };
}

async function mountSingleEntry(app: Application, entry: ReturnType<typeof listEntries>[number]): Promise<boolean> {
  const { manifest } = entry;
  if (mountedNames.has(manifest.name)) return false;
  if (!manifest.api) return false;
  let imported: unknown;
  try {
    imported = await manifest.api();
  } catch (err) {
    console.error(`[modules] failed to import api for ${manifest.name}:`, err);
    return false;
  }
  const router = (imported as ModuleApiModule | undefined)?.default;
  if (!router || typeof router !== "function") {
    console.error(
      `[modules] ${manifest.name}: api() resolved without a default Router — skipping`,
    );
    return false;
  }
  const mountPath = `/api/v1/orgs/:slug/modules/${manifest.name}`;
  app.use(mountPath, requireAuth, withTenant, requireModuleEnabled(manifest.name), router);
  // Merge-compat alias (labels 0.6.0): the former core-labels-qr module's
  // paths keep answering, served by labels' QR routers, gated on labels
  // being enabled.
  // DONE WHEN: merge-labels-qr.ts's DONE WHEN reads true — the boot shim,
  // this alias block, and migration 0004's compat views retire together.
  if (manifest.name === "labels") { // HISTORICAL DATA MIGRATION names the module it heals (merge alias)
    const compat = (imported as { qrCompatRouter?: Router } | undefined)?.qrCompatRouter;
    if (compat && typeof compat === "function") {
      app.use(
        "/api/v1/orgs/:slug/modules/core-labels-qr",
        requireAuth,
        withTenant,
        requireModuleEnabled("labels"), // HISTORICAL DATA MIGRATION names the module it heals
        compat,
      );
    }
  }
  // Capture the module's primary-entity router (if exposed) so the
  // instance-items dispatcher can route /instances/:name/items to it.
  const primary = (imported as ModuleApiModule | undefined)?.primaryRouter;
  if (primary && typeof primary === "function") {
    primaryRouters.set(manifest.name, primary);
  }
  mountedNames.add(manifest.name);
  console.log(`[modules] mounted ${manifest.name} at ${mountPath}`);
  return true;
}

/** Mount a newly-registered module after boot. Used by the runtime
 *  sandboxed-module install endpoint — the new module's manifest
 *  is in the registry, we just need to wire its routes. Returns
 *  true if the mount was performed; false if the module is already
 *  mounted or has no api(). */
export async function mountNewlyRegistered(moduleName: string): Promise<boolean> {
  if (!appRef) {
    console.error(`[modules] cannot mount ${moduleName}: app not initialised`);
    return false;
  }
  const entry = listEntries().find((e) => e.manifest.name === moduleName);
  if (!entry) {
    console.error(`[modules] cannot mount ${moduleName}: not in registry`);
    return false;
  }
  return mountSingleEntry(appRef, entry);
}
