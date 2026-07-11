// /api/v1/orgs/:slug/modules/core-ai/match-to-catalog
//
// The killer v0.1 use case. POST { entity, catalog_id } →
// candidates from the catalog + an LLM pick.
//
// 1. Pull top N candidates from core_catalogs_entries by name
//    proximity (cheap, local, no AI cost).
// 2. Send {entity, candidates, optional image_url} to the configured
//    match-to-catalog capability provider.
// 3. Return the provider's pick + the raw candidates.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUserId, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const matchToCatalogRouter = Router({ mergeParams: true });

const Body = z.object({
  catalog_id: z.string().uuid(),
  user_entity: z.record(z.unknown()),
  image_url: z.string().url().optional(),
  /** Override the configured default for this capability. */
  provider_id: z.string().optional(),
  model: z.string().optional(),
  /** Skip the LLM step and just return candidates. Useful from
   *  scripts that do their own ranking. */
  candidates_only: z.boolean().optional(),
  /** How many candidates to retrieve. Default 10. */
  top_k: z.number().int().positive().max(50).optional(),
});

matchToCatalogRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const k = parsed.data.top_k ?? 10;

    // Build the query string for trigram similarity. Use the entity's
    // name + any visible text we can extract from the payload.
    const ent = parsed.data.user_entity;
    const queryText = [
      typeof ent.name === "string" ? ent.name : null,
      typeof ent.title === "string" ? ent.title : null,
      typeof ent.description === "string" ? ent.description : null,
    ]
      .filter(Boolean)
      .join(" ");
    if (!queryText) {
      res.status(400).json({
        error: {
          code: "no_query_text",
          message: "user_entity needs at least one of name / title / description",
        },
      });
      return;
    }

    // Candidate pull via the kernel's catalog primitive — pg_trgm
    // similarity lives in core-catalogs's schema, so the kernel
    // owns the SQL. Modules don't reach across schemas.
    const rows = await platform().catalogs.similaritySearch({
      orgId: ctx.org.id,
      catalogId: parsed.data.catalog_id,
      queryText,
      limit: k,
    });
    const candidates = rows.map((r) => ({
      id: r.id,
      external_id: r.externalId,
      payload: r.payload,
      score: r.score,
    }));

    if (parsed.data.candidates_only) {
      res.json({ candidates });
      return;
    }
    if (candidates.length === 0) {
      res.json({ candidates: [], matches: [] });
      return;
    }

    // Hand off to the LLM. Bubble up provider/AI errors as 502.
    try {
      const aiRes = await platform().ai.invoke({
        orgId: ctx.org.id,
        userId: sessionUserId(req),
        capability: "match-to-catalog",
        input: {
          user_entity: parsed.data.user_entity,
          candidates: candidates.map((c) => ({
            candidate_id: c.id,
            external_id: c.external_id,
            payload: c.payload,
          })),
          image_url: parsed.data.image_url,
        },
        provider_id: parsed.data.provider_id,
        model: parsed.data.model,
      });
      const matches = parseMatches(aiRes.result);
      res.json({
        candidates,
        matches,
        provider_id: aiRes.provider_id,
        model: aiRes.model,
        cached: aiRes.cached,
        duration_ms: aiRes.duration_ms,
        cost_cents: aiRes.cost_cents,
      });
    } catch (err) {
      res.status(502).json({
        error: { code: "ai_failed", message: (err as Error).message },
        candidates,
      });
    }
  }),
);

interface LlmMatch {
  candidate_id: string;
  confidence: number;
}

/** The LLM response is a JSON string inside `.content` (or `.text`).
 *  Parse defensively — bad JSON is common and we fall back to an
 *  empty list rather than throwing. */
function parseMatches(result: unknown): LlmMatch[] {
  const raw =
    (typeof result === "object" && result !== null
      ? (result as { content?: string; text?: string }).content ??
        (result as { content?: string; text?: string }).text
      : undefined) ?? "";
  if (!raw) return [];
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return [];
    const json = JSON.parse(raw.slice(start, end + 1)) as { matches?: LlmMatch[] };
    return Array.isArray(json.matches) ? json.matches : [];
  } catch {
    return [];
  }
}
