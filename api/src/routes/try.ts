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
//   POST /try/carry      → a kept trial's grant for another deployment to read it
//   GET  /try/carry/:t   → what that deployment replays (and /files/:id, its pictures)
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
  handOverSandbox,
  keepSandbox,
  keptSandboxForUser,
  ownSandboxForUser,
  provisionSandboxWorkspace,
  sandboxDecisionMs,
  setKeptSandboxPassword,
  redeemSandboxToken,
  sandboxCapacity,
  sandboxEnabled,
  sandboxLifetime,
  type SandboxResult,
} from "../platform/try-sandbox.js";
import { seedSandbox } from "../platform/try-sandbox-seed.js";
import { trialLedger } from "../platform/trial-ledger.js";
import {
  carryPackage,
  confirmCarry,
  holdSandboxForCarry,
  mintCarryToken,
  packageFileIds,
  resolveCarryToken,
  CARRY_TOKEN_HOURS,
  type CarryPackage,
} from "../platform/trial-carry.js";
import { platform } from "@cobblr/platform-contract";
import { lifetimeSentence } from "@cobblr/platform-contract/sandbox-lifetime";
import { publicBaseUrl } from "../platform/public-url.js";
import { emptySandboxRecords } from "../platform/try-sandbox-records.js";
import { takeFromPool } from "../platform/try-sandbox-pool.js";
import { issueSignInLink } from "../platform/sign-in-link.js";
import { createSandboxExport, fetchSandboxExport } from "../platform/try-sandbox-export.js";
import { takeYourWorkEmail } from "../platform/try-sandbox-export-copy.js";
import { sendAuthEmail } from "../platform/hosted-seams.js";
import { intentQuery, startHtml, startIntentOf, startNonce, startPolicy } from "./try-start-page.js";
import { trackProductEvent } from "../platform/product-events.js";
import { goneHtml } from "./try-gone-page.js";
import { KEPT_TRIALS_PER_ADDRESS, consumeKeepJoin, requestKeepJoin } from "../platform/try-keep-join.js";

/** Not an error: a pooled sandbox was filled before it was handed over, so the
 *  seed step is skipped rather than run a second time and double everything. */

export const tryRouter = Router();

/** The page a visitor lands on when their hour is up, or the link is wrong.
 *  Deliberately a real page rather than a JSON error: this URL is opened by a
 *  human in a browser, often hours later, and a raw 410 body reads as broken
 *  software rather than an expected ending. */


