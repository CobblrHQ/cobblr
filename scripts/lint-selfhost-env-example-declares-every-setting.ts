#!/usr/bin/env tsx
// Every setting the api reads (declared in api/src/env.ts or read as process.env.COBBLR_*) is declared in the self-host .env.example, or is on the lint's allow-list of internal settings with a reason each, so a self-hoster reading the template learns every setting that exists.
//
// THE BUG THIS PREVENTS. 2026-10-18 (#7318): of fifteen operator settings
// shipped since 2026.8.1 the template carried two; OIDC sign-in,
// PUBLIC_BASE_URL, the feature switches and captcha all worked (the compose
// hands the whole .env to the api) and were invisible to anyone reading it.
//
// THE RULE. A name counts as read when api/src/env.ts declares it in its
// schema, or a non-test file under api/src reads process.env.COBBLR_<NAME>
// (dot or bracket). It counts as declared when deploy/selfhost/standalone/
// .env.example has a line `NAME=` or `# NAME=` (a commented-out default is how
// an optional setting is offered). A name that is not for self-hosters (a test
// door, CI, the hosted service's own) goes in INTERNAL below with its reason;
// there is no baseline that grows. INTERNAL entries the api no longer reads
// fail too, so the list cannot rot.
//
// THE BOUNDARY. api/src and packages/platform-contract/src (the api's own
// shared code, where PUBLIC_BASE_URL is read): modules and the web build read
// their settings through the platform, and a module's setting is its own doc's
// business. In api/src only COBBLR_* direct reads count outside env.ts:
// NODE_ENV, TZ and the like are the runtime's. A comment naming a setting is
// not a read.
//
//   npx tsx scripts/lint-selfhost-env-example-declares-every-setting.ts   (pnpm lint selfhost-env-example-declares-every-setting)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";

const ENV_TS = "api/src/env.ts";
const EXAMPLE = "deploy/selfhost/standalone/.env.example";
/** Where direct reads are looked for, and which names count there. */
const ROOTS: Array<{ dir: string; names: RegExp }> = [
  { dir: "api/src", names: /^COBBLR_/ },
  { dir: "packages/platform-contract/src", names: /^[A-Z][A-Z0-9_]+$/ },
];

/** Settings a self-hoster never sets, each with why. */
export const INTERNAL: Record<string, string> = {
  NODE_ENV: "set by the image or the compose file itself, not by the .env",
  API_PORT: "set by the image or the compose file itself, not by the .env",
  COBBLR_BUILD_SHA: "set by the image or the compose file itself, not by the .env",
  COBBLR_FILES_ROOT: "set by the image or the compose file itself, not by the .env",
  COBBLR_UPLOAD_TMP: "set by the image or the compose file itself, not by the .env",
  COBBLR_RUNTIME_MODULES_DIR: "set by the image or the compose file itself, not by the .env",
  COBBLR_RETAINED_ROOT: "set by the image or the compose file itself, not by the .env",
  COBBLR_EDGE_BLOB_DIR: "set by the image or the compose file itself, not by the .env",
  COBBLR_SERVER_BRIDGE_DIR: "set by the image or the compose file itself, not by the .env",
  COBBLR_SERVER_BRIDGE_CACHE_DIR: "set by the image or the compose file itself, not by the .env",
  COBBLR_SERVER_BRIDGE_ORIGIN: "set by the image or the compose file itself, not by the .env",
  COBBLR_ENV: "the deploy label (staging, canary) the hosted boxes show on healthz",
  COBBLR_SHARED_DB_PEER: "only for a stack pinned behind a canary that shares its database (canary-channel.md)",
  COBBLR_TEST_ORG_POOL: "tests and the CI harness only",
  COBBLR_TEST_ORG_POOL_SIZE: "tests and the CI harness only",
  COBBLR_EMAIL_DELIVERY_DOOR: "tests and the CI harness only",
  COBBLR_IP_LIMITS_OFF: "tests and the CI harness only",
  COBBLR_TEST_DOORS: "tests and the CI harness only",
  COBBLR_TEST_ATTRIBUTION: "tests and the CI harness only",
  GOOGLE_OAUTH_AUTH_URL: "tests and the CI harness only",
  GOOGLE_OAUTH_TOKEN_URL: "tests and the CI harness only",
  COBBLR_GMAIL_API_BASE: "tests and the CI harness only",
  COBBLR_GOOGLE_AUTH_BASE: "tests and the CI harness only",
  COBBLR_GOOGLE_OAUTH_BASE: "tests and the CI harness only",
  COBBLR_LOAD_EXAMPLE_MODULES: "development only: loads the example modules",
  COBBLR_API: "the demo seed script's own target, not the api's",
  COBBLR_WEBHOOK_ALLOW_INTERNAL: "ignored in production, which every self-host install runs as",
  COBBLR_SKIP_HISTORICAL_MIGRATIONS: "a one-off for the hosted boxes' backfill",
  COBBLR_HOSTED: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_AUTH_EMAIL_ALLOW_OVERRIDE: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_MANAGED_APP_SIGNUP_ENABLED: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_SIGNUP_SURFACE_URL: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_IDENTIFY_APPS: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_MCP_RELAY_URL: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_BARCODE_RESOLVER_URL: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_BARCODE_RESOLVER_TOKEN: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_BARCODE_RESOLVER_REVIEW_TOKEN: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_CATALOG_RESOLVER_URL: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_CATALOG_RESOLVER_TOKEN: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_DISCORD_BOT_URL: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_DISCORD_GUILD_LABELS: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_DISCORD_PUBLIC_KEY: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_FEEDBACK_ATTACHMENT_ORG: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_FEEDBACK_REPLY_DOMAIN: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_INBOUND_EMAIL_SECRET: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_RECEIPT_EMAIL_DOMAIN: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_TRIAGE_TRIGGER_URL: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_EXTENSIONS_URL: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_EXTENSIONS_SIG_URL: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_REGISTRY_URL: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_REGISTRY_TOKEN: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_ROOT_PUBKEY: "the hosted service's own wiring, never set on a self-hosted box",
  IDENTITY_URL: "the hosted service's own wiring, never set on a self-hosted box",
  IDENTITY_PUBLIC_URL: "the hosted service's own wiring, never set on a self-hosted box",
  IDENTITY_ISSUER: "the hosted service's own wiring, never set on a self-hosted box",
  IDENTITY_AUDIENCE: "the hosted service's own wiring, never set on a self-hosted box",
  IDENTITY_ADMIN_TOKEN: "the hosted service's own wiring, never set on a self-hosted box",
  IDENTITY_DEPLOYMENT_SECRET: "the hosted service's own wiring, never set on a self-hosted box",
  IDENTITY_NAME: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_IDENTITY_AUTOPROVISION: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_DEPLOYMENT: "the hosted service's own wiring, never set on a self-hosted box",
  COBBLR_PHOTO_OBSERVATIONS: "off until the owner's go after a legal check (#3769)",
  COBBLR_DEMO_SIGNIN_EMAIL: "publishes a password on the sign-in page: only for a wiped public demo box",
  COBBLR_DEMO_SIGNIN_PASSWORD: "publishes a password on the sign-in page: only for a wiped public demo box",
  COBBLR_DEMO_SIGNIN_NOTE: "publishes a password on the sign-in page: only for a wiped public demo box",
  COBBLR_TIER: "the hosted try tier (try.cobblr.xyz), docs/design-decisions/try-instance.md",
  TRY_TTL_DAYS: "the hosted try tier (try.cobblr.xyz), docs/design-decisions/try-instance.md",
  COBBLR_TRIAL_UPLOAD_CAP_MB: "the hosted try tier (try.cobblr.xyz), docs/design-decisions/try-instance.md",
  COBBLR_TRIAL_REAP_WARN_DAYS: "the hosted try tier (try.cobblr.xyz), docs/design-decisions/try-instance.md",
  COBBLR_TRIAL_DENY_MODULES: "the hosted try tier (try.cobblr.xyz), docs/design-decisions/try-instance.md",
  TRY_SANDBOX_POOL_INTERVAL_MS: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
  TRY_SANDBOX_POOL_MAX_AGE_MINUTES: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
  TRY_SANDBOX_REAP_INTERVAL_MS: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
  COBBLR_TRY_SEED_DIR: "set by the image or the compose file itself, not by the .env",
  COBBLR_POOL_CONNECT_TIMEOUT_MS: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
  COBBLR_POOL_RELEASE_GRACE_MS: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
  COBBLR_QUEUE_POLL_MS: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
  COBBLR_SWEEP_CONCURRENCY: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
  COBBLR_SWEEP_START_AFTER_MS: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
  COBBLR_SWEEP_TICK_MS: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
  COBBLR_DELETE_DRAIN_MS: "runtime tuning with a safe default; changing it is a support conversation, not a setting",
};

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\/test-|\/testing\//.test(p) && !isEmbeddedPayload(p)) yield p;
  }
}

