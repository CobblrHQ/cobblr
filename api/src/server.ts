import { GroupingError } from "@cobblr/platform-contract/grouped-list";
import { deletedRecordsRouter } from "./routes/deleted-records.js";
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

import { floorplanJsonSchema } from "@cobblr/platform-contract/floorplan-format";
import { lastOrphanFilesReport } from "./platform/heal-orphan-files.js";
import { WorkspaceNotProvisioned, WORKSPACE_NOT_CREATED_MESSAGE } from "./platform/provision-workspace.js";
import { SecretFieldError } from "./platform/secret-fields.js";
import { InvalidFieldValueError, UnknownFieldError } from "@cobblr/platform-contract/entity-metadata";
import { failingResolvers } from "./platform/resolver-failures.js";
import { oauthRouter, wellKnownRouter } from "./auth/oauth.js";
import { pendingMigrationSummary } from "./modules/enable.js";
import { failingTenantSweeps } from "./platform/tenant-sweeps.js";
import { healShimRuns } from "./platform/heal-shim-log.js";
import { passFailures } from "./platform/pass-failures.js";
import { metaPool } from "./db/meta.js";
import { currentRequestScope, requestLabel, runRequestScope } from "./lib/request-context.js";
import { rememberProbe } from "./platform/meta-probe.js";
import { tenantPoolStats } from "./db/tenant.js";
import { poolCounts } from "./db/pool-stats.js";
import { errors5xxRecent, noteResponse } from "./platform/error-rate.js";
import { guardRefusals } from "./platform/guard-refusals.js";
import { outboundReport, outboundSnapshot } from "./platform/outbound-reach.js";
import compression from "compression";
import cors from "cors";
import express, { type Application, type Router } from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./env.js";
import { authRouter } from "./routes/auth.js";
import { tryRouter } from "./routes/try.js";
import { carryRouter } from "./routes/carry.js";
import { sandboxEnabled } from "./platform/try-sandbox.js";
import { requestGuardMiddleware } from "./platform/hosted-seams.js";
import { publicRouter } from "./routes/public.js";
import { changelogRouter } from "./routes/changelog.js";
import { frameDocsRouter } from "./routes/frame-docs.js";
import { meRouter } from "./routes/me.js";
import { mePushOrgRouter, mePushRouter } from "./routes/me-push.js";
import { oidcAdminRouter, oidcAuthRouter, oidcMeRouter } from "./routes/oidc.js";
import { discordInteractionsRouter } from "./routes/discord-interactions.js";
import { testSupportRouter } from "./routes/test-support.js";
import { allowTestPushService } from "./platform/push-endpoints.js";
import { testDoorsEnabled } from "./platform/test-doors.js";
import { listRoutes } from "./lib/route-list.js";
import { connectionsRouter, workspaceAiSharesRouter } from "./routes/connections.js";
import { modulesRouter } from "./routes/modules.js";
import { orgsRouter } from "./routes/orgs.js";
import { servicesRouter } from "./routes/services.js";
import { servicesTestRouter } from "./platform/services-test-doors.js";
import { platformOrgRouter } from "./routes/platform.js";
import { calendarOrgRouter, calendarPublicRouter } from "./routes/calendar.js";
import { bundlesRouter } from "./routes/bundles.js";
import { quickstartRouter } from "./routes/quickstart.js";
import { tidyRouter } from "./routes/tidy-suggestions.js";
import { attentionRouter } from "./routes/attention.js";
import { edgePairRouter, edgeRouter } from "./routes/edge.js";
import { recordSendFileRouter } from "./routes/record-send-file.js";
import { recordSendRouter } from "./routes/record-send.js";
import { shareLinksOrgRouter, shareLinksRouter } from "./routes/share-links.js";
import { blueprintRouter } from "./routes/blueprint.js";
import { backupRouter, backupGoogleCallbackRouter } from "./routes/backup.js";
import { uploadReportsRouter } from "./routes/upload-reports.js";
import { outboundEmailRouter } from "./routes/outbound-email.js";
import { membersRouter, invitesRootRouter } from "./routes/members.js";
import { peopleRouter } from "./routes/people.js";
import { notificationAudiencesRouter } from "./routes/notification-audiences.js";
import { pairingsRouter } from "./routes/pairings.js";
import { portalRouter } from "./routes/portal.js";
import { diagnosticsRouter } from "./routes/diagnostics.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { adminUsersRouter } from "./routes/admin-users.js";
import { superAdminRouter } from "./routes/super-admin.js";
import { feedbackRouter, feedbackInboundRouter } from "./routes/feedback.js";
import { receiptInboundRouter, receiptAddressRouter } from "./routes/receipt-ingest.js";
import { inboundEmailRouter } from "./routes/inbound-email.js";
import { mailSourcesRouter, workspaceMailSourcesRouter } from "./routes/mail-sources.js";
import { mailboxCheckRouter } from "./routes/mailbox-check.js";
import { sandboxInstallRouter } from "./routes/sandbox-install.js";
import { registryRouter, registryPublicRouter, externalRegistry } from "./routes/registry.js";
import { listFlagshipManifests } from "./lib/flagship-bundles.js";
import { customRolesRouter } from "./routes/custom-roles.js";
import { driveRouter } from "./routes/drive.js";
import { resolveRouter } from "./routes/resolve.js";
import { scanDriveRouter } from "./routes/scan-drive.js";
import { scanStationsRouter } from "./routes/scan-stations.js";
import { stationDevicesRouter, stationPublicRouter } from "./routes/station-devices.js";
import { liveRouter } from "./routes/live.js";
import { instancesRouter, overridesRouter } from "./routes/instances.js";
import { navHeadingsRouter } from "./routes/nav-headings.js";
import { approvalRequestsRouter } from "./routes/approval-requests.js";
import { recordMoveRouter } from "./routes/record-move.js";
import { requireAuth } from "./auth/middleware.js";
import { withTenant } from "./middleware/tenant.js";
import { projectFieldScopes } from "./platform/field-scope-projection.js";
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
  // A Homebox export or a spreadsheet (core-import) is a whole inventory's
  // worth of rows in one body (a CSV, or a workbook as base64) — routinely
  // bigger than the 1mb default. Parse those core-import POST paths higher
  // BEFORE the global parser (same req._body-skip trick as the relay above);
  // every other path stays at 1mb.
  const importJson = express.json({ limit: "24mb" });
  app.use((req, res, next) =>
    req.method === "POST" && /\/modules\/core-import\/(homebox|sheets)/.test(req.path)
      ? importJson(req, res, next)
      : next(),
  );
  // A scan-inbox export with embedded photos is one JSON envelope carrying a
  // whole inbox's images as base64 (a real 69-item export is 5.4MB). Same
  // pre-mount pattern as above - and it MUST live here: a limit raised on the
  // module router is dead code, because this file's global 1mb parser has
  // already consumed and rejected the body before the router ever runs. That
  // exact mistake shipped once (#1534 claimed the route-level raise fixed it;
  // the live path still 500'd with PayloadTooLargeError until this).
  const scanImportJson = express.json({ limit: "32mb" });
  app.use((req, res, next) =>
    req.method === "POST" && /\/modules\/core-scan\/import(\/preview)?$/.test(req.path)
      ? scanImportJson(req, res, next)
      : next(),
  );
  // What another Cobblr sends over a share: changes (and a View as request)
  // signed over their exact bytes (so the raw body is kept), photos inline (so
  // the limit is high).
  // Same pre-mount pattern as above, for that one path.
  const shareOpsJson = express.json({
    limit: "64mb",
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  });
  app.use((req, res, next) =>
    req.method === "POST" && /^\/api\/v1\/share-links\/[^/]+\/[a-z-]+$/.test(req.path) ? shareOpsJson(req, res, next) : next(),
  );
  const sendFileJson = express.json({limit: "64mb"});
  app.use((req,res,next) => req.method === "POST" && /^\/api\/v1\/orgs\/[^/]+\/records\/send\/file\/(import|confirm|restore)$/.test(req.path) ? sendFileJson(req,res,next) : next());
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
        if (
          req.url?.startsWith("/api/v1/integrations/") ||
          req.url?.startsWith("/api/v1/hooks/") ||
          // Discord signs (timestamp + EXACT body bytes), so a re-serialised
          // req.body cannot be verified against it.
          req.url?.startsWith("/api/v1/discord/")
        ) {
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

  // Every response's status, noted for /healthz's errors_5xx_5m. On `finish`
  // rather than in an error handler, so a 500 written by a router that never
  // reaches next(err) still counts.
  app.use((req, res, next) => {
    res.on("finish", () => noteResponse(res.statusCode, req.originalUrl));
    next();
  });

  // OAuth discovery for AI connectors lives at the site root (RFC 8414/9728
  // fix the /.well-known paths); the web proxy forwards them here.
  app.use(wellKnownRouter);

  const v1 = express.Router();
  // An answer is for the session that asked, at that moment. Without a header
  // a browser may keep a 410 or a 404 and hand it to the next request for the
  // same address, whoever is signed in: a sandbox kept at its ending reloaded
  // into the ending again, from the cache, with the owner's own token (#4217).
  // A route that means to be cached (a file, a picture) sets its own header.
  // Every request runs in its own scope: a per-request memo, and the meta
  // statements it ran, which a test reads by sending x-meta-probe (#4876).
  v1.use((req, res, next) => {
    const probe = req.header("x-meta-probe");
    runRequestScope(() => {
      const scope = currentRequestScope();
      if (scope) scope.label = requestLabel(req.method, req.path, req.header("x-test-file"));
      if (probe && /^[\w-]{1,64}$/.test(probe)) {
        res.on("finish", () => {
          if (scope) rememberProbe(probe, scope);
        });
      }
      next();
    });
  });
  v1.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  // The OAuth token and revocation endpoints take form bodies (RFC 6749).
  v1.use("/oauth", express.urlencoded({ extended: false, limit: "16kb" }));
  v1.use(oauthRouter);

  v1.get("/healthz", async (_req, res) => {
    // Two numbers a deploy tool reads before trusting this container (#2944):
    // migrations the boot-time sync would still open (zero after a good boot;
    // the roll refuses a container that says otherwise, naming the modules),
    // and 5xx answers in the last five minutes, which survive the roll only by
    // being re-read here rather than tailed from a log that leaves with the
    // container. A failure to compute the first is reported as unknown, not as
    // zero: unknown is not healthy.
    // The pools, read BEFORE the database is asked anything: when every meta
    // client is checked out, this is the number that says so, and it must
    // not itself wait for a client (#3033). The pending-migrations read
    // below then fails within the pool's connect timeout instead of hanging
    // this answer, and db_ok says it did.
    const pools = { meta: poolCounts(metaPool), tenants: tenantPoolStats() };
    let pending: { count: number; modules: string[] } | null;
    let ahead: { count: number; modules: string[]; peer: string | null } | null = null;
    let dbOk = true;
    try {
      ({ pending, ahead } = await pendingMigrationSummary());
    } catch (err) {
      pending = null;
      dbOk = false;
      console.error("[healthz] the database did not answer:", (err as Error).message, JSON.stringify(pools));
    }
    // Asked only of a database that just answered: a starving pool must not
    // make this reply wait a second time (#3033).
    const shims = dbOk ? await healShimRuns() : null;
    const outbound = outboundSnapshot();
    res.json({
      ok: true,
      db_ok: dbOk,
      // Can it reach what it is configured to call (#4847): DNS and the
      // captcha, resolver, BIdb and identity hosts it uses. The last minute's
      // answer, never waited for here; null until the first one is in.
      // /readyz is the version a monitor polls: 503 when any is out.
      outbound_ok: outbound ? outbound.every((o) => o.ok) : null,
      outbound,
      pools,
      migrations_pending: pending,
      // Pairs whose ledger a declared shared-database peer has taken past
      // this build, harmlessly (additive only). Information for the deploy
      // readers, never a refusal: the canary channel is this state.
      migrations_ahead: ahead,
      errors_5xx_5m: errors5xxRecent(),
      // Requests the request guard refused with a 429, by rule, in the last hour and since
      // this process started; auth_last_hour is what the box's alert reads. A guard that
      // refused silently made "nobody was refused" a guess (2026-10-07).
      rate_limited: guardRefusals(),
      // The files of workspaces deleted before deletes erased them: counted at
      // boot, erased by nothing yet (heal-orphan-files.ts). null = not counted
      // yet in this process.
      orphan_files: lastOrphanFilesReport(),
      // The cross-tenant passes whose LAST round failed for at least one
      // workspace, with the first few named. A visit that throws every hour
      // used to be failed++ on a result nothing read (#3350); this is read
      // by the same deploy readers that read the two numbers above. Empty
      // is healthy. In-process: the rounds this api ran.
      sweeps_failing: failingTenantSweeps().map((f) => ({
        name: f.name,
        at: new Date(f.at).toISOString(),
        visited: f.visited,
        failed: f.failed,
        failures: f.failures,
      })),
      // The kinds whose list resolver FAILED in the last hour (a search or a
      // list that answered `failed`), with the last error. Empty is healthy.
      // A failing resolver used to be one log line per request that nothing
      // read, for three weeks (#3824).
      resolvers_failing: failingResolvers(),
      // Every heal, reconcile and sweep pass that caught a failure and carried
      // on, with the last few named (platform/pass-failures.ts). A caught
      // failure used to be a log line and nothing else, so "nothing happened"
      // and "it failed" read the same (#4937). Empty is healthy.
      pass_failures: passFailures(),
      // Every one-shot heal shim's last pass here: what it still found, how
      // many workspaces it could not read, and since when it has found
      // nothing (#3453). The deletion condition each shim states, readable
      // on every deployment without a log. null = could not read; [] = no
      // shim has recorded on this deployment yet. Neither is "all clean".
      heal_shims:
        shims?.map((r) => ({
          shim: r.shim,
          last_run_at: new Date(r.last_run_at).toISOString(),
          found: r.last_found,
          failed: r.last_failed,
          zero_since: r.zero_since ? new Date(r.zero_since).toISOString() : null,
        })) ?? null,
      service: "cobblr-api",
      env: env.NODE_ENV,
      // Deploy label (staging/production/development) for the web's env
      // indicator. `||` not `??`: COBBLR_ENV arrives as "" when unset.
      deploy_env: env.COBBLR_ENV || env.NODE_ENV,
      // Test doors (the camera page's "scan an image file" and its kin): open
      // on a test surface, never on production or canary. The pages read
      // this rather than guessing from the label (platform/test-doors.ts).
      test_doors: testDoorsEnabled(env.COBBLR_ENV || env.NODE_ENV, process.env.COBBLR_TEST_DOORS),
      // Runtime build sha (set by the deploy env, not baked in the image) —
      // the web polls this to offer "new version — refresh" to open tabs.
      build_sha: process.env.COBBLR_BUILD_SHA || null,
      // The image tag this instance runs (self-host compose passes its
      // COBBLR_VERSION through). Runtime env, never baked: a stable cut
      // re-tags a nightly digest bit-for-bit, so the bytes cannot know
      // their own CalVer. null on internal deployments.
      version: process.env.COBBLR_VERSION || null,
      // Where bundles beyond this build's own catalog come from: the external
      // index's host, or false. A person reads it before installing by id, and
      // the install route names it when an id is unknown (#2922).
      registry: externalRegistry(),
      catalog_bundles: listFlagshipManifests("all").length,
      time: new Date().toISOString(),
    });
  });

  // Ready to serve people, not only up (#4847): the database answers and every
  // outbound dependency this deployment is configured to use resolves and
  // connects. 503 with what is out otherwise. A monitor polls this; /healthz
  // stays the deploy readers' always-200 report. After a power cut try's api
  // had no DNS, signups failed on the captcha, and /healthz said 200.
  v1.get("/readyz", async (_req, res) => {
    let dbOk = true;
    try {
      await metaPool.query("select 1");
    } catch {
      dbOk = false;
    }
    const outbound = await outboundReport();
    const down = outbound.filter((o) => !o.ok);
    res.status(dbOk && !down.length ? 200 : 503).json({
      ready: dbOk && !down.length,
      db_ok: dbOk,
      outbound_down: down.map((o) => ({ name: o.name, host: o.host, error: o.error })),
      checked: outbound.map((o) => o.name),
      // Information, never a 503: a heal that failed one workspace must not
      // take the api out of service for everyone.
      pass_failures: passFailures(),
    });
  });

  // The published schema of a floor plan file (cobblr-floorplan/1), for any
  // AI or editor that validates what it writes before a person imports it.
  // Public: it is a format description, made from the importer's own schema.
  v1.get("/schemas/cobblr-floorplan-1.json", (_req, res) => {
    res.type("application/schema+json").json(floorplanJsonSchema());
  });

  // Hosted-overlay request guard (rate-limit / abuse). No-op until the overlay
  // registers a guard; mounted after /healthz so health checks are never gated.
  v1.use(requestGuardMiddleware());

  v1.use("/auth", authRouter);
  v1.use("/auth", oidcAuthRouter);

  // The no-account sandbox, registered ONLY on a box that opted in
  // (COBBLR_TRY_SANDBOX=true). On prod, staging and every self-host these
  // routes do not exist at all — a stronger guarantee than a handler that
  // checks a flag, because there is nothing mounted to reach.
  if (sandboxEnabled()) {
    v1.use(tryRouter);
    console.log("[try-sandbox] routes mounted: GET /try, GET /try/redeem, POST /try/keep, POST /try/carry");
  }
  // TEST-ONLY: org-pool checkout endpoints, mounted ONLY under the flag (never
  // in prod — the route mints tokens). See routes/test-support.ts.
  if (env.COBBLR_TEST_ORG_POOL) v1.use(testSupportRouter);
  // The CI push service (test-support's /push-service) is this api itself.
  // loopback-ok: the address a test device subscribes with; push-delivery reaches it in-process (selfFetch), never over the socket
  if (env.COBBLR_TEST_ORG_POOL) allowTestPushService([`http://127.0.0.1:${env.API_PORT}`, `http://localhost:${env.API_PORT}`]);
  // The receiving end of a trial's "bring what I built": on every deployment,
  // answering only where COBBLR_CARRY_SOURCES names somewhere to read from.
  v1.use(carryRouter);
  v1.use(meRouter);
  v1.use(mePushRouter);
  v1.use(oidcMeRouter);
  // A one-shot URL for a document that must run inline scripts (a custom app
  // block, an installed renderer). The GET is unauthenticated on purpose --
  // an iframe carries no bearer token, so the 32-byte ticket is the
  // capability -- and serves its own strict, sandboxed policy. See
  // platform/frame-docs.ts for why srcdoc cannot survive an enforced
  // script-src (#3300).
  v1.use(frameDocsRouter);
  // Public + unauthenticated by necessity: Discord carries no session. The
  // Ed25519 signature is the gate, checked inside the route before anything
  // is looked at. Mounted here so it sits under /api/v1 with everything else.
  v1.use(discordInteractionsRouter);
  v1.use(connectionsRouter);
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
  // (org, entity, mode). See modules/labels (QR half).
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
  // The ONE inbound-email dispatcher (POST /inbound-email). Cloudflare allows a
  // single catch-all, so the thin Worker sends every inbound message here and
  // THIS routes by address prefix (reply+ → feedback, else → receipt). See
  // routes/inbound-email.ts + docs/operations/email-inbound-capture.md.
  v1.use(inboundEmailRouter);
  v1.use(mailSourcesRouter);
  v1.use(mailboxCheckRouter);
  // The two single-purpose inbound routes are kept for direct/legacy callers and
  // as the handlers the dispatcher reuses; both authenticate with the same
  // COBBLR_INBOUND_EMAIL_SECRET. See routes/feedback.ts + routes/receipt-ingest.ts.
  v1.use(feedbackInboundRouter);
  v1.use(receiptInboundRouter);
  v1.use("/orgs", orgsRouter);
  // platformOrgRouter mounts /:slug/entity-kinds, /:slug/entities/:kind/:id,
  // /:slug/actions, /:slug/bindings, /:slug/field-defs, etc. Composed
  // onto /orgs so it inherits the same routing tree.
  v1.use("/orgs", platformOrgRouter);
  // Services: capabilities, starting a job, reading and answering it.
  v1.use("/orgs", servicesRouter);
  if (testDoorsEnabled(env.COBBLR_ENV || env.NODE_ENV, process.env.COBBLR_TEST_DOORS)) v1.use("/orgs", servicesTestRouter);
  // Workspace calendar — aggregated events + iCal feed config (authed).
  v1.use("/orgs", calendarOrgRouter);
  // The caller's per-workspace receipt-forwarding address (authed).
  v1.use("/orgs", receiptAddressRouter);
  v1.use("/orgs", workspaceMailSourcesRouter);
  // Member portal config + per-action capability grants.
  v1.use("/orgs", portalRouter);
  v1.use("/orgs", diagnosticsRouter);
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
  v1.use("/orgs", resolveRouter);
  // A scan drives the user's designated tab (scan-drives-screen, Phase 1).
  v1.use("/orgs", scanDriveRouter);
  v1.use("/orgs", scanStationsRouter);
  // The Live box's applicable session controls for this workspace.
  v1.use("/orgs", liveRouter);
  // Super-admin (platform operator) surface — cross-workspace
  // dashboards. Gated by SUPERADMIN_EMAILS env var.
  v1.use("/super-admin/sign-in", oidcAdminRouter);
  v1.use("/super-admin", superAdminRouter);
  // User feedback about the platform (submit: any authed user; triage: super-admin).
  v1.use("/feedback", feedbackRouter);
  // Sandbox marketplace runtime install (super-admin only). Backs
  // the "Browse + Install" UI: fetch registry, verify, extract,
  // register without restart. See sandbox-install.ts +
  // docs/architecture/module-isolation.md.
  v1.use("/sandbox", sandboxInstallRouter);
  // Public, unauthenticated catalog: GET /api/v1/registry/index.json — the
  // self-hosted replacement for the GitHub-hosted cobblr-extensions index.json.
  // Mounted BEFORE the authed registry router so requireAuth doesn't catch it.
  v1.use("/registry", registryPublicRouter);
  v1.use("/registry", registryRouter);
  // Bundles live one layer further down — same auth + tenant
  // middleware, dedicated mount for clarity.
  v1.use("/orgs/:slug/bundles", bundlesRouter);
  // Capture-first onboarding: the flagship bundle menu, the pending-capture
  // rollup, and materialize (install a bundle + batch-commit captures). See
  // docs/design-decisions/capture-first-onboarding.md.
  v1.use("/orgs/:slug/quickstart", quickstartRouter);
  v1.use("/orgs/:slug/attention", attentionRouter);
  v1.use("/orgs/:slug/tidy-suggestions", tidyRouter);
  // Generic edge-bridge surface: the dial-out relay wire, the pane of glass,
  // the consumer registry, and the bridge self-update release. Module paths
  // (digifab's /modules/digifab/edge/*) remain as wire-compatible aliases.
  v1.use("/orgs/:slug/edge", edgeRouter);
  v1.use("/edge", edgePairRouter);
  v1.use("/orgs/:slug/station-devices", stationDevicesRouter);
  v1.use("/station", stationPublicRouter);
  // Sharing: a workspace's shares, and the doors another Cobblr knocks on.
  v1.use("/orgs", shareLinksOrgRouter);
  v1.use("/orgs", mePushOrgRouter);
  v1.use("/orgs", recordSendFileRouter);
  v1.use("/orgs", recordSendRouter);
  v1.use(shareLinksRouter);
  // Blueprint (workspace setup snapshot) + Backup (setup + data + files).
  // Both sit at the workspace level above bundles. See
  // docs/architecture/blueprint-backup-export.md.
  v1.use("/orgs/:slug/blueprint", blueprintRouter);
  v1.use("/orgs/:slug/backup", backupRouter);
  v1.use("/orgs/:slug/uploads", uploadReportsRouter);
  // The workspace's own outbound email: how it mails a non-member (#4051).
  v1.use("/orgs/:slug/outbound-email", outboundEmailRouter);
  // Google Drive OAuth callback (the fixed redirect URI — not org-scoped).
  v1.use(backupGoogleCallbackRouter);
  v1.use("/orgs/:slug/deleted-records", deletedRecordsRouter);
  v1.use("/orgs/:slug/members", membersRouter);
  v1.use("/orgs/:slug/people", peopleRouter);
  // Who each kind of workspace notification is for (owner/admin setting).
  v1.use("/orgs/:slug/notification-audiences", notificationAudiencesRouter);
  v1.use("/orgs/:slug/pairings", pairingsRouter);
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
    projectFieldScopes,
    resolveInstance,
    dispatchInstanceItems,
  );
  v1.use("/orgs/:slug/entity-kind-overrides", overridesRouter);
  v1.use("/orgs/:slug/nav-headings", navHeadingsRouter);
  v1.use("/orgs/:slug/approval-requests", approvalRequestsRouter);
  v1.use("/orgs/:slug/record-move", recordMoveRouter);
  // /invites/:token + accept don't take a tenant slug — auth-only.
  v1.use(invitesRootRouter);
  v1.use("/modules", modulesRouter);

  // A test door: every route this api answers, read at the moment it is asked
  // (so module routes mounted at boot are in it), for the tests that judge
  // every route by role. Never on production or canary (test-doors.ts).
  if (testDoorsEnabled(env.COBBLR_ENV || env.NODE_ENV, process.env.COBBLR_TEST_DOORS)) {
    app.get("/api/v1/test/routes", (_req, res) => {
      res.json({ routes: listRoutes(app) });
    });
  }

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
      // A write naming a field the kind does not have (entity-metadata.ts):
      // the caller's mistake, said with the names they could have meant.
      if (err instanceof SecretFieldError || err instanceof UnknownFieldError || err instanceof InvalidFieldValueError || err instanceof GroupingError) {
        res.status(err.status).json(err.toJSON());
        return;
      }
      // A workspace that could not be made was removed rather than left half
      // made (platform/provision-workspace.ts): a plain "try again", from
      // whichever door asked for it.
      if (err instanceof WorkspaceNotProvisioned) {
        res.status(503).json({ error: { code: err.code, message: WORKSPACE_NOT_CREATED_MESSAGE } });
        return;
      }
      console.error("[cobblr-api] unhandled", err);
      res.status(500).json({
        // Never a blank message: an error thrown without one (a failed
        // connection's AggregateError) left the person with nothing to read.
        error: { code: "internal", message: env.NODE_ENV === "production" || !err.message?.trim() ? "Something went wrong on our side, and it did not say what. Try again." : err.message },
      });
    },
  );
}
