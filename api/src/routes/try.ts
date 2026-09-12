// Routes for the no-account sandbox. Spec: docs/design-decisions/try-sandbox.md
//
// These are registered ONLY when COBBLR_TRY_SANDBOX=true (see index.ts), so on
// prod, staging and every self-host the endpoints do not exist at all — a
// stronger guarantee than a handler that checks a flag and 404s, because there
// is nothing to reach.
//
//   GET  /try            → provision, redirect to /t/<token>
//   GET  /try/redeem     → exchange the token for a session (the SPA calls this)
//   POST /try/keep       → bind an email, become an ordinary 30-day trial
//
// The visitor's journey is one click: the homepage button hits GET /try, the
// server provisions and redirects to /t/<token>, the SPA there calls redeem,
// stores the JWT and lands them on /w/<slug>. They type nothing.
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../env.js";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { captchaEnabled, captchaSiteKey, verifyCaptcha } from "../platform/captcha.js";
import { provisionOrgForUser } from "./auth.js";
import { enableDefaultModulesForOrg } from "../modules/enable.js";
import { hashPassword } from "../auth/password.js";
import { signSession } from "../auth/jwt.js";
import {
  keepSandbox,
  keptSandboxForUser,
  provisionSandbox,
  setKeptSandboxPassword,
  redeemSandboxToken,
  sandboxCapacity,
  sandboxEnabled,
} from "../platform/try-sandbox.js";
import { seedSandbox } from "../platform/try-sandbox-seed.js";
import { emptySandboxRecords } from "../platform/try-sandbox-records.js";
import { takeFromPool } from "../platform/try-sandbox-pool.js";
import { issueSignInLink } from "../platform/sign-in-link.js";
import { createSandboxExport, fetchSandboxExport } from "../platform/try-sandbox-export.js";
import { takeYourWorkEmail } from "../platform/try-sandbox-export-copy.js";
import { sendAuthEmail } from "../platform/hosted-seams.js";
import { startHtml } from "./try-start-page.js";

/** Not an error: a pooled sandbox was filled before it was handed over, so the
 *  seed step is skipped rather than run a second time and double everything. */
class PooledAlready extends Error {}

export const tryRouter = Router();

/** The page a visitor lands on when their hour is up, or the link is wrong.
 *  Deliberately a real page rather than a JSON error: this URL is opened by a
 *  human in a browser, often hours later, and a raw 410 body reads as broken
 *  software rather than an expected ending. */
