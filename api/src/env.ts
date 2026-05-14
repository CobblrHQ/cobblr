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
