import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { PLACE_INDICATE } from "@cobblr/platform-contract/place-indicate";
import { tenantContext, sessionUser } from "../db.js";
import { requestLight, savePlaceLight, saveGridLights, LIGHT_EVENTS, LightSetupError } from "../lights.js";
import type { Request, Response } from "express";
import { asyncHandler, requireRole } from "./util.js";

export const lightsRouter = Router({ mergeParams: true });
const lightHandler = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncHandler(async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof z.ZodError || e instanceof LightSetupError) {
      res.status(400).json({ error: { code: "invalid_light", message: e instanceof LightSetupError ? e.message : "Check the light settings and LED ranges." } });
      return;
    }
    throw e;
  }
});
lightsRouter.get("/lights", asyncHandler(async (req, res) => {
  const items = (await platform().services.connectionsFor(tenantContext(req).org.id, PLACE_INDICATE)).filter(c => c.shared);
  res.json({ items });
}));
// AI-ACTION: core-locations:show-me
// AI-REACH: action core-locations:show-me
lightsRouter.post("/lights/request", lightHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-locations:show-me"))) return;
  const body = z.object({ kind: z.string().min(1).max(160), id: z.string().uuid(), reason: z.enum(["shown", "found", "picked", "put-away", "label-scanned"]).default("found") }).parse(req.body);
  const reason = LIGHT_EVENTS.find(e => e.endsWith(`.${body.reason}`))!;
  res.json(await requestLight(tenantContext(req).org.id, body, reason));
}));
// AI-ACTION: core-locations:set-light
// AI-REACH: action core-locations:set-light
lightsRouter.put("/:id/light", lightHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-locations:set-light"))) return;
  await savePlaceLight(tenantContext(req).org.id, z.string().uuid().parse(req.params.id), req.body?.mapping, sessionUser(req).id);
  res.json({ saved: true });
}));
// AI-ACTION: core-locations:map-light-grid
// AI-REACH: action core-locations:map-light-grid
lightsRouter.post("/:id/light-grid", lightHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-locations:map-light-grid"))) return;
  res.json({ mapped: await saveGridLights(tenantContext(req).org.id, z.string().uuid().parse(req.params.id), req.body, sessionUser(req).id) });
}));