function goneHtml(reason: "expired" | "unknown" | "revoked"): string {
  const line =
    reason === "expired"
      ? "That sandbox has expired. They only last an hour, which is on purpose - nothing you did is still sitting on our server."
      : reason === "revoked"
        ? "That link was replaced when you added your email. Use the link we sent you instead."
        : "We do not recognise that link. It may have expired and been cleaned up.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Cobblr - sandbox ended</title>
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F2EA;color:#2b3038;
      font:16px/1.55 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
 .card{max-width:30rem;text-align:center}
 h1{font-size:1.6rem;color:#3D4451;margin:0 0 .6rem}
 p{margin:0 0 1.4rem;color:#5d5647}
 a{display:inline-block;border:2px solid #3D4451;border-radius:10px;padding:.7rem 1.3rem;
   background:#8B7355;color:#fff;font-weight:600;text-decoration:none;box-shadow:4px 4px 0 #3D4451}
 a.ghost{background:transparent;color:#3D4451;margin-left:.5rem}
</style></head><body><div class="card">
<h1>Your hour is up.</h1><p>${line}</p>
<a href="/api/v1/try">Start another</a><a class="ghost" href="/?mode=signup">Make an account</a>
</div></body></html>`;
}

// ── GET /try — draw the challenge (free), then hand off to /try/start ─────
//
// Split from the provisioning route on purpose. The rate limiter is generic
// middleware that counts ARRIVALS at a path, so while one path both drew the
// page and made the sandbox, simply looking spent the budget: open the link,
// refresh once, and a per-IP cap of two locked you out for an hour with nothing
// to show for it. Looking is free now; asking is what counts.
tryRouter.get(
  "/try",
  (_req: Request, res: Response): void => {
    if (!sandboxEnabled()) {
      res.status(404).json({ error: { code: "not_found", message: "Not found" } });
      return;
    }
    const key = captchaEnabled() ? captchaSiteKey() : null;
    // No challenge to draw (captcha off on this box, or misconfigured): go
    // straight through rather than showing a widget that cannot appear.
    if (!key) {
      res.redirect(303, "/api/v1/try/start");
      return;
    }
    res.type("html").send(startHtml(key));
  },
);

// ── GET /try/start — provision and hand over the link ─────────────────────
tryRouter.get(
  "/try/start",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }

      // Turnstile, when the box has it configured. Unconfigured is a no-op pass,
      // so a dev box works without keys — but this is the control that separates
      // "a script makes sixty sandboxes an hour" from "it does not", and the
      // deploy runbook requires it before this goes on the homepage.
      if (captchaEnabled()) {
        const token = typeof req.query.captcha === "string" ? req.query.captcha : undefined;
        if (!(await verifyCaptcha(token, req))) {
          res
            .status(400)
            .json({ error: { code: "captcha_failed", message: "Could not verify you are human." } });
          return;
        }
      }

      // The population cap. Rate limits bound arrivals; only this bounds how many
      // Postgres databases exist at once, which is the thing that actually falls
      // over. Answering "busy" is the correct behaviour, not an error.
      const cap = await sandboxCapacity();
      if (!cap.ok) {
        console.warn(`[try-sandbox] at capacity: ${cap.live}/${cap.max} live`);
        res.status(503).json({
          error: {
            code: "sandbox_busy",
            message: "A lot of people are trying Cobblr right now. Try again in a few minutes.",
          },
        });
        return;
      }

      // A ready-made one if the pool has any: instant, and its book covers are
      // already in place rather than filling in while somebody watches.
      const pooled = await takeFromPool();
      const sandbox =
        pooled ??
        (await provisionSandbox({
          provisionOrg: async (userId, name) => {
            const r = await provisionOrgForUser(userId, name);
            return { orgId: r.orgId, slug: r.slug };
          },
          enableDefaults: (orgId, userId) => enableDefaultModulesForOrg(orgId, userId),
        }));

      // An empty workspace is a poor first impression - the lesson the demo
      // taught. Best-effort: a seed that fails leaves a usable empty sandbox
      // rather than no sandbox.
      try {
        if (pooled) {
          console.log(`[try-sandbox] handed over ${sandbox.slug} from the pool`);
          throw new PooledAlready();
        }
        const seed = await seedSandbox(
          sandbox.orgId,
          sandbox.userId,
          env.TRY_SANDBOX_SEED,
          sandbox.slug,
        );
        // Say what landed, not that it ran. "seeded" with nothing in it is the
        // empty table this seed exists to prevent, and it should be legible in
        // the log the first time it happens rather than found by a visitor.
        const r = seed.contents;
        console.log(
          `[try-sandbox] seed ${seed.seeded ? seed.name : `skipped (${seed.reason})`}` +
            (r ? `: ${r.created} records${r.failed ? `, ${r.failed} FAILED` : ""}` : ""),
        );
        // Covers are still arriving; say so when they have, rather than holding
        // the visitor at a loading page for them.
        void r?.images.then((n) => console.log(`[try-sandbox] covers landed: ${n}`));
      } catch (err) {
        if (!(err instanceof PooledAlready)) {
          console.error("[try-sandbox] seed failed (continuing empty):", (err as Error).message);
        }
      }

      console.log(
        `[try-sandbox] provisioned ${sandbox.slug} (${cap.live + 1}/${cap.max} live), expires ${sandbox.expiresAt.toISOString()}`,
      );
      // 303: the browser must follow with GET regardless of how it got here.
      res.redirect(303, `/t/${sandbox.token}`);
      return;
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /try/redeem?token=… — the SPA exchanges the link for a session ────
tryRouter.get(
  "/try/redeem",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const token = typeof req.query.token === "string" ? req.query.token : "";
      if (!token) {
        res.status(400).json({ error: { code: "missing_token", message: "No token." } });
        return;
      }

      const r = await redeemSandboxToken(token);
      if (!r.ok) {
        // HTML for a browser, JSON for the SPA's fetch: the same URL is both a
        // page someone opens and an endpoint the app calls.
        if ((req.headers.accept ?? "").includes("text/html")) {
          res.status(410).type("html").send(goneHtml(r.reason));
          return;
        }
        res.status(410).json({ error: { code: `sandbox_${r.reason}`, message: "This sandbox has ended." } });
        return;
      }
      res.json({ token: r.sessionToken, slug: r.slug, expires_at: r.expiresAt.toISOString() });
      return;
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /try/keep — bind an email, become an account trial ───────────────
const KeepBody = z.object({ email: z.string().email().max(320) });

tryRouter.post(
  "/try/keep",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const parsed = KeepBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "A valid email is required." } });
        return;
      }
      const userId = req.session!.id;

      // The sandbox this session belongs to — a sandbox user owns exactly one.
      const membership = await meta
        .selectFrom("org_memberships")
        .innerJoin("orgs", "orgs.id", "org_memberships.org_id")
        .select(["orgs.id as org_id"])
        .where("org_memberships.user_id", "=", userId)
        .where("orgs.sandbox", "=", true)
        .executeTakeFirst();
      if (!membership) {
        res.status(400).json({ error: { code: "not_sandbox", message: "This is not a sandbox workspace." } });
        return;
      }

      const email = parsed.data.email.toLowerCase().trim();
      const absBase = `${req.protocol}://${req.get("host") ?? ""}`;
      const r = await keepSandbox(membership.org_id, userId, email, async (to) => {
        const issued = await issueSignInLink({
          email: to,
          absBase,
          ...keepLinkCopy(),
          requestIp: req.ip ?? null,
          requestUa: req.get("user-agent") ?? null,
        });
        return issued.sent;
      });
      if (!r.ok) {
        const status = r.reason === "email_taken" ? 409 : 400;
        const message =
          r.reason === "email_taken"
            ? "That email already has an account. Sign in with it instead."
            : "This is not a sandbox workspace.";
        res.status(status).json({ error: { code: r.reason, message } });
        return;
      }
      console.log(
        `[try-sandbox] kept ${membership.org_id} — now a ${env.TRY_TTL_DAYS}d trial` +
          (r.emailed ? ", sign-in link sent" : ", NO EMAIL SENT (sandbox link left alive)"),
      );
      // `emailed` is not decoration: the UI must not tell someone to check an
      // inbox nothing was sent to.
      res.json({ ok: true, kind: r.kind, expires_at: r.expiresAt.toISOString(), emailed: r.emailed });
      return;
    } catch (err) {
      next(err);
    }
  },
);

// ── after keeping: the strip's two buttons ────────────────────────────────
//
// Keeping binds an email and sends a sign-in link, and that used to be the
// whole story: the person was still standing in the tab, with no password, and
// the only door back in was an email that may or may not arrive. These two
// routes are the strip's answer. Both are gated on keptSandboxForUser: they
// exist for the person who just gave their address, and nobody else.

/** Sends the sign-in link again, to the address keep bound. */
function keepLinkCopy() {
  return {
    subject: "Your Cobblr workspace is saved",
    intro:
      "Your sandbox is now a real workspace, with everything you put in it. " +
      "This link signs you in:",
  };
}

// POST /try/resend-link
// AI-REACH: sends a sign-in link to the account's own address. A credential
// action the person takes on themselves from the strip; an agent has no
// business asking for someone's way in.
tryRouter.post(
  "/try/resend-link",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const kept = await keptSandboxForUser(req.session!.id);
      if (!kept) {
        res.status(400).json({ error: { code: "not_kept", message: "Keep the workspace first." } });
        return;
      }
      const issued = await issueSignInLink({
        email: kept.email,
        absBase: `${req.protocol}://${req.get("host") ?? ""}`,
        ...keepLinkCopy(),
        requestIp: req.ip ?? null,
        requestUa: req.get("user-agent") ?? null,
      });
      console.log(`[try-sandbox] resent sign-in link for org ${kept.orgId}` + (issued.sent ? "" : " (NOT sent)"));
      res.json({ ok: true, emailed: issued.sent, email: kept.email });
      return;
    } catch (err) {
      next(err);
    }
  },
);

