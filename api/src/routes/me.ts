// /api/v1/me — current session profile + org memberships. Mirrors
// the shape /auth/login returns so the web can reuse the same hook.

import { Router } from "express";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { mintTokenString } from "../auth/api-tokens.js";

export const meRouter = Router();

meRouter.get("/me", requireAuth, async (req, res) => {
  const userId = req.session!.id;
  const orgs = await meta
    .selectFrom("org_memberships as m")
    .innerJoin("orgs as o", "o.id", "m.org_id")
    .select(["o.id", "o.name", "o.slug", "m.role"])
    .where("m.user_id", "=", userId)
    .execute();
  return res.json({ user: req.session, orgs });
});

// ──────────────────────── API tokens ─────────────────────────────

const TokenCreate = z.object({
  name: z.string().min(1).max(120),
  /** ISO timestamp; if omitted, the token never expires. */
  expires_at: z.string().datetime().optional(),
});

// List the user's tokens. Plaintext is NEVER returned here — only on
// the mint endpoint, and only once.
meRouter.get("/me/api-tokens", requireAuth, async (req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("api_tokens")
      .select([
        "id", "name", "token_prefix", "expires_at",
        "last_used_at", "revoked_at", "created_at",
      ])
      .where("user_id", "=", req.session!.id)
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/api-tokens", requireAuth, async (req, res, next) => {
  try {
    const parsed = TokenCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues },
      });
      return;
    }
    const { plaintext, hash, tokenPrefix } = mintTokenString();
    const inserted = await meta
      .insertInto("api_tokens")
      .values({
        user_id: req.session!.id,
        name: parsed.data.name.trim(),
        token_hash: hash,
        token_prefix: tokenPrefix,
        expires_at: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
      })
      .returning(["id", "name", "token_prefix", "expires_at", "created_at"])
      .executeTakeFirstOrThrow();
    // Plaintext goes back exactly once. The DB only ever has the hash.
    res.status(201).json({ ...inserted, token: plaintext });
  } catch (err) {
    next(err);
  }
});

// Revoke (soft delete — keeps history for the activity log / audit).
meRouter.delete("/me/api-tokens/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const updated = await meta
      .updateTable("api_tokens")
      .set({ revoked_at: new Date() })
      .where("id", "=", id)
      .where("user_id", "=", req.session!.id)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "Token not found or already revoked" } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
