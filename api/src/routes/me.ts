// /api/v1/me — current session profile + org memberships. Mirrors
// the shape /auth/login returns so the web can reuse the same hook.

import { childTerms } from "../auth/token-lineage.js";
import { OPERATOR_ONLY_ACTIONS } from "../platform/activity.js";
import { forgetTimeZone } from "../platform/person-day.js";
import { TITLE_FORMATS, type TitleFormat } from "@cobblr/platform-contract/display-identity";
import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { PhotoConsentRefused, photoConsentOf, setPhotoConsent } from "../platform/photo-consent.js";
import { deliveryTick } from "../platform/delivery-sweeper.js";
import { requireAuth } from "../auth/middleware.js";
import { mintTokenString } from "../auth/api-tokens.js";
import { TOKEN_ACCESS, isTokenAccess, type TokenAccess } from "../auth/token-access.js";
import { listScopeChoices, sanitizeScopes } from "../auth/scopes.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { pendingEmailChange, requestEmailChange } from "../platform/email-change.js";
import { linkOrigin } from "../platform/link-origin.js";
import { signSession } from "../auth/jwt.js";
import * as notifications from "../platform/notifications.js";
import { notificationKindsFor, notificationLabel } from "../platform/notification-kinds.js";
import { onNotificationChange } from "../platform/notification-stream.js";
import { openSse, signStreamTicket, verifyStreamTicket } from "../lib/event-stream.js";
import { NOTIFICATION_STREAM_EVENT } from "@cobblr/platform-contract/notification-stream";
import type { NotificationChannel } from "../db/schema.js";
import { pressNotificationAction } from "../platform/notification-press.js";
import { loadSessionUser } from "../auth/session-user.js";
import * as activity from "../platform/activity.js";
import { listMembershipsForUser } from "../platform/memberships.js";
import { hasAuthEmailSender, sendAuthEmail } from "../platform/hosted-seams.js";
import { selfServeInvitesEnabled, inviteExpiresAt } from "../auth/signup-gate.js";
import { browserBase, identityCallbackEnabled } from "../auth/identity-client.js";
import { hardDeleteUser, SoleOwnerRefusal, soleOwnedWorkspaces } from "../platform/delete-user.js";
import { finalExportPath, finalExportsFor } from "../platform/workspace-final-export.js";
import { issueAndSendVerifyEmail } from "./auth.js";
import { captureBlueprint } from "./blueprint.js";
import {
  discordConnectConfigured,
  signOAuthState,
  verifyOAuthState,
  discordAuthorizeUrl,
  exchangeCodeForIdentity, discordAppId } from "../platform/discord-oauth.js";
