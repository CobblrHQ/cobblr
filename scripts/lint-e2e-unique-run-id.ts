// An e2e script's run id must be unique PER RUN, not per wall-clock moment.
//
// A walkthrough signs up a throwaway account whose email carries a run id:
// `household-${rnd}@home.local`. When that id came from
// `Math.floor(performance.now()) % 100000` it was milliseconds since PROCESS
// START — a small number that is very nearly the same every time the same
// script runs. Run the script twice and you get the same email, the second
// signup answers `email_taken`, and the walkthrough dies in whatever way that
// script happens to notice:
//
//   home-life  → `sign.json.orgs[0]` on an error body → TypeError
//   bjorn      → the UI signup never lands a token → every later call sends
//                `Bearer undefined` → "Invalid Compact JWS"
//
// The nightly runs every SPLIT walkthrough twice (top-nav + full-sidebar), and
// retries a failure once, so it re-runs scripts by design: this bit two of them
// on 2026-08-27, and the symptoms looked like an auth bug rather than a
// duplicate email. Including `process.pid` (a fresh pid per run) or
// `Math.random()` makes the id genuinely per-run.
//
// Run: npx tsx scripts/lint-e2e-unique-run-id.ts

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const E2E = join(ROOT, "e2e");

const violations: string[] = [];

for (const file of readdirSync(E2E).filter((f) => f.endsWith(".mjs")).sort()) {
  const src = readFileSync(join(E2E, file), "utf8");
  // Only scripts that actually mint an account can collide on one.
  if (!/auth\/signup|create account/i.test(src)) continue;
  for (const m of src.matchAll(/^\s*(?:const|let)\s+(\w*(?:rnd|rand|uniq|suffix|stamp)\w*)\s*=\s*([^;\n]+)/gim)) {
    const [, name, expr] = m;
    if (!expr || !/performance\.now\(\)/.test(expr)) continue;
    if (/process\.pid|Math\.random|randomUUID|Date\.now\(\)/.test(expr)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    violations.push(
      `  e2e/${file}:${line}  ${name} = ${expr.trim().slice(0, 70)}\n` +
        `       performance.now() is ms since PROCESS START, so a re-run repeats it.`,
    );
  }
}

if (violations.length > 0) {
  console.error(
    `e2e run ids that repeat when the script is re-run (${violations.length}):\n` +
      `${violations.join("\n")}\n\n` +
      `The nightly runs split walkthroughs twice and retries failures once, so a\n` +
      `repeated id means the second signup gets email_taken and the script dies\n` +
      `somewhere far from the cause. Use the pid-bearing form the suite already has:\n` +
      "       const rnd = `${process.pid}${Math.floor(performance.now())}`;",
  );
  process.exit(1);
}
console.log(`lint:e2e-unique-run-id - every e2e run id is unique per run ✓`);
