// /api/v1/me/ravelry — a user's Ravelry connection (read-only Basic-Auth creds)
// so we can import their stash + projects into the Yarn bundle (feedback
// a713b84c). The import action itself is mounted per-workspace (Stage 2).

import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { meta } from "../db/meta.js";
import { encryptCreds, decryptCreds } from "../db/crypto.js";
import { currentUser, RavelryError, type RavelryCreds } from "../platform/ravelry.js";

// NB: requireAuth is applied PER-ROUTE below, never router-level. This router is
// mounted with no path prefix (`v1.use(ravelryRouter)`), so a router-level
// `.use(requireAuth)` would run on EVERY /api/v1/* request and 401 the
// unauthenticated public endpoints (/qr, /public, /integrations webhooks)
// mounted after it. Keep the auth on the individual /me/ravelry routes.
export const ravelryRouter = Router();

function uid(req: Request): string {
  return (req as unknown as { session?: { id: string } }).session!.id;
}

/** Load + decrypt a user's Ravelry connection (for the import action). */
export async function loadRavelryConnection(
  userId: string,
): Promise<{ creds: RavelryCreds; username: string } | null> {
  const row = await meta
    .selectFrom("ravelry_connections")
    .select(["username", "credentials_encrypted"])
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row?.username) return null;
  try {
    const creds = JSON.parse(decryptCreds(row.credentials_encrypted)) as RavelryCreds;
    if (!creds.access_key || !creds.personal_key) return null;
    return { creds, username: row.username };
  } catch {
    return null;
  }
}

// GET /me/ravelry — connection status (never the secret).
ravelryRouter.get("/me/ravelry", requireAuth, async (req, res, next) => {
  try {
    const row = await meta
      .selectFrom("ravelry_connections")
      .select(["username", "verified_at"])
      .where("user_id", "=", uid(req))
      .executeTakeFirst();
    res.json({ connected: !!row, username: row?.username ?? null, verified_at: row?.verified_at ?? null });
  } catch (err) {
    next(err);
  }
});

const Connect = z.object({
  access_key: z.string().min(1).max(200),
  personal_key: z.string().min(1).max(200),
});

// POST /me/ravelry/connect — verify the creds against Ravelry (/current_user)
// then store them encrypted + the resolved username.
ravelryRouter.post("/me/ravelry/connect", requireAuth, async (req, res, next) => {
  try {
    const parsed = Connect.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Need access_key + personal_key." } });
      return;
    }
    const creds: RavelryCreds = {
      access_key: parsed.data.access_key.trim(),
      personal_key: parsed.data.personal_key.trim(),
    };
    let me: { username: string } | null;
    try {
      me = await currentUser(creds);
    } catch (e) {
      const status = e instanceof RavelryError ? e.status : 0;
      res.status(400).json({
        error: {
          code: "verify_failed",
          message: status === 401 ? "Ravelry rejected those credentials." : "Couldn't reach Ravelry — check the keys and try again.",
        },
      });
      return;
    }
    if (!me) {
      res.status(400).json({ error: { code: "no_user", message: "Couldn't resolve your Ravelry account from those keys." } });
      return;
    }
    const enc = encryptCreds(JSON.stringify(creds));
    const now = new Date();
    await meta
      .insertInto("ravelry_connections")
      .values({ user_id: uid(req), username: me.username, credentials_encrypted: enc, verified_at: now })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({ username: me!.username, credentials_encrypted: enc, verified_at: now, updated_at: now }),
      )
      .execute();
    res.json({ connected: true, username: me.username });
  } catch (err) {
    next(err);
  }
});

// DELETE /me/ravelry — disconnect (drops the stored creds).
ravelryRouter.delete("/me/ravelry", requireAuth, async (req, res, next) => {
  try {
    await meta.deleteFrom("ravelry_connections").where("user_id", "=", uid(req)).execute();
    res.json({ connected: false });
  } catch (err) {
    next(err);
  }
});
