// Express app factory. Two-phase setup so module routers can attach
// between the platform's static routes and the 404 fallback:
//
//   createApp()   → builds the app, mounts platform routes,
//                   returns { app, v1Router } for further mounting
//   completeApp() → adds the 404 + error handler (call last)
//
// Index.ts owns the ordering: createApp → mountModules → completeApp
// → listen. That keeps module wiring out of the app constructor and
// makes the boot sequence explicit.

import compression from "compression";
import cors from "cors";
import express, { type Application, type Router } from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./env.js";
import { authRouter } from "./routes/auth.js";
import { requestGuardMiddleware } from "./platform/hosted-seams.js";
import { publicRouter } from "./routes/public.js";
import { changelogRouter } from "./routes/changelog.js";
import { meRouter } from "./routes/me.js";
import { connectionsRouter, workspaceAiSharesRouter } from "./routes/connections.js";
import { modulesRouter } from "./routes/modules.js";
import { orgsRouter } from "./routes/orgs.js";
import { platformOrgRouter } from "./routes/platform.js";
import { calendarOrgRouter, calendarPublicRouter } from "./routes/calendar.js";
import { bundlesRouter } from "./routes/bundles.js";
import { quickstartRouter } from "./routes/quickstart.js";
import { attentionRouter } from "./routes/attention.js";
import { edgeRouter } from "./routes/edge.js";
import { blueprintRouter } from "./routes/blueprint.js";
import { backupRouter, backupGoogleCallbackRouter } from "./routes/backup.js";
import { membersRouter, invitesRootRouter } from "./routes/members.js";
import { pairingsRouter } from "./routes/pairings.js";
import { portalRouter } from "./routes/portal.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { adminUsersRouter } from "./routes/admin-users.js";
import { superAdminRouter } from "./routes/super-admin.js";
import { feedbackRouter, feedbackInboundRouter } from "./routes/feedback.js";
import { receiptInboundRouter, receiptAddressRouter } from "./routes/receipt-ingest.js";
import { ravelryRouter } from "./routes/ravelry.js";
import { ravelryImportRouter } from "./routes/ravelry-import.js";
import { sandboxInstallRouter } from "./routes/sandbox-install.js";
import { registryRouter } from "./routes/registry.js";
import { customRolesRouter } from "./routes/custom-roles.js";
import { driveRouter } from "./routes/drive.js";
import { scanDriveRouter } from "./routes/scan-drive.js";
import { instancesRouter, overridesRouter } from "./routes/instances.js";
import { navHeadingsRouter } from "./routes/nav-headings.js";
import { requireAuth } from "./auth/middleware.js";
import { withTenant } from "./middleware/tenant.js";
import { resolveInstance } from "./middleware/instance.js";
import { dispatchInstanceItems } from "./modules/mount.js";
import { qrScanRouter } from "./routes/qr-scan.js";
import { integrationsInboundRouter } from "./routes/integrations-inbound.js";
import { hooksRouter } from "./routes/hooks.js";
import { desktopUpdatesRouter } from "./routes/desktop-updates.js";
import { hostedPanelsRouter } from "./routes/hosted-panels.js";
import { productEventsObserver } from "./platform/product-events.js";

export interface AppHandles {
  app: Application;
  v1Router: Router;
}

