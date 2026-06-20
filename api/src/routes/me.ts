// /api/v1/me — current session profile + org memberships. Mirrors
// the shape /auth/login returns so the web can reuse the same hook.

import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { mintTokenString } from "../auth/api-tokens.js";
import { listScopeChoices, sanitizeScopes } from "../auth/scopes.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signSession } from "../auth/jwt.js";
import * as notifications from "../platform/notifications.js";
import * as activity from "../platform/activity.js";
import { hasAuthEmailSender, sendAuthEmail } from "../platform/hosted-seams.js";
import { selfServeInvitesEnabled } from "../auth/signup-gate.js";
import { issueAndSendVerifyEmail } from "./auth.js";
import {
  discordOAuthConfigured,
  discordInviteUrl,
  signOAuthState,
  verifyOAuthState,
  discordAuthorizeUrl,
  exchangeCodeForIdentity,
} from "../platform/discord-oauth.js";
import { sendDiscordDm } from "../platform/discord-bot-trigger.js";
import { publicBaseUrl } from "../platform/public-url.js";
import {
  NOTIFICATION_TYPES,
  PREF_CHANNELS,
  isTier2,
  isPrefChannel,
} from "../platform/notification-catalog.js";

export const meRouter = Router();

meRouter.get("/me", requireAuth, async (req, res) => {
  const userId = req.session!.id;
  const [user, orgs] = await Promise.all([
    meta
      .selectFrom("users")
      .select(["id", "email", "display_name", "must_reset_password", "email_verified_at"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow(),
    meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select((eb) => ["o.id", "o.name", "o.slug", "o.app_mode", "o.focused", "m.role", "m.position", eb.selectFrom("org_memberships as om").innerJoin("users as ou", "ou.id", "om.user_id").select("ou.display_name").whereRef("om.org_id", "=", "o.id").where("om.role", "=", "owner").limit(1).as("owner_name")])
      .where("m.user_id", "=", userId)
      .orderBy("m.position", "asc")
      .orderBy("m.joined_at", "asc")
      .execute(),
  ]);
  const { email_verified_at, ...rest } = user;
  return res.json({
    user: {
      ...rest,
      email_verified: email_verified_at !== null,
      auth_method: req.session!.auth_method,
      api_token_id: req.session!.api_token_id,
      is_platform_admin: req.session!.is_platform_admin,
      // Community link for the signed-in chrome (account menu, feedback modal);
      // null unless DISCORD_INVITE_URL is configured.
      discord_invite_url: discordInviteUrl() || null,
    },
    orgs,
  });
});

// PATCH /me/workspaces/order — set the signed-in user's switcher order. Body:
// { slugs: [...] } — the user's workspaces in the desired order. Per-USER (each
// person arranges their own switcher), so it writes org_memberships.position for
// THIS user only. Slugs not belonging to the user are ignored; any of the user's
// workspaces omitted from the list keep their relative order after the listed
// ones (so a partial list — e.g. only the owned group — is safe).
const ReorderBody = z.object({ slugs: z.array(z.string()).max(500) });
meRouter.patch("/me/workspaces/order", requireAuth, async (req, res, next) => {
  try {
    const parsed = ReorderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const userId = req.session!.id;
    // The user's memberships joined to slugs — the source of truth for what they
    // may reorder. Keep current order as the tiebreak for anything not listed.
    const mine = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select(["m.org_id", "o.slug"])
      .where("m.user_id", "=", userId)
      .orderBy("m.position", "asc")
      .orderBy("m.joined_at", "asc")
      .execute();
    const idBySlug = new Map(mine.map((r) => [r.slug, r.org_id]));
    // Final order: the requested slugs first (those the user actually has), then
    // any of their workspaces the request didn't mention, in their existing order.
    const requested = parsed.data.slugs.filter((s) => idBySlug.has(s));
    const ordered = [...requested, ...mine.map((r) => r.slug).filter((s) => !requested.includes(s))];
    await meta.transaction().execute(async (trx) => {
      for (let i = 0; i < ordered.length; i++) {
        await trx
          .updateTable("org_memberships")
          .set({ position: i })
          .where("user_id", "=", userId)
          .where("org_id", "=", idBySlug.get(ordered[i]!)!)
          .execute();
      }
    });
    res.json({ ok: true, order: ordered });
  } catch (err) {
    next(err);
  }
});

// POST /me/verify-email/resend — re-send the email-verification link to the
// signed-in user's address. No-op-ish if already verified. Returns the dev
// link in non-prod when no auth-email sender is configured.
meRouter.post("/me/verify-email/resend", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    const user = await meta
      .selectFrom("users")
      .select(["email", "email_verified_at"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    if (user.email_verified_at) {
      res.json({ ok: true, already_verified: true });
      return;
    }
    const { emailed, devToken } = await issueAndSendVerifyEmail(userId, user.email, req);
    res.json({
      ok: true,
      emailed,
      ...(devToken && { dev_token: devToken, dev_link: `/verify/${devToken}` }),
    });
  } catch (err) {
    next(err);
  }
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
    // Revoke all existing session/app JWTs (other devices, any stolen token)
    // by stamping the cutoff, then re-mint a fresh token for THIS device so
    // the user isn't logged out by their own password change. Audit #6.
    const changedAt = new Date();
    await meta
      .updateTable("users")
      .set({ password_hash: newHash, must_reset_password: false, tokens_valid_from: changedAt })
      .where("id", "=", req.session!.id)
      .execute();
    const freshToken = await signSession(req.session!.id);
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
    // Return the re-minted token so the client can keep THIS session alive
    // (all prior tokens were just revoked). Clients that ignore it simply get
    // logged out on their next request — also safe.
    res.status(200).json({ token: freshToken });
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

// ─────────────────── Notification channel bindings ──────────────────
//
// A "channel binding" = one row in notification_subscriptions.
// CRUD here, scoped to the active workspace, owned by the user.
// Config validation depends on channel — see ChannelConfigSchemas.
//
// Subscription unique key: (user_id, org_id, event_type, channel).
// Use event_type = '*' for wildcard (all events).

const ChannelEnum = z.enum([
  "in_app",
  "browser_push",
  "email",
  "discord",
  "webhook",
  "slack",
  "sms",
]);
const PriorityEnum = z.enum(["low", "normal", "high", "urgent"]);

// Channel-specific config validators. The dispatcher's drivers
// re-validate at delivery time (so a row with stale config doesn't
// blow up the dispatcher), but we validate at write time too so
// users get immediate feedback when they paste a malformed URL.
const ChannelConfigSchemas: Record<string, z.ZodTypeAny> = {
  in_app: z.object({}).strict(),
  browser_push: z.object({}).strict(),
  discord: z.object({
    webhook_url: z
      .string()
      .url()
      .regex(/^https:\/\/discord\.com\/api\/webhooks\//, {
        message: "must be a https://discord.com/api/webhooks/... URL",
      }),
  }),
  slack: z.object({
    webhook_url: z
      .string()
      .url()
      .regex(/^https:\/\/hooks\.slack\.com\//, {
        message: "must be a https://hooks.slack.com/... URL",
      }),
  }),
  webhook: z.object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  // Pick a delivery provider; SMTP or an HTTP transactional API. `provider`
  // defaults to "smtp" so configs written before the API providers existed
  // (no `provider` key) keep validating. Each member strips fields from the
  // other providers, so switching provider can't leak stale creds.
  email: z.preprocess(
    (v) =>
      v && typeof v === "object" && !("provider" in (v as object))
        ? { ...(v as object), provider: "smtp" }
        : v,
    z.discriminatedUnion("provider", [
      z.object({
        provider: z.literal("smtp"),
        from: z.string().email(),
        to: z.string().email(),
        smtp_host: z.string().min(1).max(255),
        smtp_port: z.number().int().min(1).max(65535).optional(),
        smtp_user: z.string().min(1).max(255),
        smtp_pass: z.string().min(1).max(255),
        smtp_secure: z.boolean().optional(),
      }),
      z.object({
        provider: z.literal("mailgun"),
        from: z.string().email(),
        to: z.string().email(),
        mailgun_api_key: z.string().min(1).max(255),
        mailgun_domain: z.string().min(1).max(255),
        mailgun_eu: z.boolean().optional(),
      }),
      z.object({
        provider: z.literal("resend"),
        from: z.string().email(),
        to: z.string().email(),
        resend_api_key: z.string().min(1).max(255),
      }),
      z.object({
        provider: z.literal("postmark"),
        from: z.string().email(),
        to: z.string().email(),
        postmark_token: z.string().min(1).max(255),
      }),
    ]),
  ),
  sms: z.object({
    account_sid: z.string().regex(/^AC[a-f0-9]{32}$/i, {
      message: "must be a Twilio Account SID (ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)",
    }),
    auth_token: z.string().min(20).max(64),
    from_number: z.string().regex(/^\+[1-9]\d{1,14}$/),
    to_number: z.string().regex(/^\+[1-9]\d{1,14}$/),
  }),
};

const ChannelBindingBody = z.object({
  org_id: z.string().uuid(),
  /** '*' wildcard or any event_type literal. */
  event_type: z.string().min(1).max(120),
  channel: ChannelEnum,
  enabled: z.boolean().optional().default(true),
  min_priority: PriorityEnum.optional().default("low"),
  /** Channel-specific config — see ChannelConfigSchemas. */
  config: z.unknown().optional(),
});

meRouter.get(
  "/me/notification-channels",
  requireAuth,
  async (req, res, next) => {
    try {
      const orgId = String(req.query.org_id ?? "");
      if (!orgId) {
        res.status(400).json({
          error: { code: "missing_org_id", message: "?org_id=<uuid> required" },
        });
        return;
      }
      // Caller must be a member of the workspace.
      const member = await meta
        .selectFrom("org_memberships")
        .select("user_id")
        .where("user_id", "=", req.session!.id)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (!member) {
        res.status(404).json({
          error: { code: "not_a_member", message: "Workspace not found." },
        });
        return;
      }
      const rows = await meta
        .selectFrom("notification_subscriptions")
        .select([
          "id",
          "event_type",
          "channel",
          "enabled",
          "min_priority",
          "config",
        ])
        .where("user_id", "=", req.session!.id)
        .where("org_id", "=", orgId)
        .orderBy("event_type", "asc")
        .orderBy("channel", "asc")
        .execute();
      // Hide secrets in the response — config can contain SMTP
      // passwords, Twilio auth tokens, webhook URLs that ARE the
      // secret. Replace each value with `<set>` so the UI can show
      // "configured" without re-exposing the raw bytes.
      const items = rows.map((r) => ({
        ...r,
        config: redactConfig(r.config),
      }));
      res.json({ items });
    } catch (err) {
      next(err);
    }
  },
);

/** Replace secret-ish config values with `<set>` markers so the
 *  list endpoint doesn't re-expose them once written. The UI sends
 *  the raw values back on update only if the user actually changed
 *  the field. */
function redactConfig(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;
  const SECRET_KEYS = new Set([
    "webhook_url",
    "url",
    "smtp_pass",
    "auth_token",
    "headers",
    "mailgun_api_key",
    "resend_api_key",
    "postmark_token",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k) && v !== null && v !== undefined && v !== "") {
      out[k] = "<set>";
    } else {
      out[k] = v;
    }
  }
  return out;
}

meRouter.post(
  "/me/notification-channels",
  requireAuth,
  async (req, res, next) => {
    try {
      const parsed = ChannelBindingBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad subscription payload", details: parsed.error.issues },
        });
        return;
      }
      // Caller must be a member.
      const member = await meta
        .selectFrom("org_memberships")
        .select("user_id")
        .where("user_id", "=", req.session!.id)
        .where("org_id", "=", parsed.data.org_id)
        .executeTakeFirst();
      if (!member) {
        res.status(404).json({
          error: { code: "not_a_member", message: "Workspace not found." },
        });
        return;
      }
      // Validate channel-specific config shape.
      const schema = ChannelConfigSchemas[parsed.data.channel];
      let validatedConfig: unknown;
      if (schema) {
        const r = schema.safeParse(parsed.data.config ?? {});
        if (!r.success) {
          res.status(400).json({
            error: {
              code: "invalid_channel_config",
              message: `Bad config for channel '${parsed.data.channel}'`,
              details: r.error.issues,
            },
          });
          return;
        }
        validatedConfig = r.data;
      } else {
        validatedConfig = parsed.data.config ?? null;
      }
      const row = await meta
        .insertInto("notification_subscriptions")
        .values({
          user_id: req.session!.id,
          org_id: parsed.data.org_id,
          event_type: parsed.data.event_type,
          channel: parsed.data.channel,
          enabled: parsed.data.enabled,
          min_priority: parsed.data.min_priority,
          config: validatedConfig as never,
        })
        .onConflict((c) =>
          c
            .columns(["user_id", "org_id", "event_type", "channel"])
            .doUpdateSet({
              enabled: parsed.data.enabled,
              min_priority: parsed.data.min_priority,
              config: validatedConfig as never,
            }),
        )
        .returning(["id", "event_type", "channel", "enabled", "min_priority"])
        .executeTakeFirstOrThrow();
      res.status(201).json({
        ...row,
        config: redactConfig(validatedConfig),
      });
    } catch (err) {
      next(err);
    }
  },
);

