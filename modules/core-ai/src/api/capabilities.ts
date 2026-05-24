// /api/v1/orgs/:slug/modules/core-ai/capability-defaults — workspace's
// preferred provider + model for each capability. A wire firing
// "summarise" doesn't have to pick a model every time.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform, AiCapabilities } from "@cobblr/platform-contract";
import { tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const capabilitiesRouter = Router({ mergeParams: true });

const Upsert = z.object({
  capability: z.enum(AiCapabilities),
  provider_id: z.string().min(1),
  model: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

capabilitiesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("core_ai_capability_defaults")
      .selectAll()
      .execute();
    res.json({ items: rows, all_capabilities: AiCapabilities });
  }),
);

capabilitiesRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = Upsert.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const def = platform().ai.getProvider(parsed.data.provider_id);
    if (!def) {
      res.status(400).json({
        error: {
          code: "unknown_provider",
          message: `No provider with id ${parsed.data.provider_id}`,
        },
      });
      return;
    }
    if (!def.capabilities[parsed.data.capability]?.models.includes(parsed.data.model)) {
      res.status(400).json({
        error: {
          code: "unsupported_model",
          message: `${parsed.data.provider_id} doesn't support ${parsed.data.capability} on ${parsed.data.model}`,
        },
      });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .insertInto("core_ai_capability_defaults")
      .values({
        capability: parsed.data.capability,
        provider_id: parsed.data.provider_id,
        model: parsed.data.model,
        config: sql`${JSON.stringify(parsed.data.config ?? {})}::jsonb` as never,
      })
      .onConflict((c) =>
        c.column("capability").doUpdateSet({
          provider_id: parsed.data.provider_id,
          model: parsed.data.model,
          config: sql`${JSON.stringify(parsed.data.config ?? {})}::jsonb` as never,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(row);
  }),
);

capabilitiesRouter.delete(
  "/:capability",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const capability = req.params.capability;
    if (!capability) {
      res.status(400).json({ error: { code: "missing_capability", message: "required" } });
      return;
    }
    const db = tenantDb(req);
    await db
      .deleteFrom("core_ai_capability_defaults")
      .where("capability", "=", capability)
      .execute();
    res.status(204).end();
  }),
);