// ── GET /try — draw the challenge (free), then hand off to /try/start ─────
//
// Split from the provisioning route on purpose. The rate limiter is generic
// middleware that counts ARRIVALS at a path, so while one path both drew the
// page and made the sandbox, simply looking spent the budget: open the link,
// refresh once, and a per-IP cap of two locked you out for an hour with nothing
// to show for it. Looking is free now; asking is what counts.
tryRouter.get(
  "/try",
  (req: Request, res: Response): void => {
    if (!sandboxEnabled()) {
      res.status(404).json({ error: { code: "not_found", message: "Not found" } });
      return;
    }
    const key = captchaEnabled() ? captchaSiteKey() : null;
    // Where the visitor is headed (the booth's `start=scan`) and where they came
    // from (a QR's `source=3DP2026`), cleaned to a closed shape here and carried
    // through the challenge to /try/start.
    const intent = startIntentOf(req.query as Record<string, unknown>);
    // No challenge to draw (captcha off on this box, or misconfigured): go
    // straight through rather than showing a widget that cannot appear.
    if (!key) {
      res.redirect(303, `/api/v1/try/start${intentQuery(intent).replace(/^&/, "?")}`);
      return;
    }
    // This page carries its OWN policy, not the app's: it needs Turnstile's
    // script, a frame of it and two hosts to call home to, and the app's
    // `script-src 'self'` would refuse every one of them the day it is
    // enforced -- which would mean nobody could get a sandbox at all (#3434).
    // The nonce is minted here and handed to both halves, so the header and
    // the script tag cannot disagree.
    //
    // nginx does not add its own CSP to a response that sends one
    // (docker/nginx.conf keys the exemption on the upstream header) -- two Content-Security-Policy
    // headers are enforced as their INTERSECTION, so an inherited strict one
    // would block the widget however wide this policy is.
    const nonce = startNonce();
    res.setHeader("Content-Security-Policy", startPolicy(nonce));
    res.type("html").send(startHtml(key, nonce, intent));
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
      let sandbox: SandboxResult;
      if (pooled) {
        sandbox = pooled;
        console.log(`[try-sandbox] handed over ${sandbox.slug} from the pool`);
      } else {
        const ws = await provisionSandboxWorkspace({
          provisionOrg: async (userId, name) => {
            const r = await provisionOrgForUser(userId, name);
            return { orgId: r.orgId, slug: r.slug };
          },
          enableDefaults: (orgId, userId) => enableDefaultModulesForOrg(orgId, userId),
        });
        // An empty workspace is a poor first impression - the lesson the demo
        // taught. Best-effort: a seed that fails leaves a usable empty sandbox
        // rather than no sandbox. Seeded BEFORE the hand-over, as the pool
        // does, so the stock sits on the platform's side of the ledger's
        // starting line on both paths (trial-ledger.ts).
        try {
          const seed = await seedSandbox(ws.orgId, ws.userId, env.TRY_SANDBOX_SEED, ws.slug);
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
          console.error("[try-sandbox] seed failed (continuing empty):", (err as Error).message);
        }
        sandbox = await handOverSandbox(ws);
      }

      const intent = startIntentOf(req.query as Record<string, unknown>);
      console.log(
        `[try-sandbox] provisioned ${sandbox.slug} (${cap.live + 1}/${cap.max} live), expires ${sandbox.expiresAt.toISOString()}` +
          (intent.source ? `, source ${intent.source}` : "") +
          (intent.start ? `, start ${intent.start}` : ""),
      );
      // Which QR or link brought them: the booth's count of who scanned in.
      trackProductEvent({
        orgId: sandbox.orgId,
        event: "sandbox_started",
        detail: { source: intent.source, start: intent.start },
      });
      // 303: the browser must follow with GET regardless of how it got here.
      // `to=scan` sends the landing straight into the camera scanner.
      res.redirect(303, `/t/${sandbox.token}${intent.start ? `?to=${intent.start}` : ""}`);
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
// The length is ours (TRY_SANDBOX_TRIAL_DAYS), never the client's. A `days`
// an older client still sends is accepted and ignored, so that client keeps
// working and gets the configured length like everybody else.
const KeepBody = z.object({
  email: z.string().email().max(320),
  days: z.unknown().optional(),
});

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
      const days = env.TRY_SANDBOX_TRIAL_DAYS;
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
      }, days);
      if (!r.ok && r.reason === "email_taken") {
        // The address keeps a trial here already: this sandbox can join it,
        // once the address says yes (try-keep-join.ts). Never a dead end.
        const join = await requestKeepJoin({ orgId: membership.org_id, guestUserId: userId, accountUserId: r.accountUserId, email, absBase });
        if (!join.ok) {
          res.status(409).json({
            error: {
              code: "keep_limit",
              message: `That address already keeps ${KEPT_TRIALS_PER_ADDRESS} trials here, the most one address can. Move one to a real Cobblr account to make room, or use another address.`,
              details: { kept: join.kept },
            },
          });
          return;
        }
        console.log(`[try-sandbox] keep ${membership.org_id}: joins an existing account once its address says yes` + (join.emailed ? "" : " (NO EMAIL SENT)"));
        res.json({ ok: true, kind: "join_pending", expires_at: join.heldUntil.toISOString(), emailed: join.emailed, days, ...(join.devToken ? { dev_join_token: join.devToken } : {}) });
        return;
      }
      if (!r.ok) {
        res.status(400).json({ error: { code: r.reason, message: "This is not a sandbox workspace." } });
        return;
      }
      console.log(
        `[try-sandbox] kept ${membership.org_id} — now a ${days}d trial` +
          (r.emailed ? ", sign-in link sent" : ", NO EMAIL SENT (sandbox link left alive)"),
      );
      // `emailed` is not decoration: the UI must not tell someone to check an
      // inbox nothing was sent to.
      res.json({ ok: true, kind: r.kind, expires_at: r.expiresAt.toISOString(), emailed: r.emailed, days });
      return;
    } catch (err) {
      next(err);
    }
  },
);