meRouter.delete(
  "/me/notification-channels/:id",
  requireAuth,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const removed = await meta
        .deleteFrom("notification_subscriptions")
        .where("id", "=", id)
        .where("user_id", "=", req.session!.id)
        .returning("id")
        .executeTakeFirst();
      if (!removed) {
        res.status(404).json({ error: { code: "not_found", message: "Binding not found." } });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// Fire a test notification through ALL of the caller's bindings in
// the given workspace. Useful as a "did I configure my Discord
// webhook correctly?" probe. Returns the dispatch result so the UI
// can show which channels actually delivered.
// Per-binding test: POST /me/notification-channels/:id/test fires
// through exactly that one binding's channel. Doesn't touch the
// notifications table; doesn't trigger any other binding the user
// may have set up. Used by the per-row "test" button so a Discord
// webhook can be validated without spamming everyone else.
meRouter.post(
  "/me/notification-channels/:id/test",
  requireAuth,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({
          error: { code: "missing_id", message: "binding id required in path" },
        });
        return;
      }
      const priorityRaw = String(req.body?.priority ?? "normal");
      const priority = (["low", "normal", "high", "urgent"] as const).includes(
        priorityRaw as never,
      )
        ? (priorityRaw as "low" | "normal" | "high" | "urgent")
        : "normal";
      const result = await notifications.testOneBinding(id, req.session!.id, priority);
      if (result.ownerCheck === "not_found") {
        res.status(404).json({
          error: { code: "not_found", message: "Binding not found." },
        });
        return;
      }
      if (result.ownerCheck === "denied") {
        res.status(403).json({
          error: { code: "not_owner", message: "Not your binding." },
        });
        return;
      }
      res.json({ deliveredVia: result.deliveredVia });
    } catch (err) {
      next(err);
    }
  },
);