const SetPasswordBody = z.object({ password: z.string().min(8).max(200) });

// POST /try/set-password
// AI-REACH: chooses the account's password. Self-only credential write, the
// same class as /me/password; never reachable by an agent.
tryRouter.post(
  "/try/set-password",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const parsed = SetPasswordBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "At least 8 characters." } });
        return;
      }
      const kept = await keptSandboxForUser(req.session!.id);
      if (!kept) {
        res.status(400).json({ error: { code: "not_kept", message: "Keep the workspace first." } });
        return;
      }
      await setKeptSandboxPassword(req.session!.id, await hashPassword(parsed.data.password));
      const token = await signSession(req.session!.id);
      console.log(`[try-sandbox] password set for org ${kept.orgId}; sandbox links closed`);
      res.json({ ok: true, token, email: kept.email });
      return;
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /try/take — "email me my work" ───────────────────────────────────
//
// The other door out of a sandbox, and the one most people will use. Keeping the
// workspace means committing to an account; this means "I liked that, send me
// what I made and tell me how to carry on", which is a much smaller thing to ask
// of somebody twenty minutes into their first look.
//
// It sends the same two paths the modal shows - the hosted service and running
// it yourself - because a person who has just built something in a sandbox is
// exactly the one who has not decided, and the export opens either door.
const TakeBody = z.object({ email: z.string().email().max(255) });

