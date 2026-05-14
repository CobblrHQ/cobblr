// Express app factory. Stays pure (no listen, no side effects) so
// integration tests can hit it via supertest later without spinning up
// a port. The entry point at `index.ts` does the actual listen.

import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./env.js";
import { authRouter } from "./routes/auth.js";
import { meRouter } from "./routes/me.js";
import { modulesRouter } from "./routes/modules.js";
import { orgsRouter } from "./routes/orgs.js";

export function createServer() {
  const app = express();

  // We expect to sit behind nginx (the `web` container) in prod, which
  // forwards X-Forwarded-For. Trust one hop so express-rate-limit (when
  // added) and req.ip return the real client IP.
  app.set("trust proxy", 1);

  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression());
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  if (env.NODE_ENV !== "test") {
    app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  }

  // All v1 routes live under /api/v1. Milestone 1 only exposes
  // healthz — Milestone 2 will mount auth, Milestone 3 tenant routing,
  // etc.
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
  v1.use("/orgs", orgsRouter);
  v1.use("/modules", modulesRouter);

  app.use("/api/v1", v1);

  // Centralised JSON error handler — keep last so routes can hand
  // unknown errors off via next(err).
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error("[cobblr-api] unhandled", err);
      res.status(500).json({
        error: { code: "internal", message: env.NODE_ENV === "production" ? "Internal error" : err.message },
      });
    },
  );

  // 404 fallback — keep it boring and JSON-shaped so the web's fetch
  // helpers get something parseable.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
  });

  return app;
}
