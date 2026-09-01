// Guard: every `new Pool(...)` and `new Client(...)` attaches an 'error' listener,
// and every Pool also wraps its `connect` with guardPoolClients().
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

// Literal prefilter, then the real check in JS — see scripts/run-lints.mjs
// BUDGET_MS for why a regex sweep of the whole tree is not acceptable here.
const hits = (needle: string): string[] => {
  try {
    return execFileSync("git", ["grep", "-lF", needle, "--", "*.ts"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
};

const files = [...new Set([...hits("new Pool("), ...hits("new Client(")])];

const offenders: string[] = [];
for (const file of files) {
  if (file.startsWith("scripts/lint-pool-error-handlers.ts")) continue; // documents the trap
  const src = readFileSync(file, "utf8");
  const pools = (src.match(/new Pool\(/g) ?? []).length;
  const clients = (src.match(/new Client\(/g) ?? []).length;
  const handlers = (src.match(/\.on\(\s*["']error["']/g) ?? []).length;
  if (handlers < pools + clients) {
    const what = [pools ? `${pools} pool(s)` : "", clients ? `${clients} client(s)` : ""]
      .filter(Boolean)
      .join(" + ");
    offenders.push(`${file}: ${what}, ${handlers} 'error' listener(s)`);
  }
}


// ── rule 2: every Pool guards the clients it HANDS OUT ──────────────────────
//
// pg-pool's `_acquireClient` runs `client.removeListener('error', idleListener)`,
// so between `pool.connect()` and `release()` a client has NO listener and an
// 'error' event throws rather than logging. Rule 1 cannot see this: the pool it
// checks is perfectly well guarded. That is how the same outage returned on
// 2026-09-01 after every pool had been fixed in August.
//
// The first fix guarded call sites one by one. It could not finish the job:
// Kysely acquires its own clients and holds one for the length of every
// transaction, so the most common checkout is one no application file writes.
// The seam is the pool's `connect`, and guardPoolClients wraps it once. So the
// rule is per POOL, not per call site: anything that can hand out a client must
// have been wrapped.
for (const file of files) {
  if (file.startsWith("scripts/lint-pool-error-handlers.ts")) continue;
  if (file.endsWith("api/src/db/client-error-guard.ts")) continue; // defines the seam
  const src = readFileSync(file, "utf8");
  const pools = (src.match(/new Pool\(/g) ?? []).length;
  const seams = (src.match(/guardPoolClients\(/g) ?? []).length;
  if (pools > 0 && seams < pools) {
    offenders.push(
      `${file}: ${pools} pool(s), ${seams} guardPoolClients() call(s) — a client checked out of the unwrapped one has no 'error' listener`,
    );
  }
}

if (offenders.length === 0) {
  console.log(`✓ pool-error-handlers lint: ${files.length} file(s) with pools/clients guarded, and every pool wraps connect`);
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
