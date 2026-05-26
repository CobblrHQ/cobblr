// Module-router mounting. Each registered module can ship a default
// Express Router via the manifest's `api` import. The platform mounts
// it at /api/v1/orgs/:slug/modules/<name>/ with requireAuth +
// withTenant pre-applied — handlers don't have to repeat auth and
// tenant resolution.
//
// Modules can also expose API methods callable from other modules
// (manifest.exposes.api) — that's a separate phase-2 surface and
// not part of this mount step. For now the mount only wires HTTP.

import type { Router } from "express";
import type { Application } from "express";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { listEntries } from "./registry.js";

export interface ModuleApiModule {
  default: Router;
}

/** Track which modules we've already mounted so a runtime install
 *  can re-trigger mount safely without double-registering routes. */
const mountedNames = new Set<string>();
let appRef: Application | null = null;

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
  app.use(mountPath, requireAuth, withTenant, router);
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