import { communityLinks, discordInviteUrl } from "../platform/community.js";
import { sendDiscordDm } from "../platform/discord-bot-trigger.js";
import { canDeliverDiscordDm, discordConnectionState, needsAppStamp } from "../platform/discord-connection.js";
import { publicBaseUrl } from "../platform/public-url.js";
import { PERSONAL_EXPORT_DAYS, personalExportFile, personalExportsOf, requestPersonalExport } from "../platform/personal-export.js";
import {
  NOTIFICATION_TYPES,
  PREF_CHANNELS,
  isTier2,
  isPrefChannel,
} from "../platform/notification-catalog.js";
import { ORG_ROLES, ORG_ROLE_RANK, roleSatisfies, type OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { decodeKeysetCursor, encodeKeysetCursor } from "@cobblr/platform-contract/keyset-cursor";
import { instantFromInput } from "@cobblr/platform-contract/day";

export const meRouter = Router();

meRouter.get("/me", requireAuth, async (req, res) => {
  const userId = req.session!.id;
  // Shared with buildAuthResponse (login, signup, invite-accept). One list of
  // columns, so a preference cannot arrive here and be missing there.
  const [loaded, memberships] = await Promise.all([
    loadSessionUser(userId),
    listMembershipsForUser(userId),
  ]);
  // View as through a share: the app opens on the one share space, and the
  // person whose eyes it lends keeps everything else of theirs (their address,
  // their other workspaces) to themselves.
  const view = req.session!.share_view ?? null;
  const orgs = view ? memberships.filter((o) => o.id === view.org_id) : memberships;
  const user = view ? { ...loaded, email: "" } : loaded;
  return res.json({
    share_view: view ? { viewer_name: view.viewer_name, expires_at: view.expires_at, slug: view.slug } : null,
    user: {
      ...user,
      auth_method: req.session!.auth_method,
      api_token_id: req.session!.api_token_id,
      is_platform_admin: req.session!.is_platform_admin,
      // Community link for the signed-in chrome (account menu, feedback modal);
      // null unless the community invite is configured.
      discord_invite_url: discordInviteUrl() || null,
      community_links: communityLinks(),
    },
    orgs,
    // What THIS token may do, for a client that offers tools on its behalf
    // (the MCP server a person runs locally): offering a tool the token is
    // always refused reads to a model as a broken tool. Null for a session.
    token:
      req.session!.auth_method === "api_token"
        ? {
            access: req.session!.token_access ?? "full",
            workspace: req.session!.token_org_id
              ? (orgs.find((o) => o.id === req.session!.token_org_id)?.slug ?? null)
              : null,
            // So a script can say its token is about to stop working before
            // it does (the nightly bench, a week ahead): a token held to one
            // workspace may not list the account's tokens to find out.
            expires_at: req.session!.token_expires_at ?? null,
          }
        : null,
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

// PATCH /me/default-workspace — pin the workspace a FRESH device opens into.
// Body: { slug } to set, { slug: null } to clear. Per-user; one default at a
// time (a partial unique index guards it, and this clears the others first in
// the same transaction). A device that already has a last-active workspace
// still resumes there — the default is the no-preference landing (the author).
const DefaultBody = z.object({ slug: z.string().nullable() });
meRouter.patch("/me/default-workspace", requireAuth, async (req, res, next) => {
  try {
    const parsed = DefaultBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const userId = req.session!.id;
    let targetOrgId: string | null = null;
    if (parsed.data.slug) {
      const m = await meta
        .selectFrom("org_memberships as m")
        .innerJoin("orgs as o", "o.id", "m.org_id")
        .select(["m.org_id"])
        .where("m.user_id", "=", userId)
        .where("o.slug", "=", parsed.data.slug)
        .executeTakeFirst();
      if (!m) {
        res.status(404).json({ error: { code: "not_a_member", message: "You're not a member of that workspace." } });
        return;
      }
      targetOrgId = m.org_id;
    }
    await meta.transaction().execute(async (trx) => {
      await trx.updateTable("org_memberships").set({ is_default: false }).where("user_id", "=", userId).where("is_default", "=", true).execute();
      if (targetOrgId) {
        await trx.updateTable("org_memberships").set({ is_default: true }).where("user_id", "=", userId).where("org_id", "=", targetOrgId).execute();
      }
    });
    res.json({ ok: true, default_slug: parsed.data.slug });
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
  // Per-user theme; null clears back to device/OS default.
  theme_pref: z.enum(["light", "dark"]).nullable().optional(),
  /** true = mark the tour seen now. false = clear it, so "Take the tour" from
   *  the account menu can put somebody back to never-seen if they want it
   *  offered again. A timestamp is not accepted from the client: when it
   *  happened is the server's to say. */
  tour_seen: z.boolean().optional(),
  // Per-user nav layout (desktop only — a phone keeps its own menu whatever
  // this says). null clears back to the device default. Strict so a stray key
  // can't be smuggled into the blob and read back out as trusted state.
  nav_pref: z
    .object({
      mode: z.enum(["top", "side"]),
      autohide: z.boolean(),
      topbar: z.boolean(),
    })
    .strict()
    .nullable()
    .optional(),
  // How a titled work's original / translated / transliterated title reads
  // for this person (#3061). null = the default format.
  title_pref: z.enum(TITLE_FORMATS as [TitleFormat, ...TitleFormat[]]).nullable().optional(),
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
        ...(parsed.data.theme_pref !== undefined && { theme_pref: parsed.data.theme_pref }),
        ...(parsed.data.title_pref !== undefined && { title_pref: parsed.data.title_pref }),
        ...(parsed.data.tour_seen !== undefined && {
          tour_seen_at: parsed.data.tour_seen ? new Date() : null,
        }),
        ...(parsed.data.nav_pref !== undefined && {
          // jsonb-replace-ok: nav_pref is one small document this endpoint owns
          nav_pref: (parsed.data.nav_pref === null
            ? null
            : sql`${JSON.stringify(parsed.data.nav_pref)}::jsonb`) as never,
        }),
      })
      .where("id", "=", req.session!.id)
      .returning(["id", "email", "display_name", "theme_pref", "nav_pref", "title_pref", "tour_seen_at"])
      .executeTakeFirstOrThrow();
    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

// POST /me/tips/:id/shown and /me/tips/:id/dismissed — a tip the person has
// been shown (the first time only: the day it first showed is what "one new
// tip a day" counts) and one they dismissed, which is final. Each writes one
// key, so two tabs recording two tips cannot overwrite each other.
const TIP_ID = /^[a-z0-9][a-z0-9:._-]{0,79}$/;
function recordTip(field: "shown" | "dismissed") {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      if (!TIP_ID.test(id)) {
        res.status(400).json({ error: { code: "invalid_tip", message: "That is not a tip id." } });
        return;
      }
      const updated = await meta
        .updateTable("users")
        .set({
          // Only the first time counts: an existing entry keeps its date.
          tips: sql`jsonb_set(
            jsonb_set(coalesce(tips, '{}'::jsonb), ${sql.lit(`{${field}}`)}::text[], coalesce(tips->${field}, '{}'::jsonb)),
            array[${field}, ${id}]::text[],
            coalesce(tips->${field}->${id}, to_jsonb(now()))
          )` as never,
        })
        .where("id", "=", req.session!.id)
        .returning(["tips"])
        .executeTakeFirstOrThrow();
      res.json({ tips: updated.tips });
    } catch (err) {
      next(err);
    }
  };
}
meRouter.post("/me/tips/:id/shown", requireAuth, recordTip("shown"));
meRouter.post("/me/tips/:id/dismissed", requireAuth, recordTip("dismissed"));

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

// GET /me/email: the sign-in address and a change waiting for its link.
// AI-REACH: exempt: a person's own sign-in address, read on their account page.
meRouter.get("/me/email", requireAuth, async (req, res, next) => {
  try {
    const u = await meta.selectFrom("users").select(["email", "identity_id", "password_hash"]).where("id", "=", req.session!.id).executeTakeFirstOrThrow();
    res.json({
      email: u.email,
      pending: await pendingEmailChange(req.session!.id),
      managed_by_identity: !!u.identity_id && u.password_hash.length === 0,
      // No password to ask for: the change is proven by a recent sign-in.
      has_password: u.password_hash.length > 0,
    });
  } catch (err) {
    next(err);
  }
});

// POST /me/email: ask to change the sign-in address (platform/email-change.ts).
// A link goes to the new address; nothing changes until it is used.
// AI-REACH: exempt: changing how a person signs in is theirs alone, with their password.
// current_password: required unless the account has none (a magic-link
// account proves itself by a recent sign-in instead; email-change.ts).
const EmailChangeBody = z.object({ new_email: z.string().email().max(254), current_password: z.string().min(1).optional() });
meRouter.post("/me/email", requireAuth, async (req, res, next) => {
  try {
    const parsed = EmailChangeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Give the new address and your current password.", details: parsed.error.issues } });
      return;
    }
    const origin = linkOrigin(req);
    const out = await requestEmailChange(req.session!.id, parsed.data.new_email, parsed.data.current_password, origin, req.session!);
    if ("refused" in out) {
      res.status(out.refused.status).json({ error: { code: out.refused.code, message: out.refused.message } });
      return;
    }
    res.status(202).json({ pending: out.pending, expires_at: out.expires_at, emailed: out.emailed, ...(out.devToken ? { dev_token: out.devToken } : {}) });
  } catch (err) {
    next(err);
  }
});

// Sign out everywhere without changing the password. Until now the ONLY way to
// revoke a session (a lost/stolen token, a shared device) was a password change
// — so a user who suspected a token was exposed had to rotate their password to
// kill it. Stamping tokens_valid_from = now invalidates every existing JWT for
// this account (the middleware rejects any token minted before the cutoff), then
// re-mints THIS device so the caller stays signed in. Same mechanism as the
// password change, minus the password. See docs/history/2026-08-25-prerelease-audit.md H1.
// AI-REACH: exempt — self-only session revocation. An agent has no business
// signing a person out of their own devices; this is reachable only by the
// authenticated user acting on themselves.
meRouter.post("/me/sign-out-everywhere", requireAuth, async (req, res, next) => {
  try {
    const at = new Date();
    await meta
      .updateTable("users")
      .set({ tokens_valid_from: at })
      .where("id", "=", req.session!.id)
      .execute();
    const freshToken = await signSession(req.session!.id);
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
          action: "sessions_revoked",
          ref: { module: null, entityType: "user", entityId: req.session!.id },
        })
        .catch((err) => console.error("[me/sign-out-everywhere] activity log failed:", err));
    }
    res.status(200).json({ token: freshToken });
  } catch (err) {
    next(err);
  }
});

