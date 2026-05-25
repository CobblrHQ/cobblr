// Boot-time env validation. Anything not declared here is treated as
// missing; anything malformed crashes the process at startup rather
// than mysteriously at request time.

import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),

  // Postgres connections. SUPERUSER is only used for tenant
  // provisioning (CREATE DATABASE / CREATE USER) — keep it separate
  // from the per-tenant connections. Required now that signup
  // actually provisions a tenant DB.
  DATABASE_URL: z.string().min(1),
  SUPERUSER_DATABASE_URL: z.string().min(1),

  // Auth & secrets. Replace defaults for prod (validated by checking
  // they don't start with the dev sentinel).
  JWT_SECRET: z.string().min(16),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  TENANT_CREDS_ENCRYPTION_KEY: z.string().min(16),

  // Comma-separated allowlist of CORS origins, e.g.
  //   "https://cobblr.example.com,https://workshop.example.com"
  // Default in dev is "*" (any origin) — the previous behavior. In
  // production this MUST be set to the workspace's public hostname(s)
  // or CORS rejects every browser request. See docs/PRODUCTION_DEPLOY.md.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // Comma-separated list of emails for users with platform-operator
  // privileges (the "super-admin" role). These users see the
  // /super-admin/* surface — cross-workspace dashboards for the
  // person hosting Cobblr (e.g. the author running the workshop server +
  // hosting a beta tester's club). Per-workspace owners + admins are
  // unchanged; this is a SEPARATE tier above them.
  // Empty / unset → no super-admins (single-tenant deploy where the
  // workspace owner is also the host operator).
  SUPERADMIN_EMAILS: z.string().optional(),
});

export type Env = z.infer<typeof Schema>;

function loadEnv(): Env {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    // Print every failure and exit. Don't try to keep running with
    // broken config — that's how staging-style "it works for me" bugs
    // are born.
    console.error("Invalid environment:");
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
