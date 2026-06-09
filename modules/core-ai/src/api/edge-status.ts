// GET /api/v1/orgs/:slug/modules/core-ai/edge-status — is a Cobblr edge agent
// currently connected for this workspace? Drives the "Local AI (via edge
// bridge)" provider's connection indicator in the UI (the provider itself has
// no testConnection, since that path gets no orgId). Open core answers from the
// in-process registry; the hosted relay is what populates it.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { sessionUserId } from "../db.js";
import { asyncHandler } from "./util.js";

export const edgeStatusRouter = Router({ mergeParams: true });

// The edge channel is keyed by the USER (one agent, all their workspaces), so
// "is my device connected?" checks the caller's own channel.
edgeStatusRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = sessionUserId(req);
    res.json({ connected: !!userId && platform().edge.hasChannel(userId) });
  }),
);
