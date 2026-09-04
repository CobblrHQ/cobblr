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

// Either the workspace's OWN provider (provider_id + model) or a PERSONAL
// connection routed into this workspace (credential_id). The second is what
// makes a routed key configurable here rather than only on the owner's account
// page - it used to bypass this table entirely and serve every job.
const Upsert = z.object({
  capability: z.enum(AiCapabilities),
  provider_id: z.string().min(1).optional(),
  credential_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
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

// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
capabilitiesRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = Upsert.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const orgId = (req as { tenant?: { org: { id: string } } }).tenant!.org.id;
    let providerId = parsed.data.provider_id;
    const credentialId = parsed.data.credential_id ?? null;
    if (credentialId) {
      // A connection this workspace may actually name: routed here, of the AI
      // kind, and accepted. Anything else is not the workspace's to spend.
      const routed = await platform().connections.routedTo("ai-provider", orgId);
      const hit = routed.find((r) => r.credentialId === credentialId && r.approved);
      if (!hit) {
        res.status(400).json({
          error: {
            code: "unknown_connection",
            message: "That connection is not routed to this workspace, or has not been accepted yet.",
          },
        });
        return;
      }
      providerId = hit.providerId;
    }
    if (!providerId) {
      res.status(400).json({
        error: { code: "missing_provider", message: "provider_id or credential_id is required" },
      });
      return;
    }
    const def = platform().ai.getProvider(providerId);
    if (!def) {
      res.status(400).json({
        error: {
          code: "unknown_provider",
          message: `No provider with id ${providerId}`,
        },
      });
      return;
    }
    const cap = def.capabilities[parsed.data.capability];
    if (!cap) {
      res.status(400).json({
        error: {
          code: "unsupported_capability",
          message: `${providerId} doesn't do ${parsed.data.capability}`,
        },
      });
      return;
    }
    // A connection may be saved without naming a model: the provider's own
    // default for the job is a better answer than making somebody pick one.
    const model = parsed.data.model ?? cap.defaultModel ?? cap.models[0];
    if (!model || !cap.models.includes(model)) {
      res.status(400).json({
        error: {
          code: "unsupported_model",
          message: `${providerId} doesn't support ${parsed.data.capability} on ${model ?? "(no model)"}`,
        },
      });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .insertInto("core_ai_capability_defaults")
      .values({
        capability: parsed.data.capability,
        provider_id: providerId,
        credential_id: credentialId,
        model,
        config: sql`${JSON.stringify(parsed.data.config ?? {})}::jsonb` as never,
      })
      .onConflict((c) =>
        c.column("capability").doUpdateSet({
          provider_id: providerId,
          credential_id: credentialId,
          model,
          config: sql`${JSON.stringify(parsed.data.config ?? {})}::jsonb` as never,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(row);
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
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
