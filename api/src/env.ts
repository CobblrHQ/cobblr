// Boot-time env validation. Anything not declared here is treated as
// missing; anything malformed crashes the process at startup rather
// than mysteriously at request time.

import { z } from "zod";
import { weakSecretReasons } from "./env-secret-guard.js";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Deploy-environment LABEL (staging vs production), surfaced on /healthz so
  // the web can tint the navbar + show a chip. Distinct from NODE_ENV, which
  // is "production" on BOTH staging and prod. Compose passes ${COBBLR_ENV:-},
  // i.e. an empty string when unset — callers must treat "" as unset (use ||).
  COBBLR_ENV: z.string().optional(),
  // Name of another deployment that SHARES this database and deliberately
  // tracks a newer build (the canary channel). Set only on the stack that is
  // pinned BEHIND one; it turns the downgrade detector's alarm into an expected
  // info line so the real alarm stays meaningful. Compose passes ${VAR:-} as an
  // empty string, so readers must treat "" as unset.
  // See docs/design-decisions/canary-channel.md.
  COBBLR_SHARED_DB_PEER: z.string().optional(),
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

  // Auth & secrets. In production a dev/placeholder value is refused at boot
  // by assertNoDevSecretsInProd (below) — not just length-checked here.
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
  //   "https://cobblr.example.com,https://cobblr.example.org"
  // Default in dev is "*" (any origin) — the previous behavior. In
  // production this MUST be set to the workspace's public hostname(s)
  // or CORS rejects every browser request. See docs/operations/PRODUCTION_DEPLOY.md.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // Comma-separated list of emails for users with platform-operator
  // privileges (the "super-admin" role). These users see the
  // /super-admin/* surface — cross-workspace dashboards for the
  // person hosting Cobblr (e.g. the author running the workshop server +
  // hosting a friend's club). Per-workspace owners + admins are
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

  // Drop `maturity: "experimental"` modules at load (public / trial deploys
  // set this; self-host default is off so an install is never surprised by a
  // module vanishing). Validated here because the loader used to read it raw
  // from process.env — a typo ("True", "1", a misspelled name) silently meant
  // "experimental modules ON", the exact miss this schema exists to stop.
  // Preprocess: compose passes ${VAR:-} as an EMPTY STRING when unset, which
  // must read as "unset", not as an enum violation that crashes boot.
  COBBLR_DISABLE_EXPERIMENTAL_MODULES: z
    .preprocess((v) => (v === "" ? undefined : v), z.enum(["true", "false"]).default("false"))
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

  // ── the no-account sandbox (docs/design-decisions/try-sandbox.md) ──────────
  // OFF unless COBBLR_TRY_SANDBOX=true, so prod / staging / self-host never
  // hand out an anonymous workspace even if the other keys drift in.
  COBBLR_TRY_SANDBOX: z.coerce.boolean().default(false),
  /** How long a sandbox lives. Minutes, not days: this is the whole point. */
  TRY_SANDBOX_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  /** Refuse to provision past this many LIVE sandboxes. The control that
   *  protects the box whatever the rate limits miss — db-per-tenant means every
   *  sandbox is a real Postgres database. */
  TRY_SANDBOX_MAX_LIVE: z.coerce.number().int().positive().default(100),
  TRY_SANDBOX_MAX_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(2),
  TRY_SANDBOX_MAX_PER_HOUR: z.coerce.number().int().positive().default(60),
  /** How often expired sandboxes are swept. Minutes, unlike the trial reaper's
   *  6h: an hour-long sandbox that lingers for six is not an hour-long one. */
  TRY_SANDBOX_REAP_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  /** Blueprint seeded into a fresh sandbox, by name (files live in
   *  deploy/seeds/). Empty = an empty workspace, which is a poor first
   *  impression and is not the default. */
  TRY_SANDBOX_SEED: z.string().default("household"),
  //  • TRY_SANDBOX_EXPORT_DAYS — how long the ONE file a visitor asked us to
  //    email them survives. Their database still dies on the hour; this is the
  //    export artifact only, and only for somebody who gave an address. Kept
  //    short because it is somebody's work sitting on our disk after they have
  //    gone, and long enough to survive a weekend.
  TRY_SANDBOX_EXPORT_DAYS: z.coerce.number().int().positive().default(7),
  //  • The two ways to carry on, shown in the take-your-work modal and mirrored
  //    in the email. UNSET BY DEFAULT and each shown only when configured: a
  //    self-hosted Cobblr has no business advertising somebody else's hosted
  //    service, and baking one deployment's hostname into the product is what
  //    the instance-identity lint exists to stop. The box that hands out
  //    sandboxes sets both.
  COBBLR_SELFHOST_DOCS_URL: z.string().default(""),
  COBBLR_CLOUD_SIGNUP_URL: z.string().default(""),
  // How many days before a trial's expiry to send the humane heads-up warning
  // email (the reaper's warn -> grace -> delete lifecycle). Only consulted when
  // COBBLR_TRIAL_REAP=dry|live; a workspace is never deleted until it was warned
  // at least (COBBLR_TRIAL_REAP_GRACE_DAYS) days ago. Default 7. Read via the
  // reaper's own fail-safe helper (platform/reap-trials.ts reapWarnDays).
  COBBLR_TRIAL_REAP_WARN_DAYS: z.coerce.number().int().positive().default(7),
  // Comma-separated module names withheld on the trial tier (only read when
  // COBBLR_TIER=trial). This is INSTANCE POLICY, not kernel code — the kernel
  // never hardcodes a module name (module-isolation lint). The `try` box sets:
  //   COBBLR_TRIAL_DENY_MODULES=core-ai,core-authoring,core-devices,core-integrations,core-public-surfaces
  // Belt-and-suspenders: COBBLR_AI_ENABLED=false + COBBLR_HOSTED=true mean a
  // missing entry still can't turn AI or SSRF on. See platform/trial.ts.
  COBBLR_TRIAL_DENY_MODULES: z.string().optional(),
  // ── signup abuse guards (no-op unless set; the try box turns them on) ──
  // Captcha: provider + secret enable server-side verify (platform/captcha.ts).
  // The SITE key is public and delivered to the web at runtime via /auth/config
  // (so the shared web image carries no baked-in key). Secret stays server-side.
  COBBLR_CAPTCHA_PROVIDER: z.enum(["turnstile"]).optional(),
  COBBLR_CAPTCHA_SECRET: z.string().optional(),
  COBBLR_CAPTCHA_SITE_KEY: z.string().optional(),
  // "true" rejects signups from known disposable-email providers.
  COBBLR_BLOCK_DISPOSABLE_EMAILS: z.string().optional(),
  // "true" requires a verified email before login succeeds (needs a real SMTP
  // sender configured, COBBLR_AUTH_EMAIL_PROVIDER). The try box sets it.
  COBBLR_REQUIRE_EMAIL_VERIFY: z.string().optional(),

  // Central identity federation (Slice 3). ALL optional — unset = this surface
  // owns its own accounts as before (no central identity, no behaviour change).
  //  • IDENTITY_URL — base URL of the central identity service (e.g.
  //    http://192.168.1.138:8790). Set = enable federation (JWKS verify + the
  //    boot backfill that links local users to global identities by email).
  //  • IDENTITY_ISSUER / IDENTITY_AUDIENCE — must match what the identity service
  //    signs (defaults mirror the service's own defaults).
  //  • IDENTITY_ADMIN_TOKEN — the identity service's admin token (gates
  //    POST /admin/backfill); required for the backfill pass to run.
  //  • COBBLR_DEPLOYMENT — this surface's stable id in the identity map
  //    (deployment_links), e.g. "try" or the hosted deployment. Defaults to COBBLR_ENV.
  //  • IDENTITY_PUBLIC_URL — the identity service as a BROWSER must reach it. Optional;
  //    defaults to IDENTITY_URL. These differ whenever the account service is reachable
  //    on a LAN address from the api but only over its public hostname from a visitor's
  //    browser, which is the normal hosted shape — and getting it wrong sends every
  //    visitor who clicks "Continue with your … account" to an address that does not
  //    resolve for them.
  IDENTITY_URL: z.string().optional(),
  IDENTITY_PUBLIC_URL: z.string().optional(),
  IDENTITY_ISSUER: z.string().default("cobblr-identity"),
  IDENTITY_AUDIENCE: z.string().default("cobblr"),
  IDENTITY_ADMIN_TOKEN: z.string().optional(),
  //  • IDENTITY_DEPLOYMENT_SECRET — this surface's shared secret with the identity
  //    service, presented when redeeming a sign-in code. Without it the hand-off is
  //    off and sign-in works exactly as it did before.
  IDENTITY_DEPLOYMENT_SECRET: z.string().optional(),
  //  • IDENTITY_NAME — what to call the account service on the sign-in button. Defaults
  //    to "Cobblr", which is right for cobblr.xyz and wrong for anyone federating with
  //    their own: the client is generic, so its label should be too.
  IDENTITY_NAME: z.string().optional(),
  //  • COBBLR_IDENTITY_AUTOPROVISION — "true" gives a central account that has no
  //    workspace here one, on first arrival, instead of turning it away. That is what
  //    an open surface (a trial box) wants and what a private one must not do, so it
  //    is per-deployment and off unless set.
  COBBLR_IDENTITY_AUTOPROVISION: z.string().optional(),
  COBBLR_DEPLOYMENT: z.string().optional(),

  // A PUBLIC demo instance: the shared login shown on, and pre-filled into, the
  // sign-in form. Setting these PUBLISHES that password to anyone who loads the
  // page - which is the point on a demo whose data is wiped on a timer, and
  // catastrophic anywhere else. Both must be set or the block is withheld
  // entirely; there is no half-configured state that leaks an address.
  // COBBLR_DEMO_SIGNIN_NOTE is optional free text under the credentials
  // ("Everything here resets every 15 minutes.").
  COBBLR_DEMO_SIGNIN_EMAIL: z.string().optional(),
  COBBLR_DEMO_SIGNIN_PASSWORD: z.string().optional(),
  COBBLR_DEMO_SIGNIN_NOTE: z.string().optional(),
});

