// /api/v1/modules — list installed modules (read-only). Per-org
// "which of these are enabled" lives in cobblr_meta.org_modules
// (added in a later milestone alongside enable/disable endpoints).

import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { list } from "../modules/registry.js";

export const modulesRouter = Router();

modulesRouter.get("/", requireAuth, (_req, res) => {
  const items = list().map((m) => ({
    name: m.name,
    version: m.version,
    displayName: m.displayName,
    description: m.description,
    icon: m.icon ?? null,
    // Q4 in build-plan.md / module-layers.md — surfaces the band so
    // the workspace UI can hide the disable toggle for foundationals
    // and labels stock modules as "default-enabled."
    band: m.band,
    intents: m.intents.map((i) => ({ name: i.name, description: i.description })),
    exposes: m.exposes,
    dependencies: m.dependencies,
  }));
  res.json({ items });
});
