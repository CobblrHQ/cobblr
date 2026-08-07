// Guard: a PERIODIC cross-tenant sweep must not hand-roll the
// getDb + releaseIdleDb pair — it must use tenants.withDb (or carry an
// explicit justification).
//
// The class this kills (staging, 2026-08-07): releaseIdleTenantPool refuses
// to close a pool accessed within its grace window, and a sweep's OWN getDb
// is what stamps that access — so the hand-rolled pair released nothing,
// every tick accumulated one open pool per tenant, and a 251-tenant box
// exhausted Postgres max_connections every hour ("remaining connection
// slots are reserved for SUPERUSER"). withDb releases immediately when
// nothing else touched the pool during the sweep; the deferred-release
// fallback in api/src/db/tenant.ts covers everyone else.
//
// Rule, mechanically: a modules/**/src file containing BOTH `setInterval`
// and `tenants.getDb(` must either also call `tenants.withDb(` or carry a
// `// sweep-pools: deferred-release ok — <why>` annotation (for jobs that
// touch a small bounded org set, where the 15s deferred close is fine).
// Run: npx tsx scripts/lint-sweep-pool-eviction.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const failures: string[] = [];
let checked = 0;
for (const file of tsFiles("modules")) {
  if (!file.includes("/src/")) continue;
  const src = readFileSync(file, "utf8");
  if (!src.includes("setInterval") || !src.includes("tenants.getDb(")) continue;
  checked++;
  if (src.includes("tenants.withDb(")) continue;
  if (/\/\/ sweep-pools: deferred-release ok/.test(src)) continue;
  failures.push(file);
}

if (failures.length) {
  console.error("✗ lint-sweep-pool-eviction: periodic sweep hand-rolls getDb without withDb:");
  for (const f of failures) {
    console.error(`  ${f}`);
  }
  console.error(
    "\n  A sweep's own getDb access sits inside the release grace window, so a\n" +
      "  getDb + releaseIdleDb pair NEVER releases its own pool — one pool per\n" +
      "  tenant accumulates and Postgres runs out of connection slots.\n" +
      "  Use platform().tenants.withDb(orgId, fn), or, for a job that touches a\n" +
      "  small bounded org set, annotate the file:\n" +
      "    // sweep-pools: deferred-release ok — <why the org set is small>",
  );
  process.exit(1);
}
console.log(`✓ sweep-pool-eviction lint: ${checked} periodic cross-tenant sweep file(s) OK`);
process.exit(0);