// ── Download my data (#4185) ──────────────────────────────────────────────
// A person's own copy of what Cobblr holds about them: personal-export.ts.
// AI-REACH: exempt (a person taking their own data; never on behalf of a workspace, never by an agent)
meRouter.post("/me/export", requireAuth, async (req, res, next) => {
  try {
    const r = await requestPersonalExport(req.session!.id, { origin: linkOrigin(req) });
    if (!r.ok) {
      res.status(429).json({
        error: { code: "too_soon", message: "You can take one copy a day. The one you asked for today is below.", details: { retry_at: r.retryAt.toISOString() } },
      });
      return;
    }
    res.status(202).json({ id: r.id, status: r.status });
  } catch (err) {
    next(err);
  }
});

meRouter.get("/me/export", requireAuth, async (req, res, next) => {
  try {
    res.json({ items: await personalExportsOf(req.session!.id), days: PERSONAL_EXPORT_DAYS });
  } catch (err) {
    next(err);
  }
});

meRouter.get("/me/export/:id/download", requireAuth, async (req, res, next) => {
  try {
    const bytes = await personalExportFile(String(req.params.id ?? ""), req.session!.id);
    if (!bytes) {
      // Somebody else's, run out, or not built: one answer, so an id says nothing.
      res.status(404).json({ error: { code: "not_found", message: "That copy is not here. Ask for a new one." } });
      return;
    }
    res.setHeader("Content-Type", "application/zip");
    // UTC-DAY OK: the download's filename stamp, not a claim about anybody's calendar.
    res.setHeader("Content-Disposition", `attachment; filename="my-cobblr-data-${new Date().toISOString().slice(0, 10)}.zip"`);
    res.send(bytes);
  } catch (err) {
    next(err);
  }
});

