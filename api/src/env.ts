// Boot-time env validation. Anything not declared here is treated as
// missing; anything malformed crashes the process at startup rather
// than mysteriously at request time.

import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Deploy-environment LABEL (staging vs production), surfaced on /healthz so
  // the web can tint the navbar + show a chip. Distinct from NODE_ENV, which
  // is "production" on BOTH staging and prod. Compose passes ${COBBLR_ENV:-},
  // i.e. an empty string when unset — callers must treat "" as unset (use ||).
  COBBLR_ENV: z.string().optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),

  // Postgres connections. SUPERUSER is only used for tenant
  // provisioning (CREATE DATABASE / CREATE USER) — keep it separate
  // from the per-tenant connections. Required now that signup
  // actually provisions a tenant DB.
  DATABASE_URL: z.string().min(1),
  SUPERUSER_DATABASE_URL: z.string().min(1),
  // TEST-ONLY: enable the pre-provisioned org POOL — signupFreshOrg checks out a
  // ready org instead of provisioning (~63% of CI runtime). Set ONLY in ci.yml /
  // the test rig; NEVER in prod (it registers a token-minting route + a bake).
  // See api/src/db/test-org-pool.ts.
  COBBLR_TEST_ORG_POOL: z.string().optional(),
  // Boot-time bake size (the PoC / in-job path). An offline image/tarball bake
  // sets its own size; this is the fallback when the pool starts empty.
  COBBLR_TEST_ORG_POOL_SIZE: z.coerce.number().int().positive().optional(),

  // Auth & secrets. Replace defaults for prod (validated by checking
  // they don't start with the dev sentinel).
  JWT_SECRET: z.string().min(16),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  TENANT_CREDS_ENCRYPTION_KEY: z.string().min(16),

  // Backup destinations (Phase C) — all optional.
  //  • BACKUP_FS_ROOT — root dir for the filesystem destination driver
  //    (a NAS bind-mount, etc.). Defaults to /files/backups.
  //  • GOOGLE_OAUTH_* — a Google Cloud OAuth app, required to enable the
  //    Google Drive destination. Unset → the Drive driver is unavailable.
  BACKUP_FS_ROOT: z.string().optional(),

  // Audit-log retention window in days. UNSET (default) = keep every row
  // forever (the original behaviour, right for a personal box). Set on a
  // public host to bound the table; a probabilistic sweep on write prunes
  // rows past the window (platform/activity.ts).
  ACTIVITY_LOG_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URL: z.string().optional(),
  // Google endpoint overrides — default to the real Google URLs; pointed
  // elsewhere only by tests (a stub OAuth server).
  GOOGLE_OAUTH_AUTH_URL: z.string().optional(),
  GOOGLE_OAUTH_TOKEN_URL: z.string().optional(),
  // OAuth broker (Path B in docs/operations/google-drive-backup-setup.md).
  //  • BACKUP_OAUTH_BROKER_URL — a Cobblr instance (that HAS Google creds)
  //    to broker the Drive connect, so THIS instance needs no Google app.
  //  • BACKUP_BROKER_SHARED_SECRET — set on the BROKER to gate who it brokers
  //    for, and on each CLIENT to authenticate to that broker (must match).
  BACKUP_OAUTH_BROKER_URL: z.string().optional(),
  BACKUP_BROKER_SHARED_SECRET: z.string().optional(),

  // Comma-separated allowlist of CORS origins, e.g.
  //   "https://cobblr.example.com,https://workshop.example.com"
  // Default in dev is "*" (any origin) — the previous behavior. In
  // production this MUST be set to the workspace's public hostname(s)
  // or CORS rejects every browser request. See docs/operations/PRODUCTION_DEPLOY.md.
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

  // Instance-level kill-switch for ALL built-in LLM features. When
  // false, platform().ai.invoke() refuses every call regardless of
  // per-workspace provider config — AI features degrade exactly as
  // they do with no provider (the ai:false path). Default true.
  // A self-hoster who wants a guaranteed no-outbound-LLM deployment
  // sets this false; it's the operator's hard floor, above any
  // per-workspace BYO-key config. (Per-customer / paid-inference
  // entitlement is a SEPARATE hosted-only layer — see
  // business-models/docs/09; it is NOT in the open core.)
  COBBLR_AI_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // ── try / trial tier ─────────────────────────────────────────────────────
  // COBBLR_TIER=trial turns this instance into the locked-down "try" tier
  // (try.cobblr.xyz): a restricted default-module set (no AI/authoring/devices/
  // integrations/public-surfaces), a single-workspace entitlement cap, and a
  // trial_expires_at stamp on every new workspace. Unset = a normal instance
  // (prod, staging, self-host) — none of the trial behaviour runs. Pair with
  // COBBLR_HOSTED=true (strict egress) and COBBLR_AI_ENABLED=false.
  // See docs/design-decisions/try-instance.md.
  COBBLR_TIER: z.enum(["trial"]).optional(),
  // Days until a trial workspace's expiry stamp. Reaping itself is DEFERRED —
  // the stamp is set at signup, but nothing sweeps until the reaper is added.
  TRY_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Comma-separated module names withheld on the trial tier (only read when
  // COBBLR_TIER=trial). This is INSTANCE POLICY, not kernel code — the kernel
  // never hardcodes a module name (module-isolation lint). The `try` box sets:
  //   COBBLR_TRIAL_DENY_MODULES=core-ai,core-authoring,core-devices,core-integrations,core-public-surfaces
  // Belt-and-suspenders: COBBLR_AI_ENABLED=false + COBBLR_HOSTED=true mean a
  // missing entry still can't turn AI or SSRF on. See platform/trial.ts.
  COBBLR_TRIAL_DENY_MODULES: z.string().optional(),
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
