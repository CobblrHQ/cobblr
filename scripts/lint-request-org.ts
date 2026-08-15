#!/usr/bin/env tsx
/**
 * lint:request-org — a module route reads its workspace from `req.tenant`.
 *
 * The tenant middleware sets `req.tenant.org.id`. There is NO `req.org`. A
 * route that reaches for one gets `undefined`, falls back to "", and then every
 * downstream decision that needed a workspace silently has none -- no error, no
 * log, just a value that is empty forever.
 *
 * That shipped. core-shipments' /status read `req.org?.id`, so "check this
 * parcel now" failed with "no workspace context to route to a bridge" on an
 * instance whose bridge was connected and answering. The endpoint had never
 * been able to route to a bridge; nothing said so because "" is a legal string.
 *
 * The rule: modules do not reach into the request for a workspace or user id.
 * They call their own `requestOrg(req)` helper, which reads the one true shape.
 *
 * Run: npx tsx scripts/lint-request-org.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIR = "modules";

/** Reaching for a property the platform never sets.
 *
 *  Deliberately narrow: `.org` reached DIRECTLY off the request, or off a cast
 *  of it. A helper that takes the request and returns a real tenant context
 *  (`tenantContext(req).org.id`) is the correct pattern and must not trip this. */
const BAD = [
  { re: /\breq\s*\.org\b/, why: "req.org does not exist" },
  { re: /\(\s*req\s+as\b[^)]*\)\s*\.org\b/, why: "req.org does not exist" },
  { re: /\{\s*org\?\s*:\s*\{\s*id\?\s*:\s*string\s*\}\s*\}/, why: "casting req to { org } invents a shape" },
];

/** The helpers that ARE allowed to know the request's shape. */
const ALLOWED = /\/request-org\.ts$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = `${dir}/${e}`;
    if (e === "node_modules" || e === "dist") continue;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (rel.endsWith(".ts") && !rel.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

const findings: string[] = [];
for (const file of walk(DIR)) {
  if (ALLOWED.test(file)) continue;
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const { re, why } of BAD) {
      if (re.test(line)) findings.push(`  ${file}:${i + 1}  ${why}\n      ${line.trim().slice(0, 100)}`);
    }
  });
}

if (findings.length) {
  console.error(`❌ ${findings.length} route(s) reading a request shape that does not exist:\n`);
  console.error(findings.join("\n"));
  console.error(
    "\nUse the module's requestOrg(req) helper (modules/core-shipments/src/api/request-org.ts\n" +
      "is the reference). It reads req.tenant.org.id, which is what the tenant\n" +
      "middleware actually sets. An empty org id is not an error anyone will see.",
  );
  process.exit(1);
}
console.log("request-org lint: clean");