/** Names the schema in env.ts declares: two-space-indented `NAME:` keys of the object. */
export function schemaNames(src: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}([A-Z][A-Z0-9_]+):/.exec(lines[i] ?? "");
    if (m?.[1] && !out.has(m[1])) out.set(m[1], i + 1);
  }
  return out;
}

/** process.env.X and process.env["X"] reads in one file, outside comments. */
export function directReads(src: string, names: RegExp = /^COBBLR_/): Map<string, number> {
  const out = new Map<string, number>();
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const m of line.matchAll(/process\.env(?:\.|\[["'])([A-Z][A-Z0-9_]+)/g)) {
      if (m[1] && names.test(m[1]) && !out.has(m[1])) out.set(m[1], i + 1);
    }
  }
  return out;
}

/** Names the template offers, set or commented out. */
export function exampleNames(src: string): Set<string> {
  const out = new Set<string>();
  for (const line of src.split("\n")) {
    const m = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

const read = new Map<string, string>();
for (const [name, line] of schemaNames(readFileSync(ENV_TS, "utf8"))) read.set(name, `${ENV_TS}:${line}`);
for (const root of ROOTS) {
  for (const file of walk(root.dir)) {
    for (const [name, line] of directReads(readFileSync(file, "utf8"), root.names)) if (!read.has(name)) read.set(name, `${file}:${line}`);
  }
}
const offered = exampleNames(readFileSync(EXAMPLE, "utf8"));

const violations: string[] = [];
for (const [name, where] of [...read].sort()) {
  if (offered.has(name) || INTERNAL[name]) continue;
  violations.push(`${where}  ${name} is read by the api and missing from ${EXAMPLE}`);
}
for (const name of Object.keys(INTERNAL).sort()) {
  if (!read.has(name)) violations.push(`scripts/lint-selfhost-env-example-declares-every-setting.ts  INTERNAL lists ${name}, which the api no longer reads: remove it`);
  else if (offered.has(name)) violations.push(`scripts/lint-selfhost-env-example-declares-every-setting.ts  INTERNAL lists ${name}, which ${EXAMPLE} offers: it is one or the other`);
}

if (violations.length) {
  console.error(`lint:selfhost-env-example-declares-every-setting - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(`Offer it in ${EXAMPLE} (commented out, with a one-line comment), or list it in INTERNAL with why a self-hoster never sets it.`);
  process.exit(1);
}
console.log(`lint:selfhost-env-example-declares-every-setting OK (${read.size} settings read, ${read.size - Object.keys(INTERNAL).length} offered)`);
