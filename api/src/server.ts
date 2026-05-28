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
import { publicRouter } from "./routes/public.js";
import { meRouter } from "./routes/me.js";
import { modulesRouter } from "./routes/modules.js";
import { orgsRouter } from "./routes/orgs.js";
import { platformOrgRouter } from "./routes/platform.js";
import { bundlesRouter } from "./routes/bundles.js";
import { membersRouter, invitesRootRouter } from "./routes/members.js";
import { pairingsRouter } from "./routes/pairings.js";
import { portalRouter } from "./routes/portal.js";
import { adminUsersRouter } from "./routes/admin-users.js";
import { superAdminRouter } from "./routes/super-admin.js";
import { sandboxInstallRouter } from "./routes/sandbox-install.js";
import { customRolesRouter } from "./routes/custom-roles.js";
import { instancesRouter, overridesRouter } from "./routes/instances.js";
import { qrScanRouter } from "./routes/qr-scan.js";
import { integrationsInboundRouter } from "./routes/integrations-inbound.js";

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
  // comma-separated list in production (see docs/PRODUCTION_DEPLOY.md).
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
  app.use(
    express.json({
      limit: "1mb",
      // Capture raw body bytes on inbound webhook paths so the
      // integrations receiver can verify HMAC signatures against the
      // exact bytes that were transmitted. Cheap (one toString per
      // request, kept only on the request object), bounded to the
      // /integrations/ path so we don't keep raw bytes for every API
      // call.
      verify: (req, _res, buf) => {
        if (req.url?.startsWith("/api/v1/integrations/")) {
          (req as unknown as { rawBody?: string }).rawBody = buf.toString("utf8");
        }
      },
    }),
  );
  if (env.NODE_ENV !== "test") {
    app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  }

  const v1 = express.Router();

  v1.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "cobblr-api",
      env: env.NODE_ENV,
      time: new Date().toISOString(),
    });
  });

  v1.use("/auth", authRouter);
  v1.use(meRouter);
  // Public read endpoint for core-public-surfaces. No auth required;
  // token in the URL is the secret. Mounted on /api/v1/public/* —
  // outside /orgs because the URL carries no slug.
  v1.use("/public", publicRouter);
  // QR scan target — unauthenticated GET that resolves a token to
  // (org, entity, mode). See modules/core-labels-qr.
  v1.use("/qr", qrScanRouter);
  // Inbound webhook receiver for core-integrations. Unauthenticated;
  // the token in the URL is the secret. See
  // modules/core-integrations.
  v1.use("/integrations", integrationsInboundRouter);
  v1.use("/orgs", orgsRouter);
  // platformOrgRouter mounts /:slug/entity-kinds, /:slug/entities/:kind/:id,
  // /:slug/actions, /:slug/bindings, /:slug/field-defs, etc. Composed
  // onto /orgs so it inherits the same routing tree.
  v1.use("/orgs", platformOrgRouter);
  // Member portal config + per-action capability grants.
  v1.use("/orgs", portalRouter);
  // Admin user creation (no-email onboarding flow).
  v1.use("/orgs", adminUsersRouter);
  // Custom roles (S2): workspace-defined capability bundles.
  v1.use("/orgs", customRolesRouter);
  // Super-admin (platform operator) surface — cross-workspace
  // dashboards. Gated by SUPERADMIN_EMAILS env var.
  v1.use("/super-admin", superAdminRouter);
  // Sandbox marketplace runtime install (super-admin only). Backs
  // the "Browse + Install" UI: fetch registry, verify, extract,
  // register without restart. See sandbox-install.ts +
  // docs/design-decisions/module-isolation.md.
  v1.use("/sandbox", sandboxInstallRouter);
  // Bundles live one layer further down — same auth + tenant
  // middleware, dedicated mount for clarity.
  v1.use("/orgs/:slug/bundles", bundlesRouter);
  v1.use("/orgs/:slug/members", membersRouter);
  v1.use("/orgs/:slug/pairings", pairingsRouter);
  v1.use("/orgs/:slug/instances", instancesRouter);
  v1.use("/orgs/:slug/entity-kind-overrides", overridesRouter);
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
