// Guard: no SHIPPED self-host .env template may carry a secret value that the
// production boot guard (api/src/env-secret-guard.ts) would reject.
//
// The trap this catches: deploy/selfhost/**/.env.example shipped
// POSTGRES_PASSWORD=change-me and DATABASE_URL=postgres://cobblr:change-me@...,
// and the repo-root .env.example shipped JWT_SECRET=dev-only-... /
// TENANT_CREDS_ENCRYPTION_KEY=dev-only-... — all of which passed env.ts's
// length check. A self-hoster who copied a template booted with a
// publicly-known signing key, credential-encryption key, or DB password.
// See docs/history/2026-08-25-prerelease-audit.md B1.
//
// The self-host overlays set NODE_ENV=production, so a placeholder secret in
// their template is exactly what the boot guard now refuses. This lint makes
// that impossible to SHIP, not just to boot — the template and the guard read
// the same rule (weakSecretReasons), so they cannot drift.
//
// A required secret must ship BLANK (the operator fills it; blank fails loud
// at boot). A DB URL may keep a non-weak placeholder like <password>.
// Run: npx tsx scripts/lint-selfhost-secrets.ts

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { weakSecretReasons, WEAK_DB_PASSWORDS } from "../api/src/env-secret-guard.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every .env template that ships to a production self-host (the publish
// allowlist covers deploy/selfhost/**). The repo-root .env.example is the DEV
// template (docker-compose.yml defaults NODE_ENV=development) and is exempt —
// the boot guard is what protects a user who copies it into production.
const TEMPLATES = [
  "deploy/selfhost/.env.example",
  "deploy/selfhost/standalone/.env.example",
];

// Secrets that must never ship a real-looking value; blank is required.
const MUST_BE_BLANK = ["JWT_SECRET", "TENANT_CREDS_ENCRYPTION_KEY", "POSTGRES_PASSWORD"];

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

const problems: string[] = [];

for (const rel of TEMPLATES) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) continue; // a template may not exist in every tree
  const env = parseEnv(readFileSync(path, "utf8"));

  for (const key of MUST_BE_BLANK) {
    const v = env.get(key);
    if (v !== undefined && v !== "") {
      problems.push(`${rel}: ${key} ships a value ("${v}") — it must be blank so the operator sets it and a missing value fails loud at boot.`);
    }
  }

  // Reuse the boot guard's exact rule over whatever this template ships. Blank
  // values don't trip it (a blank secret has no dev prefix; a blank URL has no
  // password) — this catches a non-blank weak value like change-me in a URL.
  const reasons = weakSecretReasons({
    JWT_SECRET: env.get("JWT_SECRET") ?? "",
    TENANT_CREDS_ENCRYPTION_KEY: env.get("TENANT_CREDS_ENCRYPTION_KEY") ?? "",
    DATABASE_URL: env.get("DATABASE_URL") ?? "",
    SUPERUSER_DATABASE_URL: env.get("SUPERUSER_DATABASE_URL") ?? "",
  });
  for (const r of reasons) problems.push(`${rel}: ${r}`);
}

if (problems.length > 0) {
  console.error("lint:selfhost-secrets — a shipped self-host template carries a secret the production boot guard would reject:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    `\nRequired secrets (${MUST_BE_BLANK.join(", ")}) must ship BLANK; DB URLs may use a non-weak placeholder (weak set: ${[...WEAK_DB_PASSWORDS].join(", ")}).`,
  );
  process.exit(1);
}

console.log(`lint:selfhost-secrets — ${TEMPLATES.length} template(s) clean.`);
