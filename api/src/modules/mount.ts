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

export async function mountModules(app: Application): Promise<{
  mounted: string[];
}> {
  const mounted: string[] = [];
  for (const entry of listEntries()) {
    const { manifest } = entry;
    if (!manifest.api) continue;

    let imported: unknown;
    try {
      imported = await manifest.api();
    } catch (err) {
      console.error(`[modules] failed to import api for ${manifest.name}:`, err);
      continue;
    }

    const router = (imported as ModuleApiModule | undefined)?.default;
    if (!router || typeof router !== "function") {
      console.error(
        `[modules] ${manifest.name}: api() resolved without a default Router — skipping`,
      );
      continue;
    }

    const mountPath = `/api/v1/orgs/:slug/modules/${manifest.name}`;
    app.use(mountPath, requireAuth, withTenant, router);
    mounted.push(manifest.name);
    console.log(`[modules] mounted ${manifest.name} at ${mountPath}`);
  }
  return { mounted };
}