// DELETE /me — the person deletes their own account. Confirmed with the
// current password; an account that came through the central identity
// hand-off and has no password of its own is sent to the account service,
// whose deletion calls back here (POST /auth/identity/deleted). Refused while
// the person is the only owner of a live workspace, with the list, so no
// shared workspace vanishes because one member left; the operator door can
// take the workspaces along, this one deliberately cannot. Every token dies
// with the account. There was no door at all for this until #3276: a
// throwaway account could only be removed by hand-written SQL.
// AI-REACH: exempt — a person ending their own account, as themselves, with
// their password; never on behalf of a workspace, never by an agent.
const DeleteMeBody = z.object({ current_password: z.string().optional() });
meRouter.delete("/me", requireAuth, async (req, res, next) => {
  try {
    if (req.session!.auth_method !== "session") {
      res.status(403).json({ error: { code: "session_required", message: "Sign in with your account, not a token, to delete it." } });
      return;
    }
    const parsed = DeleteMeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body." } });
      return;
    }
    const userId = req.session!.id;
    const row = await meta
      .selectFrom("users")
      .select(["id", "email", "password_hash", "identity_id"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    const hasPassword = row.password_hash.length > 0;
    if (!hasPassword && row.identity_id && identityCallbackEnabled()) {
      // The account of record is upstream; deleting there deletes here (that
      // is what POST /auth/identity/deleted is for). The message names the
      // operator as well as the portal on purpose: the portal's own delete is
      // CobblrHQ/identity#29 and is not shipped yet, so linking only the portal
      // sends this person to look for a button that does not exist. Both
      // sentences stay true once it does land.
      res.status(409).json({
        error: {
          code: "delete_at_identity",
          message:
            "This account is managed by your Cobblr account, so it is deleted there and removed here too. If you cannot find that option yet, ask whoever runs this instance to remove your account.",
          details: { portal: browserBase() },
        },
      });
      return;
    }
    // The refusals come before the password so the page can ask with an
    // empty body and learn which of the three it is about to show, without
    // making the person type their password to be told "not yet".
    const sole = await soleOwnedWorkspaces(userId);
    if (sole.length > 0) {
      res.status(409).json({
        error: {
          code: "sole_owner",
          message: "You are the only owner of a workspace. Delete it (its Settings, General), or make somebody else an owner, first.",
          details: { workspaces: sole.map((w) => ({ slug: w.slug, name: w.name })) },
        },
      });
      return;
    }
    if (!parsed.data.current_password || !(await verifyPassword(parsed.data.current_password, row.password_hash))) {
      res.status(403).json({ error: { code: "bad_current_password", message: "Current password is incorrect." } });
      return;
    }
    try {
      const result = await hardDeleteUser(userId);
      console.log(`[me/delete] account ${userId} ${result.mode}`);
    } catch (err) {
      if (err instanceof SoleOwnerRefusal) {
        res.status(409).json({
          error: { code: "sole_owner", message: "You are the only owner of a workspace. Delete it (its Settings, General), or make somebody else an owner, first.", details: { workspaces: err.workspaces.map((w) => ({ slug: w.slug, name: w.name })) } },
        });
        return;
      }
      throw err;
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
// GET /me/workspace-exports: the final backups of deleted workspaces this
// person owned, kept for a while after the workspace went
// (platform/workspace-final-export.ts).
// AI-REACH: a person's own downloads, read on their account page.
meRouter.get("/me/workspace-exports", requireAuth, async (req, res, next) => {
  try {
    const rows = await finalExportsFor(req.session!.id);
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        workspace: r.org_name,
        filename: r.filename,
        size_bytes: Number(r.size_bytes),
        created_at: r.created_at,
        expires_at: r.expires_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /me/workspace-exports/:id/download: the zip, for an owner of the
// workspace it came from, until it expires.
// AI-REACH: a file download for the person it belongs to; nothing to act on.
meRouter.get("/me/workspace-exports/:id/download", requireAuth, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const mine = (await finalExportsFor(req.session!.id)).find((r) => r.id === id);
    if (!mine) {
      res.status(404).json({ error: { code: "not_found", message: "No backup of yours by that id, or it has expired." } });
      return;
    }
    await meta
      .updateTable("workspace_final_exports")
      .set((eb) => ({ download_count: eb("download_count", "+", 1) }))
      .where("id", "=", id)
      .execute();
    res.download(finalExportPath(id), mine.filename);
  } catch (err) {
    next(err);
  }
});

meRouter.get("/me/activity", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session!.id;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    // Optional explicit ?org=<slug> narrows to one workspace; default
    // is "across all of mine."
    const orgFilter = typeof req.query.org === "string" ? req.query.org : null;
    // Keyset on (occurred_at to the millisecond, id) desc, the precision the
    // cursor carries (@cobblr/platform-contract/keyset-cursor). An old
    // time-only cursor still reads.
    const c = decodeKeysetCursor(typeof req.query.cursor === "string" ? req.query.cursor : null);
    const cursorId = c?.id && /^\d+$/.test(c.id) ? Number(c.id) : null;
    // What the CALLER did, in the workspaces they still belong to. Reading
    // through the membership alone listed every member's work here as theirs.
    const mine = meta
      .selectFrom("activity_log as a")
      .innerJoin("orgs as o", "o.id", "a.org_id")
      .innerJoin("org_memberships as m", (j) => j.onRef("m.org_id", "=", "a.org_id").on("m.user_id", "=", userId))
      .where("a.user_id", "=", userId)
      // Operator-side records (a support "View as") never reach a member's feed.
      .where("a.action", "not in", [...OPERATOR_ONLY_ACTIONS])
      .where("a.action", "not like", "impersonation\\_%")
      .$if(!!orgFilter, (q) => q.where("o.slug", "=", orgFilter!));
    let q = mine
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
      .orderBy(sql`date_trunc('milliseconds', a.occurred_at)`, "desc")
      .orderBy("a.id", "desc")
      .limit(limit + 1); // +1 to detect "there's more" without a second query
    if (c) {
      q = cursorId !== null
        ? q.where(sql<boolean>`(date_trunc('milliseconds', a.occurred_at), a.id) < (${c.at}, ${cursorId})`)
        : q.where(sql<boolean>`date_trunc('milliseconds', a.occurred_at) < ${c.at}`);
    }
    const rows = await q.execute();
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const next_cursor = hasMore && last ? encodeKeysetCursor(last.occurred_at, last.id) : null;
    // The total is the count of this same list, filters and all.
    const totalRow = await mine.select(({ fn }) => fn.countAll<number>().as("n")).executeTakeFirst();
    res.json({ items, next_cursor, total: Number(totalRow?.n ?? items.length) });
  } catch (err) {
    next(err);
  }
});

// ─────────── Delivery windows ───────────────────────────────────────
// When a channel is allowed to interrupt you. Per (person, channel), and
// account-level rather than org-scoped on purpose: a person has one attention,
// not one per workspace. Design: docs/design-decisions/notification-delivery-windows.md

const WindowBody = z.object({
  channel: z.string().min(1).max(40),
  mode: z.enum(["immediate", "daily"]),
  /** Minutes past local midnight. 480 = 08:00. */
  deliver_at_minute: z.number().int().min(0).max(1439).optional(),
  /** IANA zone. 08:00 has to mean 08:00 where the person is. */
  timezone: z.string().min(1).max(64).optional(),
  /** The cadence for DATED things — expiring today, service due, running low —
   *  as opposed to the one above, which governs things that just happened.
   *
   *  `inherit` means what a single-cadence window always meant: dated things
   *  follow the same rule as everything else. Omitting it leaves the stored
   *  value alone, so a client that has never heard of the split cannot reset
   *  somebody's morning brief by saving an unrelated preference. */
  schedule_mode: z.enum(["inherit", "immediate", "daily"]).optional(),
  schedule_deliver_at_minute: z.number().int().min(0).max(1439).optional(),
});

meRouter.get("/me/delivery-windows", requireAuth, async (req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("notification_delivery_windows")
      .select([
        "channel",
        "mode",
        "deliver_at_minute",
        "timezone",
        "last_delivered_at",
        "schedule_mode",
        "schedule_deliver_at_minute",
        "schedule_last_delivered_at",
      ])
      .where("user_id", "=", req.session!.id)
      .execute();
    // What is waiting, per channel. "You have 5 updates queued for 08:00" is
    // the answer to the obvious question a window raises, and without it the
    // only way to know whether anything deferred is to wait and see.
    const pending = await meta
      .selectFrom("notification_deferred")
      .select(["channel", "triggered_by", meta.fn.count<string>("id").as("n")])
      .where("user_id", "=", req.session!.id)
      .groupBy(["channel", "triggered_by"])
      .execute();
    // Per channel, and per class within it: "5 waiting" is a different answer
    // depending on whether it is chat or things due today, and the two now
    // arrive at different times.
    const byChannel = new Map<string, number>();
    const byClass = new Map<string, number>();
    for (const p of pending) {
      byChannel.set(p.channel, (byChannel.get(p.channel) ?? 0) + Number(p.n));
      byClass.set(`${p.channel}:${p.triggered_by}`, Number(p.n));
    }
    res.json({
      items: rows.map((r) => ({
        ...r,
        pending_count: byChannel.get(r.channel) ?? 0,
        pending_activity: byClass.get(`${r.channel}:activity`) ?? 0,
        pending_schedule: byClass.get(`${r.channel}:schedule`) ?? 0,
      })),
      // Channels with mail queued but no window row (the window was removed
      // while mail waited) still owe the person something; the sweeper sends
      // those on its next pass, so say so rather than hiding them.
      orphaned: pending.filter((p) => !rows.some((r) => r.channel === p.channel))
        .map((p) => ({ channel: p.channel, pending_count: Number(p.n) })),
    });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt — a personal delivery preference. An agent has no business
// deciding when someone may be interrupted.
meRouter.put("/me/delivery-windows", requireAuth, async (req, res, next) => {
  try {
    const parsed = WindowBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues },
      });
      return;
    }
    const b = parsed.data;
    // A bad zone name would silently strand this person's mail behind a window
    // that never opens, so it is rejected here rather than falling back later.
    if (b.timezone) {
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: b.timezone });
      } catch {
        res.status(400).json({
          error: { code: "bad_timezone", message: `Unknown timezone: ${b.timezone}` },
        });
        return;
      }
    }
    await meta
      .insertInto("notification_delivery_windows")
      .values({
        user_id: req.session!.id,
        channel: b.channel,
        mode: b.mode,
        ...(b.deliver_at_minute !== undefined ? { deliver_at_minute: b.deliver_at_minute } : {}),
        ...(b.timezone ? { timezone: b.timezone } : {}),
        ...(b.schedule_mode ? { schedule_mode: b.schedule_mode } : {}),
        ...(b.schedule_deliver_at_minute !== undefined
          ? { schedule_deliver_at_minute: b.schedule_deliver_at_minute }
          : {}),
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "channel"]).doUpdateSet({
          mode: b.mode,
          ...(b.deliver_at_minute !== undefined ? { deliver_at_minute: b.deliver_at_minute } : {}),
          ...(b.timezone ? { timezone: b.timezone } : {}),
          ...(b.schedule_mode ? { schedule_mode: b.schedule_mode } : {}),
          ...(b.schedule_deliver_at_minute !== undefined
            ? { schedule_deliver_at_minute: b.schedule_deliver_at_minute }
            : {}),
          updated_at: new Date(),
        }),
      )
      .execute();
    // Their zone is what the day rule reads (person-day.ts caches it for a
    // minute); a person who just corrected it must not get yesterday's answer
    // for the next sixty seconds.
    forgetTimeZone(req.session!.id);
    res.json({ ok: true, channel: b.channel, mode: b.mode });
  } catch (err) {
    next(err);
  }
});

