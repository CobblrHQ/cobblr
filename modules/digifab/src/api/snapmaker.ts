import { Router } from "express";
import { z } from "zod";
import { tenantContext } from "../db.js";
import { discoverSnapmakers, pairSnapmaker } from "../snapmaker.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const snapmakerRouter = Router({ mergeParams: true });

// AI-REACH: digifab:discover-snapmakers runs the same read through invoke_action.
snapmakerRouter.get("/discover", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = z.string().trim().min(1).max(60).nullable().safeParse(req.query.bridge || null);
  if (!parsed.success) return badBody(res, parsed.error);
  res.json(await discoverSnapmakers(tenantContext(req).org.id, parsed.data));
}));

// AI-REACH: exempt touchscreen pairing mints a secret; only the interactive setup can request it, and the token never leaves the server.
snapmakerRouter.post("/:connectionId/pair", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const id = z.string().uuid().safeParse(req.params.connectionId);
  if (!id.success) return badBody(res, id.error);
  res.set("Cache-Control", "no-store").json(await pairSnapmaker(tenantContext(req).org.id, id.data));
}));
