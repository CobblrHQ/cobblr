// /api/v1/me — current session profile + org memberships. Mirrors
// the shape /auth/login returns so the web can reuse the same hook.

import { Router } from "express";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { mintTokenString } from "../auth/api-tokens.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import * as notifications from "../platform/notifications.js";
import * as activity from "../platform/activity.js";

export const meRouter = Router();

meRouter.get("/me", requireAuth, async (req, res) => {
  const userId = req.session!.id;
  const [user, orgs] = await Promise.all([
    meta
      .selectFrom("users")
      .select(["id", "email", "display_name", "must_reset_password"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow(),
    meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select(["o.id", "o.name", "o.slug", "m.role"])
      .where("m.user_id", "=", userId)
      .execute(),
  ]);
  return res.json({
    user: {
      ...user,
      auth_method: req.session!.auth_method,
      api_token_id: req.session!.api_token_id,
      is_platform_admin: req.session!.is_platform_admin,
    },
    orgs,
  });
});

// PATCH /me — update display_name (and in future preferences). email
// changes go through a separate flow because changing it has identity
// implications (auth token still valid; OIDC link still works; etc.)
// — not in v0.1.
const MeUpdate = z.object({
  display_name: z.string().min(1).max(160).optional(),
});
meRouter.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const parsed = MeUpdate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad patch", details: parsed.error.issues },
      });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: { code: "empty_patch", message: "Nothing to update" } });
      return;
    }
    const updated = await meta
      .updateTable("users")
      .set({
        ...(parsed.data.display_name !== undefined && {
          display_name: parsed.data.display_name.trim(),
        }),
      })
      .where("id", "=", req.session!.id)
      .returning(["id", "email", "display_name"])
      .executeTakeFirstOrThrow();
    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