/** Boot guard: in production, a dev/placeholder secret or DB password is a
 *  refuse-to-start condition, not a warning. Keeps the comment on JWT_SECRET
 *  honest — that guard used to be claimed but never implemented, and the
 *  shipped .env.example carried `dev-only-...` values that passed `min(16)`.
 *  The rule lives in env-secret-guard.ts so lint:selfhost-secrets shares it.
 *  See docs/history/2026-08-25-prerelease-audit.md B1. */
function assertNoDevSecretsInProd(val: Env): string[] {
  if (val.NODE_ENV !== "production") return [];
  return weakSecretReasons(val);
}

export type Env = z.infer<typeof Schema>;

/** Drop empty-string values, so `${VAR:-}` means "unset" everywhere.
 *
 *  docker-compose passes an unset variable as an EMPTY STRING, not as absent
 *  (CLAUDE.md 14.6). For a plain `z.string().optional()` that is merely untidy, but for
 *  an enum it is a HARD BOOT FAILURE — `z.enum(["turnstile"])` rejects "" and the api
 *  crash-loops with "Invalid enum value ... received ''". A coerced number is worse and
 *  quieter: Number("") is 0, so `.positive()` fails and a blank line in .env stops the
 *  instance from starting.
 *
 *  That is not hypothetical. Wiring these settings through compose (which is itself a
 *  fix, for settings that reached nothing) turned "absent" into "" for COBBLR_TIER,
 *  COBBLR_CAPTCHA_PROVIDER, TRY_TTL_DAYS and the trial-reap window all at once, and the
 *  first instance built from it crash-looped on boot. Handling it per-field means
 *  remembering, every time; handling it here means the schema can read the way it looks
 *  like it reads.
 *
 *  An operator wanting to blank a value already does it by leaving the line empty, which
 *  is exactly what this treats as "not set". No setting in this schema uses "" to mean
 *  something different from unset. */
function withoutEmpties(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== "") out[k] = v;
  }
  return out;
}

function loadEnv(): Env {
  const parsed = Schema.safeParse(withoutEmpties(process.env));
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
  const devSecretErrs = assertNoDevSecretsInProd(parsed.data);
  if (devSecretErrs.length > 0) {
    console.error("Refusing to boot with dev/placeholder secrets in production:");
    for (const e of devSecretErrs) console.error(`  ${e}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

export { withoutEmpties as _withoutEmpties };
export { assertNoDevSecretsInProd as _assertNoDevSecretsInProd };
