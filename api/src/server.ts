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
  app.use(cors({ origin: true, credentials: true }));
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
      console.error("[cobblr-api] unhandled", err);
      res.status(500).json({
        error: { code: "internal", message: env.NODE_ENV === "production" ? "Internal error" : err.message },
      });
    },
  );
}