// "Test all" = fire a test through EVERY binding in the workspace,
// regardless of each binding's event_type. We can't get there with
// dispatch() because dispatch routes by event_type matching, and a
// user whose bindings are scoped to specific events (e.g.
// 'order.shipped') wouldn't see ANY binding fire on a synthetic
// 'test.notification' event. Iterate bindings + call the per-binding
// path directly so the button does what its label promises.
meRouter.post(
  "/me/notification-channels/test",
  requireAuth,
  async (req, res, next) => {
    try {
      const orgId = String(req.body?.org_id ?? "");
      if (!orgId) {
        res.status(400).json({
          error: { code: "missing_org_id", message: "{ org_id } required in body" },
        });
        return;
      }
      const member = await meta
        .selectFrom("org_memberships")
        .select("user_id")
        .where("user_id", "=", req.session!.id)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (!member) {
        res.status(404).json({
          error: { code: "not_a_member", message: "Workspace not found." },
        });
        return;
      }
      const priorityRaw = String(req.body?.priority ?? "normal");
      const priority = (["low", "normal", "high", "urgent"] as const).includes(
        priorityRaw as never,
      )
        ? (priorityRaw as "low" | "normal" | "high" | "urgent")
        : "normal";

      // Pull every enabled binding the user owns in this workspace
      // whose threshold the test priority meets. Fire each via the
      // per-binding driver path so we hit each binding's actual
      // channel + config regardless of event_type matching.
      const PRIORITY_ORDER = { low: 0, normal: 1, high: 2, urgent: 3 } as const;
      const bindings = await meta
        .selectFrom("notification_subscriptions")
        .select(["id", "channel", "min_priority"])
        .where("user_id", "=", req.session!.id)
        .where("org_id", "=", orgId)
        .where("enabled", "=", true)
        .execute();
      const reached = bindings.filter(
        (b) => PRIORITY_ORDER[priority] >= PRIORITY_ORDER[b.min_priority],
      );
      const results = await Promise.all(
        reached.map((b) =>
          notifications.testOneBinding(b.id, req.session!.id, priority),
        ),
      );
      const deliveredVia = Array.from(
        new Set(results.flatMap((r) => r.deliveredVia)),
      );
      res.json({
        deliveredVia,
        attempted: reached.length,
        skippedByThreshold: bindings.length - reached.length,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ──────────────────────── API tokens ─────────────────────────────

const TokenCreate = z.object({
  name: z.string().min(1).max(120),
  /** ISO timestamp; if omitted, the token never expires. */
  expires_at: z.string().datetime().optional(),
  /** Capability scopes. Omitted/empty = unrestricted (legacy full access).
   *  Unknown keys are dropped server-side (sanitizeScopes). */
  scopes: z.array(z.string().max(80)).max(20).optional(),
});

// The capability scopes a token can be minted with (secret-free; for the
// mint UI). Static, but served so the UI never drifts from the server.
meRouter.get("/me/api-token-scopes", requireAuth, (_req, res) => {
  res.json({ items: listScopeChoices() });
});

// List the user's tokens. Plaintext is NEVER returned here — only on
// the mint endpoint, and only once.
meRouter.get("/me/api-tokens", requireAuth, async (req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("api_tokens")
      .select([
        "id", "name", "token_prefix", "expires_at",
        "last_used_at", "revoked_at", "created_at", "scopes",
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
    const cleanScopes = parsed.data.scopes ? sanitizeScopes(parsed.data.scopes) : [];
    const inserted = await meta
      .insertInto("api_tokens")
      .values({
        user_id: req.session!.id,
        name: parsed.data.name.trim(),
        token_hash: hash,
        token_prefix: tokenPrefix,
        expires_at: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
        // Empty → NULL = unrestricted (legacy). Non-empty = deny-by-default.
        scopes: cleanScopes.length > 0 ? cleanScopes : null,
      })
      .returning(["id", "name", "token_prefix", "expires_at", "created_at", "scopes"])
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
              // Workspace-link is a KERNEL feature, not the notifications
              // module — don't misattribute the audit row. Matches the sibling
              // dispatch at :1068. (Regression of the 2026-05-26 fix #4.)
              module: undefined,
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
            // workspace_links is a kernel feature, not a module — leave
            // module attribution null so the UI shows "platform" rather
            // than misattributing to whichever module happens to own
            // notifications.
            module: undefined,
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

// ───────────── Invite a friend to Cobblr (their OWN workspace) ─────────────
// The growth path that used to be super-admin-only: any user who OWNS a
// workspace can mint a single-use link that lets a NEW person sign up past the
// closed public-signup gate and get their OWN fresh workspace — distinct from a
// workspace invite (POST /orgs/:slug/members/invites), which instead drops the
// person into the inviter's workspace as a member. Reuses signup_invites (the
// `/join/:token` accept flow already provisions a fresh workspace); attributed
// via created_by and capped so one account can't mint unbounded signups while
// the platform is invite-only.

const FriendInvite = z.object({
  email: z.string().email().max(255).optional(),
  note: z.string().max(200).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});
// Deliberately low for alpha — the on/off switch (selfServeInvitesEnabled) is
// the primary control; this caps the rate per owner once it's open.
const OPEN_FRIEND_INVITE_CAP = 5;

function signupInviteStatus(r: {
  consumed_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date | null;
}): "consumed" | "revoked" | "expired" | "open" {
  if (r.consumed_at) return "consumed";
  if (r.revoked_at) return "revoked";
  if (r.expires_at && new Date(r.expires_at) < new Date()) return "expired";
  return "open";
}

async function ownsAnyWorkspace(userId: string): Promise<boolean> {
  const r = await meta
    .selectFrom("org_memberships")
    .select("user_id")
    .where("user_id", "=", userId)
    .where("role", "=", "owner")
    .executeTakeFirst();
  return !!r;
}

meRouter.post("/me/signup-invites", requireAuth, async (req, res, next) => {
  try {
    // Off by default in prod — keeps the alpha from growing uncontrollably.
    if (!selfServeInvitesEnabled()) {
      res.status(403).json({
        error: { code: "not_enabled", message: "Inviting new people to Cobblr is turned off right now." },
      });
      return;
    }
    const userId = req.session!.id;
    if (!(await ownsAnyWorkspace(userId))) {
      res.status(403).json({
        error: { code: "forbidden", message: "Only workspace owners can invite new people to Cobblr." },
      });
      return;
    }
    const parsed = FriendInvite.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad invite", details: parsed.error.issues } });
      return;
    }
    // Cap unused invites per user so an account can't mint unbounded signups.
    const open = await meta
      .selectFrom("signup_invites")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("created_by", "=", userId)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (Number(open?.n ?? 0) >= OPEN_FRIEND_INVITE_CAP) {
      res.status(429).json({
        error: {
          code: "invite_cap",
          message: `You already have ${OPEN_FRIEND_INVITE_CAP} unused invites — revoke some before minting more.`,
        },
      });
      return;
    }
    const token = randomBytes(24).toString("base64url");
    const expires_at = parsed.data.expires_in_days
      ? new Date(Date.now() + parsed.data.expires_in_days * 86_400_000)
      : null;
    const row = await meta
      .insertInto("signup_invites")
      .values({
        token,
        created_by: userId,
        invited_email: parsed.data.email?.toLowerCase().trim() ?? null,
        note: parsed.data.note ?? null,
        expires_at,
      })
      .returning(["id", "token", "invited_email", "note", "expires_at", "created_at"])
      .executeTakeFirstOrThrow();

    // If we have an address + a registered sender, email the join link straight
    // to the invitee; otherwise the owner copies the link by hand.
    let emailed = false;
    if (row.invited_email && hasAuthEmailSender()) {
      const link = `${req.protocol}://${req.get("host") ?? ""}/join/${row.token}`;
      const expiryLine = row.expires_at
        ? `\n\nThis invite expires ${new Date(row.expires_at).toUTCString()}.`
        : "";
      emailed = await sendAuthEmail({
        to: row.invited_email,
        subject: "You're invited to Cobblr",
        text:
          `You've been invited to create your own Cobblr workspace.\n\n` +
          `Open this link to get started:\n${link}` +
          expiryLine +
          `\n\nIf you weren't expecting this, you can ignore this email.`,
        kind: "invite",
      });
    }
    res.status(201).json({ ...row, status: "open", emailed });
  } catch (err) {
    next(err);
  }
});

meRouter.get("/me/signup-invites", requireAuth, async (req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("signup_invites")
      .select(["id", "token", "invited_email", "note", "expires_at", "consumed_at", "revoked_at", "created_at"])
      .where("created_by", "=", req.session!.id)
      .orderBy("created_at", "desc")
      .execute();
    res.json({ items: rows.map((r) => ({ ...r, status: signupInviteStatus(r) })) });
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/signup-invites/:id/revoke", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const updated = await meta
      .updateTable("signup_invites")
      .set({ revoked_at: new Date() })
      .where("id", "=", id)
      .where("created_by", "=", req.session!.id)
      .where("consumed_at", "is", null)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "Invite not found or already used/revoked." } });
      return;
    }
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

// ───────────────────────── Discord connection (Feature 1) ─────────────────────
// Link a user's Discord identity (OAuth `identify`) so the bot can DM them, and
// confirm reachability with a VERIFIED test DM before the discord_dm channel is
// ever relied on. All endpoints no-op gracefully when the Discord app isn't
// configured (open core / self-host without Discord).

const DISCORD_VERIFY_TTL_MS = 30 * 60 * 1000;

async function fireDiscordTestDm(discordUserId: string, displayName: string | null): Promise<{ deliverable: boolean }> {
  const token = randomBytes(24).toString("base64url");
  await meta
    .updateTable("discord_connections")
    .set({ verify_token: token, verify_expires_at: new Date(Date.now() + DISCORD_VERIFY_TTL_MS), updated_at: new Date() })
    .where("discord_user_id", "=", discordUserId)
    .execute();
  const hi = displayName ? `Hi ${displayName}! ` : "Hi! ";
  const res = await sendDiscordDm({
    discord_user_id: discordUserId,
    text: `${hi}This is Cobblr confirming we can reach you here. Tap the button below to turn on Discord notifications.`,
    verify_token: token,
  });
  return { deliverable: res.deliverable };
}

// GET /me/discord — connection + verification status (drives the settings UI).
meRouter.get("/me/discord", requireAuth, async (req, res, next) => {
  try {
    const row = await meta
      .selectFrom("discord_connections")
      .select(["discord_user_id", "discord_username", "verified"])
      .where("user_id", "=", req.session!.id)
      .executeTakeFirst();
    res.json({
      configured: discordOAuthConfigured(),
      connected: Boolean(row?.discord_user_id),
      verified: Boolean(row?.verified),
      username: row?.discord_username ?? null,
      invite_url: discordInviteUrl() || null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /me/discord/oauth-start — returns the Discord authorize URL.
meRouter.post("/me/discord/oauth-start", requireAuth, async (req, res, next) => {
  try {
    if (!discordOAuthConfigured()) {
      res.status(503).json({ error: { code: "not_configured", message: "Discord isn't set up on this server yet." } });
      return;
    }
    const state = await signOAuthState(req.session!.id);
    res.json({ url: discordAuthorizeUrl(state) });
  } catch (err) {
    next(err);
  }
});

// GET /me/discord/oauth-callback — Discord redirects here. Exchange for the
// identity, store it UNVERIFIED, fire the test DM, bounce back to settings in a
// waiting/blocked state. Browser redirect → never 4xx; carry status in a query.
meRouter.get("/me/discord/oauth-callback", async (req, res, next) => {
  const settings = `${publicBaseUrl()}/me/communication`;
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const userId = state ? await verifyOAuthState(state) : null;
    if (!code || !userId) {
      res.redirect(`${settings}?discord=error`);
      return;
    }
    const identity = await exchangeCodeForIdentity(code);
    if (!identity) {
      res.redirect(`${settings}?discord=error`);
      return;
    }
    await meta
      .insertInto("discord_connections")
      .values({
        user_id: userId,
        discord_user_id: identity.id,
        discord_username: identity.username,
        verified: false,
        connected_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((c) =>
        c.column("user_id").doUpdateSet({
          discord_user_id: identity.id,
          discord_username: identity.username,
          verified: false,
          connected_at: new Date(),
          updated_at: new Date(),
        }),
      )
      .execute();
    const { deliverable } = await fireDiscordTestDm(identity.id, null);
    res.redirect(`${settings}?discord=${deliverable ? "pending" : "blocked"}`);
  } catch (err) {
    try {
      res.redirect(`${settings}?discord=error`);
    } catch {
      next(err);
    }
  }
});

// POST /me/discord/retry-test — re-send the verification DM (after the user
// adjusts privacy settings / joins the server).
meRouter.post("/me/discord/retry-test", requireAuth, async (req, res, next) => {
  try {
    const row = await meta
      .selectFrom("discord_connections")
      .select(["discord_user_id"])
      .where("user_id", "=", req.session!.id)
      .executeTakeFirst();
    if (!row?.discord_user_id) {
      res.status(400).json({ error: { code: "not_connected", message: "Connect Discord first." } });
      return;
    }
    const { deliverable } = await fireDiscordTestDm(row.discord_user_id, null);
    res.json({ deliverable });
  } catch (err) {
    next(err);
  }
});

// POST /me/discord/confirm — website fallback "Yes, I received it" (the user
// self-attests; safe because it only verifies their OWN connection).
meRouter.post("/me/discord/confirm", requireAuth, async (req, res, next) => {
  try {
    const updated = await meta
      .updateTable("discord_connections")
      .set({ verified: true, verify_token: null, verify_expires_at: null, updated_at: new Date() })
      .where("user_id", "=", req.session!.id)
      .where("discord_user_id", "is not", null)
      .returning("user_id")
      .executeTakeFirst();
    if (!updated) {
      res.status(400).json({ error: { code: "not_connected", message: "Connect Discord first." } });
      return;
    }
    res.json({ ok: true, verified: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /me/discord — disconnect.
meRouter.delete("/me/discord", requireAuth, async (req, res, next) => {
  try {
    await meta.deleteFrom("discord_connections").where("user_id", "=", req.session!.id).execute();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ───────────────── Communication Preferences matrix (Feature 1) ───────────────
// GET /me/communication-prefs — notification types (tier 1 locked / tier 2
// configurable) × channels, with the user's current enablement.
meRouter.get("/me/communication-prefs", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    const conn = await meta
      .selectFrom("discord_connections")
      .select(["verified"])
      .where("user_id", "=", userId)
      .executeTakeFirst();
    const prefs: Record<string, Record<string, boolean>> = {};
    for (const t of NOTIFICATION_TYPES) {
      if (t.tier !== 2) continue;
      prefs[t.key] = await notifications.resolveAccountPrefs(userId, t.key);
    }
    res.json({
      channels: PREF_CHANNELS,
      discord_verified: Boolean(conn?.verified),
      types: NOTIFICATION_TYPES.map((t) => ({ key: t.key, label: t.label, description: t.description, tier: t.tier })),
      prefs,
    });
  } catch (err) {
    next(err);
  }
});

const PutPrefBody = z.object({
  notification_type: z.string().min(1).max(100),
  channel: z.string().min(1).max(20),
  enabled: z.boolean(),
});

// PUT /me/communication-prefs — set one matrix cell (tier-2 only).
meRouter.put("/me/communication-prefs", requireAuth, async (req, res, next) => {
  try {
    const parsed = PutPrefBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad preference", details: parsed.error.issues } });
      return;
    }
    const { notification_type, channel, enabled } = parsed.data;
    if (!isTier2(notification_type)) {
      res.status(400).json({ error: { code: "not_configurable", message: "That notification type isn't configurable." } });
      return;
    }
    if (!isPrefChannel(channel)) {
      res.status(400).json({ error: { code: "bad_channel", message: "Unknown channel." } });
      return;
    }
    await meta
      .insertInto("notification_account_prefs")
      .values({ user_id: req.session!.id, notification_type, channel, enabled, updated_at: new Date() })
      .onConflict((c) =>
        c.columns(["user_id", "notification_type", "channel"]).doUpdateSet({ enabled, updated_at: new Date() }),
      )
      .execute();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