/**
 * Flush MY buckets, now.
 *
 * A window is a time of day, which makes the delivering half of this feature
 * untestable without a trigger: you cannot wait until 08:00 in an e2e, and a
 * "sweeper started" log line says nothing about whether a tick actually sends
 * anything. core-cadence grew a POST /sweep for exactly this reason.
 *
 * Scoped to the CALLER's own buckets, not the whole box: it is a diagnostic
 * about your own mail, never a lever on anyone else's. It still honours the
 * window, so forcing a flush before yours opens correctly does nothing — the
 * due check is part of what needs exercising, not something to skip.
 */
// AI-REACH: exempt — an operator/self diagnostic that delivers mail already
// queued; an agent has no reason to trigger someone's digest early.
// UI-REACH: an operator's diagnostic that delivers mail already queued
meRouter.post("/me/delivery-windows/flush", requireAuth, async (req, res, next) => {
  try {
    const out = await deliveryTick(new Date(), req.session!.id);
    res.json(out);
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
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    const orgSlug = typeof req.query.org === "string" && req.query.org ? req.query.org : undefined;
    const rows = await notifications.listForUserAcrossOrgs(req.session!.id, {
      limit,
      unreadOnly,
      ...(before ? { before } : {}),
      ...(orgSlug ? { orgSlug } : {}),
    });
    // Its kind in words, for the line under it; null when nobody named it.
    const items = rows.map((n) => ({ ...n, label: notificationLabel(n.event_type) }));
    // A full page may have more behind it: the cursor is the last row's
    // `<created_at>|<id>`, which the next call hands back as `before`.
    const last = items.length === limit ? items[items.length - 1] : undefined;
    res.json({ items, next_cursor: last ? encodeKeysetCursor(last.created_at, last.id) : null });
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

// POST /me/notifications/:id/actions/:actionId — press a button on a
// notification, in the app.
//
// The column, dispatch and the Discord renderer have all supported pressable
// actions for a while; the app was the only place you could not press one, so
// a notification that Discord showed as "Mark done / Snooze" arrived here as a
// sentence (audit, 2026-09-06). Every check lives in pressNotificationAction,
// which the Discord door calls too - two doors, one rule about who may do what.
//
// AI-REACH: exempt — pressing a button a notification offered YOU, as yourself; the assistant invokes the same underlying actions through invoke_action.
meRouter.post("/me/notifications/:id/actions/:actionId", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    const actionId = req.params.actionId;
    if (!id || !actionId) {
      res.status(400).json({ error: { code: "missing_id", message: "id and actionId required" } });
      return;
    }
    const outcome = await pressNotificationAction({
      notificationId: id,
      actionId,
      userId: req.session!.id,
      actorName: req.session!.display_name ?? null,
    });
    if (!outcome.ok && outcome.reason === "declined") {
      // The person was allowed to press; the thing they pressed answered no,
      // in words meant for them ("This was already declined.").
      res.status(409).json({ error: { code: "declined", message: outcome.message } });
      return;
    }
    if (!outcome.ok) {
      // One shape for every refusal, so a prober learns nothing about which
      // ids exist or what roles anybody holds. A genuine failure is separable
      // because the person WAS allowed and something else broke.
      const failed = outcome.reason === "failed";
      res.status(failed ? 500 : 403).json({
        error: {
          code: failed ? "action_failed" : "not_allowed",
          message: failed
            ? "That did not go through. Open the record to finish it."
            : "This is no longer available.",
        },
      });
      return;
    }
    // Pressing IS reading it: the thing it asked about has been dealt with.
    await notifications.markRead(id, req.session!.id).catch(() => {});
    res.json({ ok: true, label: outcome.label });
  } catch (err) {
    next(err);
  }
});

const STREAM_AUD = "notifications";

/** A ticket for the notification stream (an EventSource cannot send the
 *  Authorization header). */
meRouter.post("/me/notifications/stream-ticket", requireAuth, async (req, res, next) => {
  try {
    res.json({ ticket: await signStreamTicket(STREAM_AUD, req.session!.id) });
  } catch (err) {
    next(err);
  }
});

/** Your notifications changed: pushed to your open tabs as it happens, so the
 *  bell and the page refetch now rather than at their next poll. */
meRouter.get("/me/notifications/stream", async (req, res, next) => {
  try {
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
    const who = ticket ? await verifyStreamTicket(STREAM_AUD, ticket) : null;
    if (!who) {
      res.status(401).json({ error: { code: "bad_ticket", message: "A valid stream ticket is required." } });
      return;
    }
    const { send, stop } = openSse(res);
    const off = onNotificationChange(who.userId, (change) => send(NOTIFICATION_STREAM_EVENT, change));
    req.on("close", () => {
      stop();
      off();
    });
  } catch (err) {
    next(err);
  }
});

/** The kinds of notification a workspace can send you, by name: the Channels
 *  page's picker for which ones a binding is for. */
meRouter.get("/me/notification-kinds", requireAuth, async (req, res, next) => {
  try {
    const orgId = String(req.query.org_id ?? "");
    const member = orgId
      ? await meta.selectFrom("org_memberships").select("user_id").where("user_id", "=", req.session!.id).where("org_id", "=", orgId).executeTakeFirst()
      : undefined;
    if (!member) {
      res.status(404).json({ error: { code: "not_a_member", message: "Workspace not found." } });
      return;
    }
    const enabled = new Set(
      (await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()).map((r) => r.module_name),
    );
    res.json({ items: notificationKindsFor(enabled) });
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/notifications/:id/unread", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    await notifications.markUnread(id, req.session!.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

meRouter.delete("/me/notifications/:id", requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    // Someone else's id reads as gone, the same as one that never existed.
    if (!(await notifications.remove(id, req.session!.id))) {
      res.status(404).json({ error: { code: "not_found", message: "That notification is already gone." } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** Clear read: every notification this person has read, in every workspace. */
meRouter.post("/me/notifications/clear-read", requireAuth, async (req, res, next) => {
  try {
    const count = await notifications.removeRead(req.session!.id);
    res.json({ count });
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

// Every channel the dispatcher can deliver through, and nothing else: the
// list is the registry's own keys, so a channel added there is one a person
// can bind, and the settings page cannot offer one this refuses (it offered
// Discord DM, which this list had left out, so saving it failed). A channel
// that says it is not offered (browser push, a stub that delivers nothing)
// is left out: picking it saved a binding that never sent anything.
export const OFFERED_CHANNELS = (Object.keys(notifications.REGISTRY) as NotificationChannel[]).filter(
  (c) => !notifications.REGISTRY[c]?.notOffered,
);
export const ChannelEnum = z.enum(OFFERED_CHANNELS as [NotificationChannel, ...NotificationChannel[]]);
const PriorityEnum = z.enum(["low", "normal", "high", "urgent"]);

// Channel-specific config validators. The dispatcher's drivers
// re-validate at delivery time (so a row with stale config doesn't
// blow up the dispatcher), but we validate at write time too so
// users get immediate feedback when they paste a malformed URL.
const ChannelConfigSchemas: Record<NotificationChannel, z.ZodTypeAny> = {
  in_app: z.object({}).strict(),
  browser_push: z.object({}).strict(),
  // The person's own linked Discord account; nothing to configure here.
  discord_dm: z.object({}).strict(),
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
      // A DM goes to the Discord account this person linked; a binding made
      // before that would save and then never deliver, so it says what to do.
      if (parsed.data.channel === "discord_dm") {
        const conn = await meta
          .selectFrom("discord_connections")
          .select(["discord_user_id", "verified", "verified_app_id"])
          .where("user_id", "=", req.session!.id)
          .executeTakeFirst();
        if (!canDeliverDiscordDm(conn)) {
          res.status(409).json({
            error: { code: "discord_not_connected", message: "Connect your Discord account under your profile first, then add Discord DM here." },
          });
          return;
        }
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
/**
 * Send myself one notification through the REAL dispatcher.
 *
 * The per-binding test below deliberately bypasses the dispatcher's
 * subscription scan, which is right for "does this channel work" and means
 * there is no way at all to exercise the layer above it: routing, the priority
 * threshold, the account-prefs fallback, and now delivery windows. All four are
 * decisions the dispatcher makes and none of them had a way to be checked
 * against a running instance.
 *
 * Scoped to the caller, in a workspace they belong to.
 */
// AI-REACH: exempt — a diagnostic that notifies only the caller.
const SelfTestBody = z.object({
  org_id: z.string().uuid(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  message: z.string().min(1).max(300).default("Test notification"),
  event_type: z.string().min(1).max(120).default("platform.self-test"),
});

meRouter.post("/me/notifications/self-test", requireAuth, async (req, res, next) => {
  try {
    const parsed = SelfTestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues },
      });
      return;
    }
    const member = await meta
      .selectFrom("org_memberships")
      .select("user_id")
      .where("user_id", "=", req.session!.id)
      .where("org_id", "=", parsed.data.org_id)
      .executeTakeFirst();
    if (!member) {
      res.status(403).json({ error: { code: "not_a_member", message: "Not a member of that workspace" } });
      return;
    }
    const out = await notifications.dispatch({
      orgId: parsed.data.org_id,
      userId: req.session!.id,
      eventType: parsed.data.event_type,
      message: parsed.data.message,
      priority: parsed.data.priority,
      // A diagnostic about the delivery machinery itself. There is no record
      // behind it to open.
      no_link_reason: "a self-test of delivery; there is no record behind it",
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

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
  /** Provenance — the surface that minted this (e.g. "api-recipes"). */
  source: z.string().max(60).optional(),
  /** Provenance payload — the wizard's answers ({ kind, action, org }). */
  meta: z.record(z.unknown()).optional(),
  /** The one workspace this token may reach (id or slug). Omit for every
   *  workspace you belong to. */
  workspace: z.string().min(1).max(120).optional(),
  /** look | change | full (token-access.ts). Omitted: `change` when the
   *  token names a workspace, and the legacy full access when it names none,
   *  so a script that minted tokens before this keeps getting what it got. */
  access: z.enum(TOKEN_ACCESS).optional(),
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
      .leftJoin("orgs as o", "o.id", "api_tokens.org_id")
      .select([
        "api_tokens.id as id", "api_tokens.name as name", "api_tokens.token_prefix as token_prefix",
        "api_tokens.expires_at as expires_at", "api_tokens.last_used_at as last_used_at",
        "api_tokens.revoked_at as revoked_at", "api_tokens.created_at as created_at",
        "api_tokens.scopes as scopes", "api_tokens.source as source", "api_tokens.meta as meta",
        "api_tokens.access as access", "api_tokens.org_id as org_id", "o.name as org_name", "o.slug as org_slug",
      ])
      .where("api_tokens.user_id", "=", req.session!.id)
      .orderBy("api_tokens.created_at", "desc")
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

    // Asking for a scope this build does not know must FAIL, not quietly mint a
    // weaker token. sanitizeScopes drops unknown keys by design (typos, removed
    // scopes), and dropping them silently means the caller walks away holding a
    // credential that looks like what they asked for and is not — discovered
    // later as a 403 from whatever the missing scope was for.
    //
    // And a downgrade is the MILD case. If every requested scope is unknown,
    // sanitize returns [], resolveApiToken maps an empty array to null
    // (api-tokens.ts), and requireAuth's clamp is `if (tokenScopes && ...)` —
    // so the token is not clamped at all, while still carrying the user's full
    // identity including is_platform_admin. Asking for a scope this build has
    // never heard of therefore minted an UNRESTRICTED token, which is the
    // opposite of what the caller was reaching for.
    //
    // The realistic way in is not a typo. It is a deploy lag: the scope exists
    // in `main`, the instance runs an older build, and the mint "succeeds".
    // A token held to a workspace names one its owner belongs to, read fresh:
    // naming a workspace you left must not mint a key to it.
    let orgId: string | null = null;
    if (parsed.data.workspace) {
      const w = parsed.data.workspace;
      const membership = await meta
        .selectFrom("org_memberships as m")
        .innerJoin("orgs as o", "o.id", "m.org_id")
        .select("o.id")
        .where("m.user_id", "=", req.session!.id)
        .where((eb) => (/^[0-9a-f-]{36}$/i.test(w) ? eb("o.id", "=", w) : eb("o.slug", "=", w)))
        .executeTakeFirst();
      if (!membership) {
        res.status(400).json({ error: { code: "unknown_workspace", message: "You are not a member of that workspace. No token was created." } });
        return;
      }
      orgId = membership.id;
    }
    // Capability scopes and an access level are two different kinds of token;
    // one that claimed both would be read by whichever check ran first.
    if ((parsed.data.scopes?.length ?? 0) > 0 && (parsed.data.access || orgId)) {
      res.status(400).json({ error: { code: "scopes_and_access", message: "A token has capability scopes or a workspace and access level, not both." } });
      return;
    }
    const access = parsed.data.access ?? (orgId ? "change" : null);
    const requested = parsed.data.scopes ?? [];
    const unknown = requested.filter((r) => !cleanScopes.includes(r));
    if (unknown.length > 0) {
      res.status(400).json({
        error: {
          code: "unknown_scope",
          message:
            `This build does not recognise: ${unknown.join(", ")}. ` +
            "Either the name is wrong, or this instance is older than the scope. " +
            "No token was created.",
          details: { unknown, granted: cleanScopes },
        },
      });
      return;
    }
    // Minted with a token: the child never outlives or out-reaches it
    // (auth/token-lineage.ts).
    let terms = {
      // A bare day lasts through that day (#5759).
      expires_at: instantFromInput(parsed.data.expires_at, null, "end"),
      org_id: orgId,
      scopes: cleanScopes.length > 0 ? cleanScopes : null,
      access: access as TokenAccess | null,
    };
    let parentTokenId: string | null = null;
    if (req.session!.auth_method === "api_token" && req.session!.api_token_id) {
      const parent = await meta
        .selectFrom("api_tokens")
        .select(["id", "expires_at", "org_id", "scopes", "access"])
        .where("id", "=", req.session!.api_token_id)
        .executeTakeFirst();
      if (!parent) {
        res.status(401).json({ error: { code: "token_gone", message: "The token making this one no longer exists." } });
        return;
      }
      const child = childTerms(
        { expires_at: parent.expires_at, org_id: parent.org_id, scopes: parent.scopes?.length ? parent.scopes : null, access: isTokenAccess(parent.access) ? parent.access : null },
        terms,
      );
      if (!child.ok) {
        res.status(400).json({ error: { code: "token_beyond_parent", message: `${child.message} No token was created.` } });
        return;
      }
      terms = child.terms;
      parentTokenId = parent.id;
    }
    // check-then-insert: the key is a random token's hash minted here
    const inserted = await meta
      .insertInto("api_tokens")
      .values({
        user_id: req.session!.id,
        name: parsed.data.name.trim(),
        token_hash: hash,
        token_prefix: tokenPrefix,
        expires_at: terms.expires_at,
        // Empty → NULL = unrestricted (legacy). Non-empty = deny-by-default.
        scopes: terms.scopes,
        parent_token_id: parentTokenId,
        source: parsed.data.source?.trim() || null,
        // jsonb: pg parses the JSON string on insert (same idiom as blueprint).
        meta: parsed.data.meta ? JSON.stringify(parsed.data.meta) : null,
        org_id: terms.org_id,
        access: terms.access,
      })
      .returning(["id", "name", "token_prefix", "expires_at", "created_at", "scopes", "source", "meta", "org_id", "access"])
      .executeTakeFirstOrThrow();
    // A key to a workspace is that workspace's business: its activity says
    // a token was made for it, and by whom (never the secret).
    if (inserted.org_id) {
      await activity.log({ orgId: inserted.org_id, action: "api_token_created", ref: { module: null, entityType: "api_token", entityId: inserted.id }, diff: { name: inserted.name, access: inserted.access, expires_at: inserted.expires_at, minted_by_token: !!parentTokenId } }).catch(() => {});
    }
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
    .enum(ORG_ROLES)
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
/** Why a change to a link widens what it shares, or null when it only
 *  narrows it (or leaves it as it is). */
export function linkPatchWidens(
  now: { expires_at: Date | null; min_target_role: OrgRoleName | null },
  next: { expires_at?: Date | null; min_target_role?: OrgRoleName | null },
): string | null {
  if (next.expires_at !== undefined) {
    if (next.expires_at === null && now.expires_at !== null) return "Making it never expire widens it.";
    if (next.expires_at && now.expires_at && next.expires_at > now.expires_at) return "A later end widens it.";
  }
  if (next.min_target_role !== undefined) {
    const was = now.min_target_role ? ORG_ROLE_RANK[now.min_target_role] : -1;
    const will = next.min_target_role ? ORG_ROLE_RANK[next.min_target_role] : -1;
    if (will < was) return "Letting a lower role see them widens it.";
  }
  return null;
}

const LinkPatch = z.object({
  expires_at: z.string().datetime().nullable().optional(),
  min_target_role: z
    .enum(ORG_ROLES)
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
      const expiresDate = instantFromInput(parsed.data.expires_at, null, "end");
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
    // The records are the source's: its owner sets how far they reach. The
    // owner on the receiving side may only narrow that (an earlier end, a
    // higher role), never widen it: "never expires" or "every member" from
    // the side that does not own the records was a share its owner never gave.
    if (!ownsSource) {
      const widens = linkPatchWidens(
        { expires_at: link.expires_at ? new Date(link.expires_at) : null, min_target_role: (link.min_target_role as OrgRoleName | null) ?? null },
        patch as { expires_at?: Date | null; min_target_role?: OrgRoleName | null },
      );
      if (widens) {
        res.status(403).json({ error: { code: "not_yours_to_widen", message: `Only an owner of the workspace sharing these records can widen what it shares; from this side you can only narrow it. ${widens}` } });
        return;
      }
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
  /** Seed the invitee's new workspace from this workspace's blueprint (the
   *  caller must be owner/admin there). The config snapshot is embedded into
   *  the invite at mint time, so later edits don't retroactively change it. */
  from_workspace: z.string().max(80).optional(),
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
    // Premade workspace: capture the source workspace's blueprint NOW (an
    // embedded snapshot — later edits to the source don't change the invite).
    let blueprint: unknown = null;
    if (parsed.data.from_workspace) {
      const org = await meta
        .selectFrom("orgs")
        .innerJoin("org_memberships as m", "m.org_id", "orgs.id")
        .select(["orgs.id", "m.role"])
        .where("orgs.slug", "=", parsed.data.from_workspace)
        .where("m.user_id", "=", userId)
        .executeTakeFirst();
      // Copying a workspace's shape is builder work: the admin tier, by rank.
      if (!org || !roleSatisfies(org.role, ["owner", "admin"])) {
        res.status(403).json({
          error: { code: "forbidden", message: "You must be an owner/admin of the workspace you seed from." },
        });
        return;
      }
      blueprint = await captureBlueprint(org.id);
    }
    const token = randomBytes(24).toString("base64url");
    // Default expiry when none given — an invite link is a credential and
    // must not be redeemable forever (audit L-INVITE).
    const expires_at = inviteExpiresAt(parsed.data.expires_in_days);
    // check-then-insert: the key is a random invite token minted here
    const row = await meta
      .insertInto("signup_invites")
      .values({
        token,
        created_by: userId,
        invited_email: parsed.data.email?.toLowerCase().trim() ?? null,
        note: parsed.data.note ?? null,
        expires_at,
        blueprint: blueprint === null ? null : JSON.stringify(blueprint),
      })
      .returning(["id", "token", "invited_email", "note", "expires_at", "created_at"])
      .executeTakeFirstOrThrow();

    // If we have an address + a registered sender, email the join link straight
    // to the invitee; otherwise the owner copies the link by hand.
    let emailed = false;
    if (row.invited_email && hasAuthEmailSender()) {
      const link = `${linkOrigin(req)}/join/${row.token}`;
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
      .returning(["id", "name", "org_id"])
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "Token not found or already revoked" } });
      return;
    }
    // Every token it made, and theirs, goes with it.
    await sql`
      with recursive kids(id) as (
        select id from api_tokens where parent_token_id = ${updated.id}
        union all
        select t.id from api_tokens t join kids on t.parent_token_id = kids.id
      )
      update api_tokens set revoked_at = now() where id in (select id from kids) and revoked_at is null`.execute(meta);
    if (updated.org_id) {
      await activity.log({ orgId: updated.org_id, action: "api_token_revoked", ref: { module: null, entityType: "api_token", entityId: updated.id }, diff: { name: updated.name } }).catch(() => {});
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
    summary: "Cobblr can reach you here. Tap to turn on Discord notifications.",
    verify_token: token,
  });
  return { deliverable: res.deliverable };
}

// GET /me/discord — connection + verification status (drives the settings UI).
meRouter.get("/me/discord", requireAuth, async (req, res, next) => {
  try {
    const row = await meta
      .selectFrom("discord_connections")
      .select(["discord_user_id", "discord_username", "verified", "verified_app_id"])
      .where("user_id", "=", req.session!.id)
      .executeTakeFirst();
    // Lazy backfill: a row verified before the column existed is grandfathered
    // and stamped here, so deploying prompts nobody and only a genuine app
    // change does. Cheap, idempotent, and never runs twice for a row.
    if (needsAppStamp(row)) {
      await meta
        .updateTable("discord_connections")
        .set({ verified_app_id: discordAppId(), updated_at: new Date() })
        .where("user_id", "=", req.session!.id)
        .where("verified_app_id", "is", null)
        .execute();
    }
    const state = discordConnectionState(row);
    res.json({
      configured: discordConnectConfigured(),
      connected: Boolean(row?.discord_user_id),
      // `verified` stays the field the UI already reads, and now answers the
      // question that matters: can the app that is sending TODAY reach you.
      verified: state === "verified",
      /** True when a previous app verified this and a different one is now
       *  configured — connected, but needing one re-confirmation. */
      needs_reverify: state === "stale-app",
      username: row?.discord_username ?? null,
      invite_url: discordInviteUrl() || null,
    });
  } catch (err) {
    next(err);
  }
});

/** 08:00 local: what a connected Discord's "due today" digest starts at. */
const DISCORD_DIGEST_DEFAULT_MINUTE = 480;

// POST /me/discord/oauth-start — returns the Discord authorize URL.
meRouter.post("/me/discord/oauth-start", requireAuth, async (req, res, next) => {
  try {
    if (!discordConnectConfigured()) {
      res.status(503).json({ error: { code: "not_configured", message: "Discord isn't set up on this server yet." } });
      return;
    }
    // The morning digest, chosen already: someone connecting Discord for
    // "tell me before my veggies go off" wants one list at breakfast, not a
    // ping per carton at midnight. Only when they have not chosen a cadence
    // for Discord themselves (a row there is their choice and stays), and
    // only in a zone the browser named, so 08:00 is their 08:00. Said on the
    // page, and changed there.
    const tz = typeof req.body?.timezone === "string" ? req.body.timezone.trim() : "";
    let zoneOk = false;
    try {
      if (tz) {
        new Intl.DateTimeFormat("en-GB", { timeZone: tz });
        zoneOk = true;
      }
    } catch {
      zoneOk = false;
    }
    if (zoneOk) {
      await meta
        .insertInto("notification_delivery_windows")
        .values({
          user_id: req.session!.id,
          channel: "discord_dm",
          mode: "immediate",
          timezone: tz,
          schedule_mode: "daily",
          schedule_deliver_at_minute: DISCORD_DIGEST_DEFAULT_MINUTE,
        })
        .onConflict((oc) => oc.columns(["user_id", "channel"]).doNothing())
        .execute();
      forgetTimeZone(req.session!.id);
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
        // Cleared with `verified`: a fresh link has proved nothing yet, and a
        // stamp left from a previous app would outlive the thing it described.
        verified_app_id: null,
        connected_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((c) =>
        c.column("user_id").doUpdateSet({
          discord_user_id: identity.id,
          discord_username: identity.username,
          verified: false,
          verified_app_id: null,
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

// ───────────────── Keeping photos of filed items (#3769 step 3) ─────────────
// GET /me/photo-consent — whether the setting exists here yet, and the
// account's choice with its dates.
meRouter.get("/me/photo-consent", requireAuth, async (req, res, next) => {
  try {
    res.json(await photoConsentOf(req.session!.id));
  } catch (err) {
    next(err);
  }
});

const PhotoConsentBody = z.object({ keep: z.boolean() });

// AI-REACH: exempt a person's own consent about their photos is theirs to give in Your account; an assistant never gives or withdraws it on their behalf
meRouter.put("/me/photo-consent", requireAuth, async (req, res, next) => {
  try {
    const parsed = PhotoConsentBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Say keep: true or keep: false.", details: parsed.error.issues } });
      return;
    }
    res.json(await setPhotoConsent(req.session!.id, parsed.data.keep));
  } catch (err) {
    if (err instanceof PhotoConsentRefused) {
      res.status(err.code === "trial" ? 403 : 409).json({ error: { code: err.code, message: err.message } });
      return;
    }
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
