#!/usr/bin/env tsx
/**
 * lint:selfhost-skill — the install skill may only name real configuration.
 *
 * `deploy/selfhost/claude-skill/SKILL.md` is instructions an assistant follows
 * on somebody else's machine, unsupervised, and a variable name that no longer
 * exists does not fail loudly there. It gets written into a `.env`, ignored by
 * the stack, and produces an install that looks finished and behaves wrongly,
 * with nothing anywhere reporting the mismatch. That is the same class of bug
 * as a doc that goes stale, except the reader is a machine that will state it
 * with confidence.
 *
 * So every `COBBLR_*` / stack variable the skill mentions has to exist in the
 * canonical self-host surface, and every compose service and profile it names
 * has to be in the compose file. Rename a variable and this fails in the same
 * PR, which is the only moment anyone is in a position to fix the skill.
 *
 * PERMANENT: the skill is only useful while it is true.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = "deploy/selfhost/claude-skill/SKILL.md";
const COMPOSE = "deploy/selfhost/standalone/docker-compose.yml";
const ENV_EXAMPLE = "deploy/selfhost/standalone/.env.example";

const failures: string[] = [];
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

for (const p of [SKILL, COMPOSE, ENV_EXAMPLE]) {
  if (!existsSync(resolve(root, p))) {
    console.error(`lint:selfhost-skill: ${p} is missing.`);
    process.exit(1);
  }
}

const skill = read(SKILL);
const compose = read(COMPOSE);
const envExample = read(ENV_EXAMPLE);
const surface = `${compose}\n${envExample}`;

// Variables the skill tells someone to set, or names in prose. Deliberately
// broad: prose that names a variable is instruction too.
const NAMED = new Set(
  [...skill.matchAll(/\b((?:COBBLR|POSTGRES|WATCHTOWER|COMPOSE|TS|WEB|JWT|TENANT|SUPERADMIN|PUBLIC|CLOUDFLARE|DUCKDNS|BACKUP|DOCKER)_[A-Z0-9_]+)\b/g)].map((m) => m[1]),
);

// Set by the operator's shell rather than declared in the stack, so they are
// real without appearing in either canonical file.
const NOT_STACK_VARS = new Set(["DOCKER_API_VERSION"]);

for (const v of [...NAMED].sort()) {
  if (NOT_STACK_VARS.has(v)) continue;
  if (!surface.includes(v)) {
    failures.push(
      `${SKILL} names ${v}, which is in neither ${COMPOSE} nor ${ENV_EXAMPLE}. ` +
        `An assistant will write it into someone's .env and nothing will read it.`,
    );
  }
}

// Compose services the skill tells someone to act on (`docker compose up -d api`,
// `docker compose logs caddy`). A renamed service turns those into a no-op.
const services = new Set(
  [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]),
);
// Newlines collapsed first: markdown wraps prose, and `docker compose logs\ncaddy`
// is the same instruction as the one-line form. Matching the raw text missed it.
const flat = skill.replace(/\s+/g, " ");
for (const m of flat.matchAll(/docker compose (?:logs|up -d|restart|pull)\s+(?:-[a-z]+\s+)*([a-z][a-z0-9-]*)/g)) {
  const svc = m[1]!;
  if (!services.has(svc)) {
    failures.push(
      `${SKILL} runs \`docker compose … ${svc}\`, but ${COMPOSE} has no service called ${svc} ` +
        `(it has: ${[...services].join(", ")}).`,
    );
  }
}

// Profiles it tells someone to list. A profile that does not exist silently
// runs nothing, which is exactly how the autoupdate feature would rot.
const profiles = new Set(
  [...compose.matchAll(/profiles:\s*\[([^\]]*)\]/g)].flatMap((m) =>
    m[1]!.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
  ),
);
for (const m of skill.matchAll(/COMPOSE_PROFILES=([a-z0-9,]+)/g)) {
  for (const prof of m[1]!.split(",").filter(Boolean)) {
    if (!profiles.has(prof)) {
      failures.push(
        `${SKILL} tells someone to set COMPOSE_PROFILES=${m[1]}, but ${COMPOSE} defines no "${prof}" profile ` +
          `(it has: ${[...profiles].join(", ")}).`,
      );
    }
  }
}

// The one value that cannot be recovered. The skill's job is to stop somebody
// losing it, so a rewrite that drops that instruction should fail here.
if (!/TENANT_CREDS_ENCRYPTION_KEY/.test(skill) || !/irrecoverable|cannot be recovered|no backup fixes/i.test(skill)) {
  failures.push(
    `${SKILL} must warn that TENANT_CREDS_ENCRYPTION_KEY is irrecoverable. ` +
      `Losing it destroys the data in a way no backup fixes, and an unattended installer is exactly who needs telling.`,
  );
}

// Closing public signup is the difference between a private instance and one
// anybody who finds the address can join.
if (!/PUBLIC_SIGNUP_ENABLED=false/.test(skill)) {
  failures.push(`${SKILL} must tell the installer to set PUBLIC_SIGNUP_ENABLED=false after the first account exists.`);
}

if (failures.length) {
  console.error("lint:selfhost-skill: the install skill has drifted from the stack it installs.\n");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\n${failures.length} problem(s). Fix ${SKILL}, or the canonical files, so they agree.`);
  process.exit(1);
}

console.log(
  `lint:selfhost-skill: ok (${NAMED.size} variables, ${services.size} services, ${profiles.size} profiles all real)`,
);