// POST /try/join { token } — the address said yes: this sandbox becomes
// another of its workspaces, and the link signs the address in. No session:
// the token, sent only to that address, is the proof.
// AI-REACH: consumes a link from a person's own inbox; not an agent's to open.
tryRouter.post(
  "/try/join",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      const r = await consumeKeepJoin(token);
      if (!r.ok) {
        const message = {
          unknown: "This link is not one we sent.",
          used: "This link was already used. Sign in to find the workspace.",
          expired: "This link ran out, and the sandbox it was for is gone.",
          gone: "The sandbox this link was for is gone.",
          keep_limit: `That address already keeps ${KEPT_TRIALS_PER_ADDRESS} trials here, the most one address can.`,
        }[r.reason];
        res.status(r.reason === "unknown" ? 404 : 410).json({ error: { code: r.reason, message } });
        return;
      }
      console.log(`[try-sandbox] a sandbox joined an existing account as ${r.slug}`);
      res.json({ ok: true, token: await signSession(r.accountUserId), slug: r.slug, expires_at: r.expiresAt.toISOString() });
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
const TakeBody = z.object({
  email: z.string().email().max(255),
  /** Also the examples the sandbox came with. Off unless asked. */
  keep_examples: z.boolean().optional(),
});

/** The hosted product's /bring door for a take link, or null where this box
 *  names no hosted product (COBBLR_CLOUD_SIGNUP_URL). */
function bringUrl(link: string): string | null {
  if (!env.COBBLR_CLOUD_SIGNUP_URL) return null;
  try {
    return `${new URL(env.COBBLR_CLOUD_SIGNUP_URL).origin}/bring?file=${encodeURIComponent(link)}`;
  } catch {
    return null;
  }
}

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
      const made = await createSandboxExport(membership.org_id, membership.slug, email, Date.now(), { keepExamples: parsed.data.keep_examples === true });
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
        lifetime: lifetimeSentence(await sandboxLifetime(membership.org_id)),
        continueUrl: bringUrl(link),
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
      res.json({ ok: true, emailed: sent, link, continue_url: bringUrl(link), expires_at: made.expiresAt.toISOString(), days });
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

// ── GET /try/ledger — what the person built here ──────────────────────────
//
// The list the ending page shows under "What you built here", and later the
// picker for bringing it along (docs/design-decisions/trial-ledger.md). Their
// own sandbox or kept trial, found through their sandbox link rather than the
// workspace: past the hour every workspace route answers 410, and this has to
// read at exactly that moment.
tryRouter.get(
  "/try/ledger",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const own = await meta
        .selectFrom("try_sandbox_tokens as t")
        .innerJoin("orgs as o", "o.id", "t.org_id")
        .select(["o.id as org_id"])
        .where("t.user_id", "=", req.session!.id)
        .orderBy("t.expires_at", "desc")
        .executeTakeFirst();
      if (!own) {
        res.status(400).json({ error: { code: "not_sandbox", message: "This is not a sandbox workspace." } });
        return;
      }
      res.json(await trialLedger(own.org_id));
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /try/lifetime — what is true of the sandbox's work right now ──────
//
// The ending page and the take email say it in the same sentence
// (@cobblr/platform-contract/sandbox-lifetime), from this one read. Found
// through the person's sandbox link, like the ledger, so it answers during the
// hold when every workspace route is 410.
// AI-REACH: read-state (the person's own sandbox clock, for the ending page)
tryRouter.get(
  "/try/lifetime",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled()) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const own = await meta
        .selectFrom("try_sandbox_tokens as t")
        .select(["t.org_id"])
        .where("t.user_id", "=", req.session!.id)
        .orderBy("t.expires_at", "desc")
        .executeTakeFirst();
      if (!own) {
        res.status(400).json({ error: { code: "not_sandbox", message: "This is not a sandbox workspace." } });
        return;
      }
      res.json(await sandboxLifetime(own.org_id));
    } catch (err) {
      next(err);
    }
  },
);

