// Guard: every bare pg Client in the api attaches an 'error' listener.
//
// pg's contract: an idle POOLED client's error goes to the pool's listener, but
// a bare Client - and a checked-out PoolClient - emits 'error' on ITSELF, and
// with no query in flight there is nothing to reject into. Unlistened, Node
// turns that event into process death.
//
// This is not hypothetical twice over. The tenant-pool listener comment records
// ~10% of CI runs dying this way before 2026-08-25; on 2026-08-31 the api died
// again through the NEXT unlistened emitter - the migration runner's checked-out
// client, killed by a parallel teardown's DROP DATABASE while the loop was
// between queries reading a .sql file. Every bare Client that connects to a
// tenant database has the same profile, and they get added one at a time by
// people who have never seen this crash.
//
// The rule: `new Client(` in api/src must have `.on("error"` within the next
// 12 lines. A construction that genuinely cannot die this way still costs one
// log-only listener, which is cheaper than one process death.
//
// Run: npx tsx scripts/lint-pg-client-error-listener.ts

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "api/src";
const WINDOW = 12;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

const problems: string[] = [];
let sites = 0;
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/\bnew (?:Pg)?Client\s*\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
    sites++;
    const window = lines.slice(i, i + WINDOW).join("\n");
    if (!/\.on\(\s*["']error["']/.test(window)) {
      problems.push(
        `  ${file}:${i + 1}\n      ${line.trim().slice(0, 90)}\n` +
          `      → attach client.on("error", ...) within ${WINDOW} lines; an unlistened pg Client error kills the process`,
      );
    }
  });
}
if (problems.length) {
  console.error(`✗ bare pg Clients without an error listener:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`✓ pg clients: all ${sites} bare Client constructions attach an error listener`);
