// Sign in with the instance's own OpenID Connect provider (#4492). The
// decisions live in platform/oidc.ts; these are its doors:
//
//   GET  /auth/oidc/providers         what the sign-in page offers, and whether
//                                     password sign-in is on (public)
//   GET  /auth/oidc/:slug/start       off to the provider (public)
//   GET  /auth/oidc/callback          back from it: checked, then a one-time
//                                     code to the web page (public)
//   POST /auth/oidc/redeem            the code for a session (public)
//   GET  /auth/oidc/:slug/sign-out    the provider's sign-out address, if any
//   GET  /me/oidc                     the person's linked sign-ins
//   POST /me/oidc/:slug/link          link one (signed in: that is the proof)
//   DELETE /me/oidc/:slug             unlink, never the last way in
//   /super-admin/sign-in/…            the operator's providers and the
//                                     password switch
import { productName } from "../platform/product-name.js";
import { Router, type Request } from "express";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth, requirePlatformAdmin } from "../auth/middleware.js";
import { makeIpLimiter, overLimit, rateLimited } from "../platform/ip-limiter.js";
import { linkOrigin } from "../platform/link-origin.js";
import { createAccount } from "../platform/accounts.js";
import {
  GroupRole,
  adminsSignedInThroughAProvider,
  applyGroupRoles,
  describeProvider,
  endSessionUrl,
  finishLogin,
  mintHandoff,
  passwordSignInOn,
  publicProvider,
  redeemHandoff,
  sealSecret,
  setPasswordSignIn,
  startLogin,
  type ProviderRow,
} from "../platform/oidc.js";
import { buildAuthResponse, provisionOrgForUser } from "./auth.js";
import { optionalText } from "@cobblr/platform-contract/optional-fields";

const startLimiter = makeIpLimiter(60_000, 30);
const redeemLimiter = makeIpLimiter(60_000, 30);

/** Where this instance lives, for the redirect URI and the hand-back
 *  (link-origin.ts: the configured public address first). The provider only
 *  ever sends a code to a redirect URI registered with it. */
const origin = (req: Request) => linkOrigin(req);
const redirectUri = (req: Request) => `${origin(req)}/api/v1/auth/oidc/callback`;

async function provider(slug: string): Promise<ProviderRow | undefined> {
  return meta.selectFrom("oidc_providers").selectAll().where("slug", "=", slug).where("enabled", "=", true).executeTakeFirst();
}

export const oidcAuthRouter = Router();