export function createApp(): AppHandles {
  const app = express();

  app.set("trust proxy", 1);

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression());
  // CORS: env-driven allowlist. Set CORS_ALLOWED_ORIGINS to a
  // comma-separated list in production (see docs/operations/PRODUCTION_DEPLOY.md).
  // Unset in dev = mirror request origin (matches the prior reflect-
  // any-origin behavior so local localhost:8088 ↔ localhost:4000 keeps
  // working without setup).
  const corsAllowlist = env.CORS_ALLOWED_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: corsAllowlist && corsAllowlist.length > 0 ? corsAllowlist : true,
      credentials: true,
    }),
  );
  // The edge relay's /respond carries base64 image/file bytes a bridge pulled
  // from a LAN source (sync image import) — larger than the default 1mb API cap.
  // Parse that ONE path at a higher limit BEFORE the global parser, which then
  // sees req._body already set and skips it. Every other path stays at 1mb.
  const relayRespondJson = express.json({ limit: "20mb" });
  app.use((req, res, next) =>
    req.method === "POST" && req.path.endsWith("/modules/digifab/edge/respond")
      ? relayRespondJson(req, res, next)
      : next(),
  );
  app.use(
    express.json({
      limit: "1mb",
      // Capture raw body bytes on inbound webhook paths so the receivers can
      // verify provider signatures (HMAC / Stripe) against the exact bytes that
      // were transmitted. Cheap (one toString per request, kept only on the
      // request object), bounded to the webhook paths — /integrations/ (the
      // per-workspace inbound receiver) and /hooks/ (the global public-webhook
      // receiver) — so we don't keep raw bytes for every API call.
      verify: (req, _res, buf) => {
        if (req.url?.startsWith("/api/v1/integrations/") || req.url?.startsWith("/api/v1/hooks/")) {
          (req as unknown as { rawBody?: string }).rawBody = buf.toString("utf8");
        }
      },
    }),
  );
  if (env.NODE_ENV !== "test") {
    app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  }

  // Thesis telemetry: every org-scoped 403 that leaves the api is a WALL a
  // real user hit — recorded as a product_events row. One observer covers
  // kernel routes and every module router. See platform/product-events.ts.
  app.use(productEventsObserver);

  const v1 = express.Router();

  v1.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "cobblr-api",
      env: env.NODE_ENV,
      // Deploy label (staging/production/development) for the web's env
      // indicator. `||` not `??`: COBBLR_ENV arrives as "" when unset.
      deploy_env: env.COBBLR_ENV || env.NODE_ENV,
      // Runtime build sha (set by the deploy env, not baked in the image) —
      // the web polls this to offer "new version — refresh" to open tabs.
      build_sha: process.env.COBBLR_BUILD_SHA || null,
      time: new Date().toISOString(),
    });
  });

  // Hosted-overlay request guard (rate-limit / abuse). No-op until the overlay
  // registers a guard; mounted after /healthz so health checks are never gated.
  v1.use(requestGuardMiddleware());

  v1.use("/auth", authRouter);
  v1.use(meRouter);
  v1.use(connectionsRouter);
  v1.use(ravelryRouter);
  // Public read endpoint for core-public-surfaces. No auth required;
  // token in the URL is the secret. Mounted on /api/v1/public/* —
  // outside /orgs because the URL carries no slug.
  v1.use("/public", publicRouter);
  // Public "What's new" feed — unauthenticated; serves the parsed CHANGELOG.md.
  v1.use("/changelog", changelogRouter);
  // Public iCal feed — unauthenticated; token in the URL is the secret.
  // GET /api/v1/calendar/:token.ics. Paste into Google Calendar / Apple
  // Calendar to subscribe. Outside /orgs (no slug in the URL).
  v1.use("/calendar", calendarPublicRouter);
  // QR scan target — unauthenticated GET that resolves a token to
  // (org, entity, mode). See modules/core-labels-qr.
  v1.use("/qr", qrScanRouter);
  // Inbound webhook receiver for core-integrations. Unauthenticated;
  // the token in the URL is the secret. See
  // modules/core-integrations.
  v1.use("/integrations", integrationsInboundRouter);
  // Global public-webhook receiver for ACCOUNT-LEVEL provider webhooks (Stripe
  // billing, etc.). Unauthenticated; the handler verifies its own signature.
  // Open core registers no handlers (404 until an overlay/module does). See
  // platform().http.registerWebhook + routes/hooks.ts.
  v1.use("/hooks", hooksRouter);
  // Auto-update feed for the Cobblr Edge Helper desktop app (account-level).
  v1.use("/desktop", desktopUpdatesRouter);
  // Inbound feedback email (reply-by-email). Unauthenticated at the router level;
  // the Cloudflare Email Worker authenticates with COBBLR_INBOUND_EMAIL_SECRET.
  v1.use(feedbackInboundRouter);
  // Inbound receipt email (forward a receipt → scan inbox). Unauthenticated at
  // the router level; the Cloudflare Email Worker authenticates with
  // COBBLR_INBOUND_EMAIL_SECRET. See routes/receipt-ingest.ts.
  v1.use(receiptInboundRouter);
  v1.use("/orgs", orgsRouter);
  // platformOrgRouter mounts /:slug/entity-kinds, /:slug/entities/:kind/:id,
  // /:slug/actions, /:slug/bindings, /:slug/field-defs, etc. Composed
  // onto /orgs so it inherits the same routing tree.
  v1.use("/orgs", platformOrgRouter);
  // Workspace calendar — aggregated events + iCal feed config (authed).
  v1.use("/orgs", calendarOrgRouter);
  // The caller's per-workspace receipt-forwarding address (authed).
  v1.use("/orgs", receiptAddressRouter);
  // Member portal config + per-action capability grants.
  v1.use("/orgs", portalRouter);
  // Generic hosted settings panels — empty in open core; the overlay registers
  // billing/Slack. The web app renders them with one generic renderer.
  v1.use("/orgs", hostedPanelsRouter);
  // Admin dashboard widget arrangement (order + visibility).
  v1.use("/orgs", dashboardRouter);
  // Admin user creation (no-email onboarding flow).
  v1.use("/orgs", adminUsersRouter);
  // Custom roles (S2): workspace-defined capability bundles.
  v1.use("/orgs", customRolesRouter);
  // Browser driving (Feature 3): SSE relay so Claude (via MCP) can drive the
  // user's open tab — gated by a per-workspace grant + a drive:control token.
  v1.use("/orgs", driveRouter);
  // A scan drives the user's designated tab (scan-drives-screen, Phase 1).
  v1.use("/orgs", scanDriveRouter);
  // Super-admin (platform operator) surface — cross-workspace
  // dashboards. Gated by SUPERADMIN_EMAILS env var.
  v1.use("/super-admin", superAdminRouter);
  // User feedback about the platform (submit: any authed user; triage: super-admin).
  v1.use("/feedback", feedbackRouter);
  // Sandbox marketplace runtime install (super-admin only). Backs
  // the "Browse + Install" UI: fetch registry, verify, extract,
  // register without restart. See sandbox-install.ts +
  // docs/architecture/module-isolation.md.
  v1.use("/sandbox", sandboxInstallRouter);
  v1.use("/registry", registryRouter);
  // Bundles live one layer further down — same auth + tenant
  // middleware, dedicated mount for clarity.
  v1.use("/orgs/:slug/bundles", bundlesRouter);
  // Capture-first onboarding: the flagship bundle menu, the pending-capture
  // rollup, and materialize (install a bundle + batch-commit captures). See
  // docs/design-decisions/capture-first-onboarding.md.
  v1.use("/orgs/:slug/quickstart", quickstartRouter);
  v1.use("/orgs/:slug/attention", attentionRouter);
  // Generic edge-bridge surface: the dial-out relay wire, the pane of glass,
  // the consumer registry, and the bridge self-update release. Module paths
  // (digifab's /modules/digifab/edge/*) remain as wire-compatible aliases.
  v1.use("/orgs/:slug/edge", edgeRouter);
  // Blueprint (workspace setup snapshot) + Backup (setup + data + files).
  // Both sit at the workspace level above bundles. See
  // docs/architecture/blueprint-backup-export.md.
  v1.use("/orgs/:slug/blueprint", blueprintRouter);
  v1.use("/orgs/:slug/backup", backupRouter);
  // Google Drive OAuth callback (the fixed redirect URI — not org-scoped).
  v1.use(backupGoogleCallbackRouter);
  v1.use("/orgs/:slug/members", membersRouter);
  v1.use("/orgs/:slug/pairings", pairingsRouter);
  // Ravelry import — pull the user's stash + projects into this workspace's
  // Yarn bundle. Auth + tenant applied inside the router (per-route).
  v1.use("/orgs/:slug", ravelryImportRouter);
  // Workspace owner: review + approve members' AI-share offers.
  v1.use("/orgs/:slug", workspaceAiSharesRouter);
  v1.use("/orgs/:slug/instances", instancesRouter);
  // Instance-scoped item CRUD — resolves :instanceName → (module,
  // instance) then dispatches to the owning module's primary router
  // with req.instance set, so every query scopes to the instance.
  v1.use(
    "/orgs/:slug/instances/:instanceName/items",
    requireAuth,
    withTenant,
    resolveInstance,
    dispatchInstanceItems,
  );
  v1.use("/orgs/:slug/entity-kind-overrides", overridesRouter);
  v1.use("/orgs/:slug/nav-headings", navHeadingsRouter);
  // /invites/:token + accept don't take a tenant slug — auth-only.
  v1.use(invitesRootRouter);
  v1.use("/modules", modulesRouter);

  app.use("/api/v1", v1);

  return { app, v1Router: v1 };
}

/** Finalise the app — adds the 404 + error handler. Must be called
 *  AFTER all module routers have been mounted. */
export function completeApp(app: Application): void {
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
  });

  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      // Postgres 22P02 (invalid_text_representation) means a malformed
      // path/query value hit a typed column (e.g. a non-UUID :id). That's
      // a client error, not a server fault — answer 400, and never echo
      // the raw driver message (which the 500 path leaks in non-prod).
      if ((err as { code?: string }).code === "22P02") {
        res.status(400).json({
          error: { code: "invalid_input", message: "Malformed identifier or value." },
        });
        return;
      }
      console.error("[cobblr-api] unhandled", err);
      res.status(500).json({
        error: { code: "internal", message: env.NODE_ENV === "production" ? "Internal error" : err.message },
      });
    },
  );
}
