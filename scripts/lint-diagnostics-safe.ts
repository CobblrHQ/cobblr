// The diagnostics payload becomes PUBLIC. Keep it that way.
//
// api/src/routes/diagnostics.ts exists so a self-hoster can paste their
// environment into an issue on a public tracker. Everything it returns is
// therefore published by definition, and the danger is not the code as written
// today — it is the field somebody adds in six months because it would be handy
// for debugging. "Also include the org name" or "add the connection string, it
// helps" is a one-line diff that reads as helpful in review and quietly starts
// publishing other people's data.
//
// So the route is held to an ALLOWLIST. Adding a field is deliberate: you extend
// the list here, in a file whose entire subject is that the output is public.
//
// Deliberately absent from the allowlist, and why:
//   user/org names, emails, ids   identify people who never opted into the issue
//   counts of orgs/users/rows     a competitor's or attacker's free census
//   env var VALUES                secrets live there; COBBLR_BUILD_SHA is the
//                                 one exception and is already a public git sha
//   connection strings, tokens    obvious, and obvious things still ship

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FILE = "api/src/routes/diagnostics.ts";

/** Keys the payload may contain. Extend deliberately; read the header first. */
const ALLOWED_KEYS = new Set([
  "build_sha",
  "version",
  "hosted",
  "node",
  "platform",
  "postgres",
  "modules",
]);

/** Env vars the route may read. All are deployment facts, not secrets. */
const ALLOWED_ENV = new Set(["COBBLR_BUILD_SHA", "COBBLR_VERSION", "COBBLR_HOSTED"]);

/** Tables that would mean the payload is describing people, not the machine. */
const FORBIDDEN_TABLES = /selectFrom\(\s*["'](users|orgs|org_memberships|api_tokens|activity_log|feedback|workspace_[a-z_]+)["']/;

const src = readFileSync(join(ROOT, FILE), "utf8");
const problems: string[] = [];

// 1. Response keys — the object literal handed to res.json().
const body = src.match(/res\.json\(\{([\s\S]*?)\n {6}\}\);/);
if (!body) {
  problems.push("could not find the res.json({…}) payload to check");
} else {
  for (const m of body[1]!.matchAll(/^\s{8}(\w+):/gm)) {
    const key = m[1]!;
    if (!ALLOWED_KEYS.has(key)) {
      problems.push(`payload key "${key}" is not on the public allowlist`);
    }
  }
}

// 2. Env reads.
for (const m of src.matchAll(/process\.env\.(\w+)/g)) {
  if (!ALLOWED_ENV.has(m[1]!)) {
    problems.push(`reads process.env.${m[1]} — env values are secrets by default`);
  }
}

// 3. Tables that describe people rather than the deployment.
const table = src.match(FORBIDDEN_TABLES);
if (table) {
  problems.push(`queries "${table[1]}" — that describes people, not the environment`);
}

if (problems.length) {
  console.error(`[lint:diagnostics-safe] ${FILE} may be publishing more than it should:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`
  This payload is copy-pasted into a PUBLIC issue tracker, so every field in it
  is published, by every self-hoster, forever.

  If the new field really is environment-only and safe to publish, add it to
  ALLOWED_KEYS in scripts/lint-diagnostics-safe.ts and say in the commit why it
  cannot identify a person or an instance.
`);
  process.exit(1);
}

console.log(
  `[lint:diagnostics-safe] ok — ${ALLOWED_KEYS.size} public fields, no secrets, no personal data.`,
);
