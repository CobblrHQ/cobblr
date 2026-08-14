#!/usr/bin/env tsx
/**
 * lint:env-reaches-container — a setting the api reads must survive the trip into the
 * container.
 *
 * `docker-compose.yml` passes the api's environment as an EXPLICIT map (`KEY: ${KEY:-}`)
 * rather than `env_file:`. That is deliberate — it documents the surface and keeps the
 * host's whole environment out of the container — but it means a variable can be in the
 * Zod schema, be read correctly at runtime, be set in the operator's `.env`, and still
 * arrive undefined. Nothing errors. The feature is simply off, and the deploy that
 * turned it on reports success.
 *
 * Found by measurement on 2026-08-13, wiring central identity: NINETEEN of the schema's
 * 38 variables reached nothing. Among them the entire trial-instance guard set
 * (`COBBLR_TIER`, `COBBLR_TRIAL_DENY_MODULES`, `COBBLR_REQUIRE_EMAIL_VERIFY`, the
 * captcha trio) — a try instance would have booted with every guard silently off while
 * looking exactly like a working deploy.
 *
 * `lint:env-documented` is the neighbouring check and a different question: it asks
 * whether a var the DOCS promise is read by anything, and only for `COBBLR_*`. This one
 * asks whether a var the CODE reads can be set at all, for every prefix.
 *
 * The self-host stack is immune (`deploy/selfhost` uses `env_file:`), so it is not read
 * here.
 *
 *   pnpm run lint:env-reaches-container
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Set by the runtime, by compose itself, or by the image — never by an operator's .env. */
const AMBIENT = new Set(["NODE_ENV", "API_PORT", "PORT"]);

/**
 * Deliberately NOT passed through, each for a stated reason. A var only belongs here if
 * carrying it would be wrong, not merely if nobody has got round to it.
 */
const WITHHELD: Record<string, string> = {
  COBBLR_TEST_ORG_POOL:
    "test rig only — it registers a token-minting route, so it must be impossible to switch on from a prod .env",
  COBBLR_TEST_ORG_POOL_SIZE: "sizes the test-only pool above; meaningless without it",
};

const schema = readFileSync(join(ROOT, "api/src/env.ts"), "utf8");
const body = /const Schema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(schema)?.[1];
if (!body) {
  console.error("[lint:env-reaches-container] could not find `const Schema = z.object({` in api/src/env.ts");
  process.exit(1);
}
const declared = [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);
if (declared.length < 20) {
  // A regex that quietly matches nothing would make this lint pass forever, which is the
  // same failure it exists to prevent, one level up.
  console.error(`[lint:env-reaches-container] only ${declared.length} vars parsed out of env.ts — the parse is broken`);
  process.exit(1);
}

const COMPOSE = ["docker-compose.yml", "deploy/docker-compose.prod.yml"];
const wired = new Set<string>();
for (const file of COMPOSE) {
  let text: string;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s/gm)) wired.add(m[1]!);
  for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) wired.add(m[1]!);
}

// SECOND SOURCE: anything the operator docs tell somebody to set.
//
// The schema is not the only way this code reads configuration. The signup caps are
// read as intEnv("COBBLR_SIGNUP_MAX_PER_IP_PER_DAY") — the name is a STRING ARGUMENT, so
// neither a schema parse nor a process.env scan can see it, and they were missing from
// compose while the docs told an operator to set them. On an instance with an open
// signup page that is the brake not connected to anything.
//
// The rule that covers it without a hand-kept list: IF THE DOCS PROMISE IT, IT MUST
// ARRIVE. Tuning knobs nobody documents stay out of scope; the moment one is written
// down as settable, it is in.
// Env TEMPLATES only. A markdown runbook writes `TARGET_TS=… ./promote.sh`, a shell
// variable for one command rather than a container setting, and flagging those is how a
// lint teaches people to ignore it.
const DOC_SOURCES = ["deploy/.env.example", ".env.example"];
const promised = new Map<string, string>();
for (const file of DOC_SOURCES) {
  let text: string;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  // `NAME=` or `# NAME=` in a template, which is how these files offer a setting.
  for (const m of text.matchAll(/^#?\s*([A-Z][A-Z0-9_]{3,})=/gm)) {
    if (!promised.has(m[1]!)) promised.set(m[1]!, file);
  }
}
const promisedMissing = [...promised].filter(
  ([k]) => !wired.has(k) && !AMBIENT.has(k) && !(k in WITHHELD) && !declared.includes(k),
);

const missing = declared.filter((k) => !wired.has(k) && !AMBIENT.has(k) && !(k in WITHHELD));

// A withheld var that someone has since wired means the exemption is stale prose making
// a claim the file no longer honours. Say so rather than let the list rot.
const staleWithheld = Object.keys(WITHHELD).filter((k) => wired.has(k));

if (missing.length || staleWithheld.length || promisedMissing.length) {
  if (promisedMissing.length) {
    console.error("[lint:env-reaches-container] ✗ the docs offer these, but they never reach the container:\n");
    for (const [name, file] of promisedMissing) console.error(`    ${name}  (promised in ${file})`);
    console.error("");
  }
  if (missing.length) {
    console.error("[lint:env-reaches-container] ✗ read by api/src/env.ts, never passed to the container:\n");
    for (const k of missing) console.error(`    ${k}`);
    console.error(`
  Add each to the api service's environment: block in docker-compose.yml:

      ${missing[0]}: \${${missing[0]}:-}

  or, if it must never be settable from a prod .env, add it to WITHHELD in this file
  with the reason.
`);
  }
  if (staleWithheld.length) {
    console.error(`[lint:env-reaches-container] ✗ listed as withheld but compose passes it: ${staleWithheld.join(", ")}`);
    console.error("  Either drop it from compose or drop it from WITHHELD — the two now disagree.\n");
  }
  process.exit(1);
}

console.log(
  `[lint:env-reaches-container] ✓ ${declared.length - Object.keys(WITHHELD).length} schema settings` +
    ` and ${promised.size} documented ones reach the container` +
    ` (${Object.keys(WITHHELD).length} withheld on purpose)`,
);
