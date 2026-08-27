// Guard: every `new Pool(...)` attaches an 'error' listener.
//
// WHY THIS IS A LINT: in node-postgres, a pool whose backend goes away emits
// 'error' on the POOL. An unhandled 'error' event does not log — it TERMINATES
// THE PROCESS. So one dropped database takes down the whole api.
//
// That is not hypothetical. `provisioningPool` in api/src/db/provision.ts was
// missing its listener; it connects to a brand-new tenant DB while migrations
// run, and a parallel test fork's teardown drops tenant databases, so the
// backend genuinely vanishes underneath it (SQLSTATE 57P01, admin_shutdown).
// Measured 2026-08-25: ~10% of `test` runs red because of it.
//
// It is also invisible in the failure: the api dies ONCE, and every request
// after that fails, so it presents as dozens of unrelated tests breaking at
// once — a single run showed 472 ECONNREFUSED assertions across 34 files. You
// go looking for 34 bugs instead of one missing line.
//
// meta.ts and tenant.ts have carried this listener for years, each with a
// comment explaining why. Provisioning was simply the copy nobody revisited,
// which is exactly the shape a lint is for.
//
// Run: npx tsx scripts/lint-pool-error-handlers.ts

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let files: string[] = [];
try {
  // Literal prefilter, then the real check in JS — see scripts/run-lints.mjs
  // BUDGET_MS for why a regex sweep of the whole tree is not acceptable here.
  files = execFileSync("git", ["grep", "-lF", "new Pool(", "--", "*.ts"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch {
  // git grep exits 1 when nothing matches — no pools, nothing to guard.
}

const offenders: string[] = [];
for (const file of files) {
  if (file.startsWith("scripts/lint-pool-error-handlers.ts")) continue; // documents the trap
  const src = readFileSync(file, "utf8");
  const pools = (src.match(/new Pool\(/g) ?? []).length;
  const handlers = (src.match(/\.on\(\s*["']error["']/g) ?? []).length;
  if (handlers < pools) {
    offenders.push(`${file}: ${pools} pool(s), ${handlers} 'error' listener(s)`);
  }
}

if (offenders.length === 0) {
  console.log(`✓ pool-error-handlers lint: every Pool in ${files.length} file(s) has an 'error' listener`);
  process.exit(0);
}

console.error("✗ lint-pool-error-handlers: a Pool without an 'error' listener will KILL the process:\n");
for (const o of offenders) console.error(`  ${o}`);
console.error(
  "\n  node-postgres emits 'error' on the pool when a backend goes away (a dropped\n" +
    "  database, a restarted server, a network blip). An unhandled 'error' event\n" +
    "  terminates Node — it does not merely log.\n\n" +
    "  Add one, next to the pool:\n\n" +
    '    pool.on("error", (err) => {\n' +
    '      console.error("[<which-pool>] idle client error:", (err as Error).message);\n' +
    "    });\n",
);
process.exit(1);
