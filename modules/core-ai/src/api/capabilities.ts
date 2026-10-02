// /api/v1/orgs/:slug/modules/core-ai/capability-defaults — workspace's
// preferred provider + model for each capability. A wire firing
// "summarise" doesn't have to pick a model every time.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform, AiCapabilities } from "@cobblr/platform-contract";
import { sessionUserId, tenantDb } from "../db.js";
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

// GET /capability-defaults/models?provider_id=…|credential_id=…[&fresh=1]
// What a connection reports it serves, for the job picker's model list: the
// same answer the save checks against, so the list never offers a model the
// save refuses or hides one it would take. `reported` is null for a provider
// that keeps a curated list.
// AI-REACH: this module IS the assistant; its own configuration is not a thing it should reach into
capabilitiesRouter.get(
  "/models",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const orgId = (req as { tenant?: { org: { id: string } } }).tenant!.org.id;
    const providerId = typeof req.query.provider_id === "string" ? req.query.provider_id : undefined;
    const credentialId = typeof req.query.credential_id === "string" ? req.query.credential_id : undefined;
    if (!providerId && !credentialId) {
      res.status(400).json({ error: { code: "missing_provider", message: "provider_id or credential_id is required" } });
      return;
    }
    const reported = await platform()
      .ai.modelsReportedBy(orgId, sessionUserId(req) ?? null, credentialId ? { credentialId } : { providerId: providerId! }, { fresh: req.query.fresh === "1" })
      .catch(() => null);
    res.json({ reported });
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
    // A connection that can be asked what it serves accepts exactly that: a
    // self-hoster's box with muse-glimmer pulled accepts muse-glimmer, though
    // it is on no list this code ships (#4586). One that cannot be asked
    // right now refuses with why, rather than taking a name on trust.
    const reported = model
      ? await platform()
          .ai.modelsReportedBy(orgId, sessionUserId(req) ?? null, credentialId ? { credentialId } : { providerId })
          .catch(() => null)
      : null;
    if (reported && !reported.ok) {
      res.status(400).json({
        error: { code: "models_unlisted", message: `Couldn't ask ${providerId} which models it serves: ${reported.error}` },
      });
      return;
    }
    const offered = reported?.ok ? reported.models : cap.models;
    if (!model || !offered.includes(model)) {
      res.status(400).json({
        error: {
          code: "unsupported_model",
          message: reported?.ok
            ? `${providerId} doesn't serve ${model ?? "(no model)"}. It reports: ${reported.models.slice(0, 12).join(", ") || "nothing"}`
            : `${providerId} doesn't support ${parsed.data.capability} on ${model ?? "(no model)"}`,
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
