#!/usr/bin/env tsx
// A print job may only END through markJobTerminal().
//
// Ending a job that was on a machine leaves something on the bed, and the next
// queued plate must not be dripped onto it. That rule was written once, INLINE
// in pollJob (the "F-1 ATOMIC" transaction), so it covered prints that finish
// on their own and missed every other way a job ends:
//
//   api/jobs.ts        a user cancels a RUNNING print  → half a part on the plate
//   api/connections.ts a connection is removed         → whatever was printing
//   assign-worker.ts   a send fails mid-assign         → a partial upload
//
// Each wrote a bare `status: "cancelled" | "failed"` with no bed-clear row. The
// symptom is physical (a second plate onto an occupied bed) and the detector
// was an intermittent CI test, which is the worst combination: rare, expensive,
// and easy to dismiss as flake.
//
// So the transaction lives in ONE helper and this lint keeps it that way: no
// file outside jobs-core.ts may set a digifab_jobs status to a terminal value.
//
//   cd <repo> && npx tsx scripts/lint-digifab-terminal-jobs.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "modules/digifab/src";
/** Where the helper itself lives. */
const EXEMPT = ["modules/digifab/src/jobs-core.ts"];
/** `.set({ ... status: "completed" | "failed" | "cancelled" ... })` */
const TERMINAL_SET = /status:\s*"(completed|failed|cancelled)"/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const failures: string[] = [];
for (const file of walk(ROOT)) {
  const rel = file.replace(/\\/g, "/");
  if (EXEMPT.includes(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!TERMINAL_SET.test(line)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments about the rule
    // Only a WRITE counts. Reads/filters (`where("status", "=", "failed")`),
    // response bodies and driver-status mapping are not job endings.
    const window = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
    if (!/\.set\(\s*\{[^}]*$|\.set\(\{/.test(window) && !/\.set\(/.test(line)) return;
    if (!/digifab_jobs/.test(window)) return;
    failures.push(
      `${rel}:${i + 1} ends a job without the bed-clear gate:\n` +
        `    ${line.trim()}\n` +
        `    → use markJobTerminal(db, prev, status, extra) from jobs-core.\n` +
        `      A job that was on a machine leaves something on the bed; the status\n` +
        `      flip and the needs_attention row must commit in ONE transaction.`,
    );
  });
}

if (failures.length) {
  console.error(`[lint:digifab-terminal-jobs] ✗ ${failures.length} bare terminal write(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:digifab-terminal-jobs] ✓ every job ending goes through markJobTerminal");