oidcAuthRouter.get("/oidc/providers", async (_req, res, next) => {
  try {
    const rows = await meta.selectFrom("oidc_providers").select(["slug", "display_name"]).where("enabled", "=", true).orderBy("display_name").execute();
    res.json({ items: rows, password_signin: await passwordSignInOn() });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt: a browser's trip to its sign-in provider, not an action.
oidcAuthRouter.get("/oidc/:slug/start", async (req, res) => {
  try {
    if (overLimit(startLimiter, req)) {
      return void res.redirect(302, `${origin(req)}/sign-in/oidc?${new URLSearchParams({ error: "slow_down", message: "That is a lot of sign-ins at once. Wait a minute, then try again." })}`);
    }
    const p = await provider(String(req.params.slug));
    if (!p) return void res.redirect(302, `${origin(req)}/sign-in/oidc?error=provider_off`);
    res.redirect(302, await startLogin(p, "signin", null, redirectUri(req)));
  } catch (err) {
    // A browser came here: it gets a page with the reason, never JSON.
    console.error(`[oidc] start failed: ${(err as Error).message}`);
    res.redirect(302, `${origin(req)}/sign-in/oidc?${new URLSearchParams({ error: "provider_unreachable", message: `Your sign-in provider did not answer. Try again in a moment; if it keeps happening, tell whoever runs this ${productName()}.` })}`);
  }
});

oidcAuthRouter.get("/oidc/callback", async (req, res) => {
  try {
    const back = (q: Record<string, string>) => `${origin(req)}/sign-in/oidc?${new URLSearchParams(q).toString()}`;
    const out = await finishLogin(new URL(req.originalUrl, "http://callback.invalid"));
    if (out.kind === "refused") return void res.redirect(302, back({ error: out.refusal.code, message: out.refusal.message }));
    if (out.kind === "linked") return void res.redirect(302, `${origin(req)}/me/identity?linked=${encodeURIComponent(out.provider.slug)}`);
    let userId: string;
    if (out.kind === "new-account") {
      userId = await createAccount(
        meta,
        { email: out.email, password_hash: "", display_name: out.name, email_verified_at: new Date() },
        { via: "oidc", provider: out.provider.display_name },
      );
      await meta.insertInto("user_oidc_links").values({ user_id: userId, provider_id: out.provider.id, subject: out.subject, email_at_link: out.email, last_used_at: new Date() }).execute();
      await applyGroupRoles(userId, out.provider, out.groups);
      // No workspace from the mapping: one of their own, as a new sign-up gets.
      const any = await meta.selectFrom("org_memberships").select("org_id").where("user_id", "=", userId).executeTakeFirst();
      if (!any) {
        try {
          await provisionOrgForUser(userId, `${out.name}'s workspace`);
        } catch (err) {
          console.error("[oidc] org provision failed:", (err as Error).message);
        }
      }
    } else {
      userId = out.userId;
      await applyGroupRoles(userId, out.provider, out.groups);
    }
    await meta.updateTable("users").set({ last_login_at: new Date() }).where("id", "=", userId).execute();
    res.redirect(302, back({ code: await mintHandoff(userId, out.provider.id) }));
  } catch (err) {
    // The provider sent a browser here: it gets a page with the reason, never JSON.
    console.error(`[oidc] callback failed: ${(err as Error).message}`);
    res.redirect(302, `${origin(req)}/sign-in/oidc?${new URLSearchParams({ error: "sign_in_failed", message: "Signing you in did not finish. Try again." })}`);
  }
});

// AI-REACH: exempt: the browser trading its one-time sign-in code for a session.
oidcAuthRouter.post("/oidc/redeem", async (req, res, next) => {
  try {
    if (overLimit(redeemLimiter, req)) return void rateLimited(res);
    const body = z.object({ code: z.string().min(20).max(200) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: { code: "invalid_body", message: "The sign-in code is missing." } });
    const got = await redeemHandoff(body.data.code);
    if (!got) return void res.status(410).json({ error: { code: "code_used", message: "That sign-in was already used or took too long. Sign in again." } });
    res.json({ ...(await buildAuthResponse(got.userId)), signed_in_with: got.providerSlug });
  } catch (err) {
    next(err);
  }
});

oidcAuthRouter.get("/oidc/:slug/sign-out", async (req, res, next) => {
  try {
    const p = await provider(String(req.params.slug));
    res.json({ url: p ? await endSessionUrl(p, `${origin(req)}/`) : null });
  } catch (err) {
    next(err);
  }
});

// ── The person's own links ──────────────────────────────────────────────────
export const oidcMeRouter = Router();

oidcMeRouter.get("/me/oidc", requireAuth, async (req, res, next) => {
  try {
    const providers = await meta.selectFrom("oidc_providers").select(["id", "slug", "display_name"]).where("enabled", "=", true).orderBy("display_name").execute();
    const links = await meta.selectFrom("user_oidc_links").select(["provider_id", "email_at_link", "last_used_at"]).where("user_id", "=", req.session!.id).execute();
    res.json({
      items: providers.map((p) => {
        const l = links.find((x) => x.provider_id === p.id);
        return { slug: p.slug, display_name: p.display_name, linked: !!l, email: l?.email_at_link ?? null, last_used_at: l?.last_used_at ?? null };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Your account → Identity & password → Sign in with
// AI-REACH: exempt: linking how a person signs in is theirs alone, signed in themselves.
oidcMeRouter.post("/me/oidc/:slug/link", requireAuth, async (req, res, next) => {
  try {
    // Being signed in is the proof the provider account is this person's: a
    // token, an app or a borrowed view is not them.
    if (req.session!.auth_method !== "session" || req.session!.share_view || req.session!.app_scope) {
      return void res.status(403).json({ error: { code: "needs_you", message: "Linking a sign-in needs you, signed in yourself." } });
    }
    const p = await provider(String(req.params.slug));
    if (!p) return void res.status(404).json({ error: { code: "not_found", message: "That way of signing in is not set up here." } });
    res.json({ url: await startLogin(p, "link", req.session!.id, redirectUri(req)) });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Your account → Identity & password → Sign in with → Unlink
// AI-REACH: exempt: how a person signs in is theirs alone.
oidcMeRouter.delete("/me/oidc/:slug", requireAuth, async (req, res, next) => {
  try {
    if (req.session!.auth_method !== "session" || req.session!.share_view) {
      return void res.status(403).json({ error: { code: "needs_you", message: "Unlinking a sign-in needs you, signed in yourself." } });
    }
    const p = await meta.selectFrom("oidc_providers").select(["id", "display_name"]).where("slug", "=", String(req.params.slug)).executeTakeFirst();
    if (!p) return void res.status(404).json({ error: { code: "not_found", message: "Not linked." } });
    const me = await meta.selectFrom("users").select(["password_hash", "identity_id"]).where("id", "=", req.session!.id).executeTakeFirstOrThrow();
    const others = await meta.selectFrom("user_oidc_links").select("id").where("user_id", "=", req.session!.id).where("provider_id", "!=", p.id).execute();
    const passwordWorks = me.password_hash.length > 0 && (await passwordSignInOn());
    if (!passwordWorks && !me.identity_id && others.length === 0) {
      return void res.status(409).json({
        error: { code: "last_way_in", message: `${p.display_name} is the only way you sign in here. Set a password first (if this ${productName()} allows one), or link another.` },
      });
    }
    await meta.deleteFrom("user_oidc_links").where("user_id", "=", req.session!.id).where("provider_id", "=", p.id).execute();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── The operator's settings ─────────────────────────────────────────────────
export const oidcAdminRouter = Router();
oidcAdminRouter.use(requireAuth, requirePlatformAdmin);

const ProviderBody = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Lowercase letters, digits and dashes."),
  display_name: z.string().min(1).max(60),
  issuer: z.string().url().max(500),
  client_id: z.string().min(1).max(500),
  /** Write-only. Omitted on an update: unchanged. "" clears it (a public client). */
  client_secret: optionalText(2000),
  scopes: z.string().max(500).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  email_claim: z.string().min(1).max(100).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  groups_claim: z.string().min(1).max(100).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  allow_signup: z.boolean().optional(),
  signup_groups: z.array(z.string().min(1).max(200)).max(50).optional(),
  group_roles: z.array(GroupRole).max(200).optional(),
  allow_http: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

oidcAdminRouter.get("/", async (req, res, next) => {
  try {
    const rows = await meta.selectFrom("oidc_providers").selectAll().orderBy("display_name").execute();
    res.json({
      providers: rows.map(publicProvider),
      password_signin: await passwordSignInOn(),
      admins_signed_in_through_a_provider: await adminsSignedInThroughAProvider(),
      redirect_uri: redirectUri(req),
    });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Super admin → Sign-in → Add a provider
// AI-REACH: exempt: an operator's instance setting holding a client secret.
oidcAdminRouter.post("/providers", async (req, res, next) => {
  try {
    const b = ProviderBody.safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: { code: "invalid_body", message: b.error.issues[0]?.message ?? "Check the provider's settings.", details: b.error.issues } });
    const { client_secret, group_roles, ...rest } = b.data;
    const taken = await meta.selectFrom("oidc_providers").select("id").where("slug", "=", rest.slug).executeTakeFirst();
    if (taken) return void res.status(409).json({ error: { code: "slug_taken", message: "Another provider uses that short name." } });
    const row = await meta
      .insertInto("oidc_providers")
      .values({ ...rest, client_secret_enc: client_secret ? sealSecret(client_secret) : null, ...(group_roles ? { group_roles: JSON.stringify(group_roles) } : {}) })
      // Saved twice at once: the second is refused like the check above.
      .onConflict((oc) => oc.column("slug").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!row) return void res.status(409).json({ error: { code: "slug_taken", message: "Another provider uses that short name." } });
    res.status(201).json(publicProvider(row));
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Super admin → Sign-in → a provider → Save
// AI-REACH: exempt: an operator's instance setting holding a client secret.
oidcAdminRouter.patch("/providers/:id", async (req, res, next) => {
  try {
    const b = ProviderBody.partial().safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: { code: "invalid_body", message: b.error.issues[0]?.message ?? "Check the provider's settings.", details: b.error.issues } });
    const { client_secret, group_roles, ...rest } = b.data;
    const row = await meta
      .updateTable("oidc_providers")
      .set({
        ...rest,
        ...(client_secret !== undefined ? { client_secret_enc: client_secret ? sealSecret(client_secret) : null } : {}),
        ...(group_roles ? { group_roles: JSON.stringify(group_roles) } : {}),
        // Saved in the UI: the operator's now, never overwritten from env.
        from_env: false,
        updated_at: new Date(),
      })
      .where("id", "=", String(req.params.id))
      .returningAll()
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No such provider." } });
    res.json(publicProvider(row));
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Super admin → Sign-in → a provider → Remove
// AI-REACH: exempt: an operator's instance setting.
oidcAdminRouter.delete("/providers/:id", async (req, res, next) => {
  try {
    if (!(await passwordSignInOn())) {
      const left = await meta.selectFrom("oidc_providers").select("id").where("enabled", "=", true).where("id", "!=", String(req.params.id)).execute();
      if (left.length === 0) return void res.status(409).json({ error: { code: "last_way_in", message: "Password sign-in is off, so this is how everyone signs in. Turn password sign-in on first." } });
    }
    await meta.deleteFrom("oidc_providers").where("id", "=", String(req.params.id)).execute();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Super admin → Sign-in → a provider → Test
// AI-REACH: exempt: an operator checking their provider answers.
oidcAdminRouter.post("/providers/:id/test", async (req, res, next) => {
  try {
    const row = await meta.selectFrom("oidc_providers").selectAll().where("id", "=", String(req.params.id)).executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No such provider." } });
    res.json(await describeProvider(row));
  } catch (err) {
    next(err);
  }
});

// UI-REACH: Super admin → Sign-in → Password sign-in
// AI-REACH: exempt: an operator's instance setting that can lock people out.
oidcAdminRouter.put("/password", async (req, res, next) => {
  try {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: { code: "invalid_body", message: "Say on or off." } });
    const out = await setPasswordSignIn(b.data.on);
    if (!out.ok) return void res.status(409).json({ error: { code: "no_admin_through_provider", message: out.message } });
    res.json({ password_signin: b.data.on });
  } catch (err) {
    next(err);
  }
});