tryRouter.post(
  "/try/take",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const parsed = TakeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "A valid email is required." } });
        return;
      }
      const userId = req.session!.id;
      const membership = await meta
        .selectFrom("org_memberships")
        .innerJoin("orgs", "orgs.id", "org_memberships.org_id")
        .select(["orgs.id as org_id", "orgs.slug as slug"])
        .where("org_memberships.user_id", "=", userId)
        .executeTakeFirst();
      if (!membership) {
        res.status(400).json({ error: { code: "not_sandbox", message: "No workspace to export." } });
        return;
      }

      const email = parsed.data.email.toLowerCase().trim();
      const made = await createSandboxExport(membership.org_id, membership.slug, email);
      if (!made.ok) {
        res.status(413).json({
          error: { code: "export_too_large", message: "That workspace is too big to email. Keep it instead." },
        });
        return;
      }

      const base = `${req.protocol}://${req.get("host") ?? ""}`;
      const link = `${base}/api/v1/try/take/${made.token}`;
      const days = env.TRY_SANDBOX_EXPORT_DAYS;
      const mail = takeYourWorkEmail({
        link,
        days,
        cloudUrl: env.COBBLR_CLOUD_SIGNUP_URL,
        selfhostUrl: env.COBBLR_SELFHOST_DOCS_URL,
      });
      const sent = await sendAuthEmail({ to: email, subject: mail.subject, text: mail.text, kind: "magic_link" });
      console.log(
        `[try-sandbox] export for ${membership.slug}: ${Math.round(made.sizeBytes / 1024)}kB, ` +
          (sent ? "emailed" : "EMAIL FAILED"),
      );
      // `emailed: false` is not a failure of the export - the file exists and
      // the link is returned, so the modal can show it rather than pretending an
      // inbox has something in it.
      res.json({ ok: true, emailed: sent, link, expires_at: made.expiresAt.toISOString(), days });
      return;
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /try/take/:token — download it ────────────────────────────────────
//
// No auth: the token IS the credential, exactly like the sandbox link. It is in
// one email and nowhere else, and it addresses a file somebody asked us to send
// them.
tryRouter.get(
  "/try/take/:token",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const got = await fetchSandboxExport(String(req.params.token ?? ""));
      if (!got.ok) {
        // A person opening a link from an old email deserves a page, not JSON.
        res.status(410).type("html").send(goneHtml(got.reason === "expired" ? "expired" : "unknown"));
        return;
      }
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${got.filename}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(got.bytes);
      return;
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /try/paths — the two ways to carry on ─────────────────────────────
//
// So the modal shows the SAME destinations the email does, from one place. Two
// copies of these URLs would drift, and the half that drifts is the one nobody
// clicks while testing.
// Empty the sandbox of records, keeping its shape.
//
// The entrance stays seamless on purpose: no "stocked or blank?" question at
// the door, because that asks somebody to choose before either word means
// anything. They arrive stocked, poke at real data, and clear it when they know
// what they want their own to look like.
tryRouter.post(
  "/try/empty",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      // Only ever a sandbox this session actually owns. Emptying a workspace is
      // not something a stray token gets to do to somebody's real records.
      const membership = await meta
        .selectFrom("org_memberships")
        .innerJoin("orgs", "orgs.id", "org_memberships.org_id")
        .select(["orgs.slug as slug"])
        .where("org_memberships.user_id", "=", req.session!.id)
        .where("orgs.sandbox", "=", true)
        .executeTakeFirst();
      if (!membership) {
        res.status(400).json({ error: { code: "not_sandbox", message: "This is not a sandbox workspace." } });
        return;
      }
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!bearer) {
        res.status(401).json({ error: { code: "unauthorized", message: "Sign in first." } });
        return;
      }
      res.json(await emptySandboxRecords(membership.slug, bearer));
    } catch (err) {
      next(err);
    }
  },
);

tryRouter.get("/try/paths", (_req: Request, res: Response): void => {
  // Empty means "this deployment does not offer that path", and the modal and
  // the email both simply leave it out rather than showing a dead link.
  res.json({
    cloud_url: env.COBBLR_CLOUD_SIGNUP_URL || null,
    selfhost_url: env.COBBLR_SELFHOST_DOCS_URL || null,
    export_days: env.TRY_SANDBOX_EXPORT_DAYS,
  });
});