// POST /me/password — verifies current password then updates.
const PasswordChange = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(200),
});
meRouter.post("/me/password", requireAuth, async (req, res, next) => {
  try {
    const parsed = PasswordChange.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues },
      });
      return;
    }
    const row = await meta
      .selectFrom("users")
      .select(["id", "password_hash"])
      .where("id", "=", req.session!.id)
      .executeTakeFirstOrThrow();
    const ok = await verifyPassword(parsed.data.current_password, row.password_hash);
    if (!ok) {
      res.status(403).json({
        error: { code: "bad_current_password", message: "Current password is incorrect." },
      });
      return;
    }
    const newHash = await hashPassword(parsed.data.new_password);
    await meta
      .updateTable("users")
      .set({ password_hash: newHash, must_reset_password: false })
      .where("id", "=", req.session!.id)
      .execute();
    // Activity-log to whichever workspace the user is a member of
    // (security-relevant action — was missing per 2026-05-25 audit).
    // Picking the first owned org is best-effort; a per-user audit
    // stream lives at /me/activity which UNIONs across all orgs.
    const firstOrg = await meta
      .selectFrom("org_memberships")
      .select("org_id")
      .where("user_id", "=", req.session!.id)
      .limit(1)
      .executeTakeFirst();
    if (firstOrg) {
      await activity
        .log({
          orgId: firstOrg.org_id,
          userId: req.session!.id,
          action: "password_changed",
          ref: { module: null, entityType: "user", entityId: req.session!.id },
        })
        .catch((err) => console.error("[me/password] activity log failed:", err));
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// M3 from BACKLOG: per-user activity feed unioned across every
// workspace the caller is a member of. The activity_log table has
// the (user_id, org_id) shape already, so this is one indexed query.
// Returns each row joined with the org's slug so the client can
// attribute "you tagged a part in 'Workshop'" vs "in 'Lego'".
meRouter.get("/me/activity", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    // Optional explicit ?org=<slug> narrows to one workspace; default
    // is "across all of mine."
    const orgFilter = typeof req.query.org === "string" ? req.query.org : null;
    let q = meta
      .selectFrom("activity_log as a")
      .innerJoin("orgs as o", "o.id", "a.org_id")
      .innerJoin("org_memberships as m", "m.org_id", "a.org_id")
      .select([
        "a.id as id",
        "a.action as action",
        "a.module_name as module",
        "a.entity_type as entity_type",
        "a.entity_id as entity_id",
        "a.diff as diff",
        "a.occurred_at as occurred_at",
        "o.id as org_id",
        "o.name as org_name",
        "o.slug as org_slug",
      ])
      .where("m.user_id", "=", userId)
      .orderBy("a.occurred_at", "desc")
      .limit(limit);
    if (orgFilter) q = q.where("o.slug", "=", orgFilter);
    const items = await q.execute();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// ─────────── Cross-workspace notification inbox ────────────────────
// The header bell uses these so a notification dispatched against any
// of the user's workspaces is visible without first switching to that
// workspace. The per-org /orgs/:slug/notifications endpoints still
// exist for callers that want a slug-scoped view.

meRouter.get("/me/notifications", requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    const items = await notifications.listForUserAcrossOrgs(req.session!.id, {
      limit,
      unreadOnly,
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

meRouter.get("/me/notifications/unread-count", requireAuth, async (req, res, next) => {
  try {
    const count = await notifications.unreadCountAcrossOrgs(req.session!.id);
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/notifications/:id/read", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    await notifications.markRead(id, req.session!.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/notifications/read-all", requireAuth, async (req, res, next) => {
  try {
    const count = await notifications.markAllReadAcrossOrgs(req.session!.id);
    res.json({ count });
  } catch (err) {
    next(err);
  }
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

// M1: cross-workspace sharing endpoints. Source-org owners create
// pending links; target-org owners accept; either side revokes. When
// source and target are owned by the same user, accept is automatic.

const LinkCreate = z.object({
  source_org_id: z.string().uuid(),
  target_org_id: z.string().uuid(),
  kinds: z.array(z.string().min(1)).min(1),
  /** Optional ISO 8601 timestamp. Null/omitted = never expires. */
  expires_at: z.string().datetime().nullable().optional(),
  /** M1 v0.5: gate cross-workspace reads on target-side role.
   *  null/omitted = no restriction (every target member can read). */
  min_target_role: z
    .enum(["owner", "admin", "member", "guest"])
    .nullable()
    .optional(),
});

async function userOwns(userId: string, orgId: string): Promise<boolean> {
  const r = await meta
    .selectFrom("org_memberships")
    .select("role")
    .where("user_id", "=", userId)
    .where("org_id", "=", orgId)
    .executeTakeFirst();
  return r?.role === "owner";
}

meRouter.post("/me/links", requireAuth, async (req, res, next) => {
  try {
    const parsed = LinkCreate.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues },
      });
      return;
    }
    const userId = req.session!.id;
    const { source_org_id, target_org_id, kinds, expires_at } = parsed.data;
    if (source_org_id === target_org_id) {
      res.status(400).json({
        error: { code: "self_link", message: "Source and target must be different workspaces." },
      });
      return;
    }
    // Caller must own the SOURCE (you can't share someone else's data).
    if (!(await userOwns(userId, source_org_id))) {
      res.status(403).json({
        error: { code: "forbidden", message: "Only the source workspace's owner can share its data." },
      });
      return;
    }
    // Auto-accept when target is also owned by the same user.
    const autoAccept = await userOwns(userId, target_org_id);
    const expiresDate = expires_at ? new Date(expires_at) : null;
    if (expiresDate && expiresDate <= new Date()) {
      res.status(400).json({
        error: { code: "expires_in_past", message: "expires_at must be in the future." },
      });
      return;
    }
    const row = await meta
      .insertInto("workspace_links")
      .values({
        source_org_id,
        target_org_id,
        kinds,
        status: autoAccept ? "active" : "pending",
        created_by: userId,
        accepted_at: autoAccept ? new Date() : null,
        expires_at: expiresDate,
        min_target_role: parsed.data.min_target_role ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // M1 v0.3: notify every owner of the TARGET workspace when a
    // pending link lands. Auto-accept skips this (same user owns
    // both ends, no one to surprise). One notification per owner,
    // delivered via whatever channels each owner has subscribed to
    // (default in_app). Best-effort: any failure logs but doesn't
    // affect the create response.
    if (!autoAccept) {
      try {
        const [sourceOrg, targetOwners] = await Promise.all([
          meta
            .selectFrom("orgs")
            .select(["name"])
            .where("id", "=", source_org_id)
            .executeTakeFirstOrThrow(),
          meta
            .selectFrom("org_memberships")
            .select("user_id")
            .where("org_id", "=", target_org_id)
            .where("role", "=", "owner")
            .execute(),
        ]);
        await Promise.all(
          targetOwners.map((m) =>
            notifications.dispatch({
              orgId: target_org_id,
              userId: m.user_id,
              eventType: "workspace_links.pending",
              message: `${sourceOrg.name} wants to share ${kinds.length} entity kind${kinds.length === 1 ? "" : "s"} with this workspace.`,
              link_url: "/configuration/links",
              module: "core-notifications",
              entityType: "workspace_link",
              entityId: row.id,
            }),
          ),
        );
      } catch (err) {
        console.error("[me/links] pending-link notify failed:", err);
      }
    }

    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

meRouter.get("/me/links", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    // Every link where the user is owner of either side (so they see
    // both inbound and outbound). Joins org details for both sides
    // so the client can render workspace names directly.
    const rows = await meta
      .selectFrom("workspace_links as l")
      .innerJoin("orgs as so", "so.id", "l.source_org_id")
      .innerJoin("orgs as to", "to.id", "l.target_org_id")
      .leftJoin("org_memberships as ms", (join) =>
        join
          .onRef("ms.org_id", "=", "l.source_org_id")
          .on("ms.user_id", "=", userId),
      )
      .leftJoin("org_memberships as mt", (join) =>
        join
          .onRef("mt.org_id", "=", "l.target_org_id")
          .on("mt.user_id", "=", userId),
      )
      .select([
        "l.id as id",
        "l.kinds as kinds",
        "l.status as status",
        "l.created_at as created_at",
        "l.accepted_at as accepted_at",
        "l.revoked_at as revoked_at",
        "l.expires_at as expires_at",
        "l.min_target_role as min_target_role",
        "so.id as source_org_id",
        "so.name as source_org_name",
        "so.slug as source_org_slug",
        "to.id as target_org_id",
        "to.name as target_org_name",
        "to.slug as target_org_slug",
        "ms.role as source_role",
        "mt.role as target_role",
      ])
      .where((eb) =>
        eb.or([
          eb("ms.user_id", "=", userId),
          eb("mt.user_id", "=", userId),
        ]),
      )
      .orderBy("l.created_at", "desc")
      .execute();
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /me/links/:id — today only edits expires_at. Either side's
// owner can extend or set/clear expiry on an active link. Pending /
// revoked links can't be patched (their state machine carries the
// expiry meaning differently).
const LinkPatch = z.object({
  expires_at: z.string().datetime().nullable().optional(),
  min_target_role: z
    .enum(["owner", "admin", "member", "guest"])
    .nullable()
    .optional(),
});
meRouter.patch("/me/links/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = LinkPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad patch body", details: parsed.error.issues },
      });
      return;
    }
    const link = await meta
      .selectFrom("workspace_links")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!link) {
      res.status(404).json({ error: { code: "not_found", message: "Link not found" } });
      return;
    }
    if (link.status !== "active" && link.status !== "pending") {
      res.status(409).json({
        error: { code: "wrong_state", message: `Link is ${link.status}; edit only allowed on active/pending.` },
      });
      return;
    }
    const userId = req.session!.id;
    const ownsSource = await userOwns(userId, link.source_org_id);
    const ownsTarget = await userOwns(userId, link.target_org_id);
    if (!ownsSource && !ownsTarget) {
      res.status(403).json({
        error: { code: "forbidden", message: "Only owners on either side can edit." },
      });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.expires_at !== undefined) {
      const expiresDate = parsed.data.expires_at ? new Date(parsed.data.expires_at) : null;
      if (expiresDate && expiresDate <= new Date()) {
        res.status(400).json({
          error: { code: "expires_in_past", message: "expires_at must be in the future (use revoke to expire now)." },
        });
        return;
      }
      patch.expires_at = expiresDate;
    }
    if (parsed.data.min_target_role !== undefined) {
      patch.min_target_role = parsed.data.min_target_role;
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({
        error: { code: "empty_patch", message: "Provide at least one of expires_at, min_target_role." },
      });
      return;
    }
    const updated = await meta
      .updateTable("workspace_links")
      .set(patch as never)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/links/:id/accept", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const link = await meta
      .selectFrom("workspace_links")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!link) {
      res.status(404).json({ error: { code: "not_found", message: "Link not found" } });
      return;
    }
    if (link.status !== "pending") {
      res.status(409).json({
        error: { code: "wrong_state", message: `Link is ${link.status}, not pending.` },
      });
      return;
    }
    if (!(await userOwns(req.session!.id, link.target_org_id))) {
      res.status(403).json({
        error: { code: "forbidden", message: "Only the target workspace's owner can accept." },
      });
      return;
    }
    const updated = await meta
      .updateTable("workspace_links")
      .set({ status: "active", accepted_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    // M1 v0.3: tell the source workspace's owners their link was
    // accepted. Notification org_id is the source org's id since
    // that's the workspace they were sharing FROM.
    try {
      const [targetOrg, sourceOwners] = await Promise.all([
        meta
          .selectFrom("orgs")
          .select("name")
          .where("id", "=", updated.target_org_id)
          .executeTakeFirstOrThrow(),
        meta
          .selectFrom("org_memberships")
          .select("user_id")
          .where("org_id", "=", updated.source_org_id)
          .where("role", "=", "owner")
          .execute(),
      ]);
      await Promise.all(
        sourceOwners.map((m) =>
          notifications.dispatch({
            orgId: updated.source_org_id,
            userId: m.user_id,
            eventType: "workspace_links.accepted",
            message: `${targetOrg.name} accepted your workspace link.`,
            link_url: "/configuration/links",
            module: "core-notifications",
            entityType: "workspace_link",
            entityId: updated.id,
          }),
        ),
      );
    } catch (err) {
      console.error("[me/links] accepted notify failed:", err);
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/links/:id/revoke", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const link = await meta
      .selectFrom("workspace_links")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!link) {
      res.status(404).json({ error: { code: "not_found", message: "Link not found" } });
      return;
    }
    // Either side's owner can revoke.
    const userId = req.session!.id;
    const ownsSource = await userOwns(userId, link.source_org_id);
    const ownsTarget = await userOwns(userId, link.target_org_id);
    if (!ownsSource && !ownsTarget) {
      res.status(403).json({
        error: { code: "forbidden", message: "Only owners on either side can revoke." },
      });
      return;
    }
    await meta
      .updateTable("workspace_links")
      .set({ status: "revoked", revoked_at: new Date() })
      .where("id", "=", id)
      .execute();
    res.status(204).end();
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