// ── The carry door: "bring what I built" (docs/design-decisions/trial-ledger.md)
//
// POST /try/carry mints the person's grant to read their trial from another
// deployment. Kept trials only: the door keeps the sandbox first, so there is
// still a workspace to read once the hour is up, and a frozen sandbox answers
// 410 on every route the package is read through.
//
// AI-REACH: hands the person a credential to their own workspace for another
// server to present; an agent has no business minting one.
tryRouter.post(
  "/try/carry",
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled() || !env.COBBLR_TRY_CARRY) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      // A kept trial, or the person's own sandbox, live or inside its hold:
      // "Make this yours" leaves from the sandbox itself, with no keep first.
      // The sandbox is held open while they make their account, because the
      // package is read through its routes, which refuse one past its hour.
      const kept = await keptSandboxForUser(req.session!.id);
      const own = kept ? null : await ownSandboxForUser(req.session!.id);
      const orgId = kept?.orgId ?? own?.orgId;
      if (!orgId) {
        res.status(400).json({ error: { code: "not_kept", message: "There is no sandbox of yours to bring along." } });
        return;
      }
      if (own) await holdSandboxForCarry(own.orgId);
      const token = await mintCarryToken(orgId, req.session!.id);
      // Where the other side reads it back: this box's own public address.
      const source = (publicBaseUrl() || `${req.protocol}://${req.get("host") ?? ""}`).replace(/\/+$/, "");
      console.log(`[try-carry] org ${orgId}: carry token minted`);
      res.json({ token, source, expires_hours: CARRY_TOKEN_HOURS });
    } catch (err) {
      next(err);
    }
  },
);

// One read of a package serves the page that previews it and the replay that
// follows, and every picture in between: a short-lived cache keyed by token,
// so the file door can check a file against the package without rebuilding
// it once per picture.
const PACKAGE_TTL_MS = 10 * 60_000;
const packages = new Map<string, { at: number; pkg: CarryPackage; orgId: string }>();
async function packageFor(token: string): Promise<{ pkg: CarryPackage; orgId: string } | null> {
  const hit = packages.get(token);
  if (hit && Date.now() - hit.at < PACKAGE_TTL_MS) return hit;
  const who = await resolveCarryToken(token);
  if (!who) return null;
  const pkg = await carryPackage(who.orgId, who.userId);
  for (const [k, v] of packages) if (Date.now() - v.at >= PACKAGE_TTL_MS) packages.delete(k);
  const entry = { at: Date.now(), pkg, orgId: who.orgId };
  packages.set(token, entry);
  return entry;
}

// GET /try/carry/:token — the package. No session: the token IS the grant,
// like the sandbox link, and it is presented by another server.
tryRouter.get(
  "/try/carry/:token",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled() || !env.COBBLR_TRY_CARRY) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const got = await packageFor(String(req.params.token ?? ""));
      if (!got) {
        res.status(410).json({ error: { code: "carry_expired", message: "This link to bring your trial along has run out." } });
        return;
      }
      res.json(got.pkg);
    } catch (err) {
      next(err);
    }
  },
);

// POST /try/carry/:token/done — the other side says the carry landed, and the
// sandbox ends. No session: like the package, the token is the grant, and it
// is presented by the server that did the replay. An unknown or spent token is
// a 404 and ends nothing.
//
// AI-REACH: server to server, on a grant that only the replaying server holds;
// ending a workspace is not an agent's to do.
// UI-REACH: server to server, on a grant only the replaying server holds
tryRouter.post(
  "/try/carry/:token/done",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled() || !env.COBBLR_TRY_CARRY) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const token = String(req.params.token ?? "");
      const ended = await confirmCarry(token, sandboxDecisionMs());
      if (!ended) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      packages.delete(token);
      console.log("[try-carry] a carry landed; its sandbox ends");
      res.json({ ok: true, ended: true });
    } catch (err) {
      next(err);
    }
  },
);

// GET /try/carry/:token/files/:fileId — one picture the package names, and
// only those: the token reads what the ending listed, not the file store.
tryRouter.get(
  "/try/carry/:token/files/:fileId",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!sandboxEnabled() || !env.COBBLR_TRY_CARRY) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const got = await packageFor(String(req.params.token ?? ""));
      const fileId = String(req.params.fileId ?? "");
      if (!got || !packageFileIds(got.pkg).has(fileId)) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      const file = await platform().files.read(got.orgId, fileId, "original");
      if (!file) {
        res.status(404).json({ error: { code: "not_found", message: "Not found" } });
        return;
      }
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(file.filename)}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(Buffer.from(file.bytes));
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
    // How long keeping makes it a trial here, for the web to say in words.
    trial_days: env.TRY_SANDBOX_TRIAL_DAYS,
    // The ending page says exactly how long a frozen sandbox is held (#3254).
    decision_hours: env.TRY_SANDBOX_DECISION_HOURS,
    // Whether "bring what I built" leads to a real account that replays the
    // person's ledger: the operator says so (COBBLR_TRY_CARRY), because only
    // the operator knows the cloud side accepts a carry from here. While it is
    // false the web's third door is one honest line instead.
    carry_available: env.COBBLR_TRY_CARRY,
  });
});
