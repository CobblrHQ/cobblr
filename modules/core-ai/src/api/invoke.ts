// /api/v1/orgs/:slug/modules/core-ai/invoke — ad-hoc invocation.
// Same shape as platform().ai.invoke(). Useful from the UI for
// "try it" and from the CLI / scripts.

import { Router } from "express";
import { z } from "zod";
import { platform, AiCapabilities } from "@cobblr/platform-contract";
import { tenantContext, sessionUserId } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const invokeRouter = Router({ mergeParams: true });

const Body = z.object({
  privacy: z.enum(["personal", "normal"]).default("normal"),
  capability: z.enum(AiCapabilities),
  input: z.record(z.unknown()),
  provider_id: z.string().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  model: z.string().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  bypass_cache: z.boolean().optional(),
  source: z.object({ kind: z.string(), id: z.string() }).optional(),
});

// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
// UI-REACH: low-level capability invocation for API clients; people use the task-specific chat, scan and build flows.
invokeRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    try {
      // FREE-TEXT: the generic invoke route passes the caller's input through, output_schema included when the caller sends one
      const r = await platform().ai.invoke({
        orgId: ctx.org.id,
        capability: parsed.data.capability,
        input: parsed.data.input,
        ...(parsed.data.privacy === "personal" ? { privacy: "personal" as const } : { privacy: "normal" as const, provider_id: parsed.data.provider_id }),
        model: parsed.data.model,
        bypass_cache: parsed.data.bypass_cache,
        source: parsed.data.source,
        userId: sessionUserId(req),
      });
      res.json(r);
    } catch (err) {
      res.status(502).json({
        error: { code: "ai_failed", message: (err as Error).message },
      });
    }
  }),
);
