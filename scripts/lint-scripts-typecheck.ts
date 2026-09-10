#!/usr/bin/env tsx
// RULE: scripts/ is typechecked, like the rest of the repo.
//
// It was not. `pnpm typecheck` walks the pnpm workspaces, and scripts/ is not
// one of them, so 200+ TypeScript files that run in CI, on the deploy box and
// on the bench were checked by nothing.
//
// It cost a night. The corpus bench's quota roll-over said `attempt -= 1`,
// naming a loop counter declared thirty lines below it and out of scope. That
// branch runs only when every API key has spent its daily quota, which is
// exactly the moment the nightly needed it: the run died with a
// ReferenceError, the answer cache never refilled, and every merge for the
// next day deferred its bench (2026-09-10). tsc had always known.
//
// This started as a gate on four error codes, because scripts/ carried 63
// other errors and a gate that cannot go green is a gate someone turns off.
// Those are fixed - a test file that imported the same four names twice, two
// version comparisons that read a short version as undefined rather than as
// zeroes, a dozen regex captures used without being there - so it now fails on
// any type error at all.
//
// Only scripts/ is judged here: everything else has its own typecheck, and a
// file pulled in by an import answers to that one.
//
// Placement row: dev-script + lint (scripts/placement-registry.ts).

import { execFileSync } from "node:child_process";

let out = "";
try {
  execFileSync("npx", ["tsc", "-p", "tsconfig.scripts.json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  const err = e as { stdout?: string; stderr?: string };
  out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
}

const hits = out.split("\n").filter((l) => /^scripts\/.*error TS\d+/.test(l));

if (hits.length > 0) {
  console.error(`scripts/ does not typecheck (${hits.length} error(s)):`);
  console.error("");
  for (const h of hits.slice(0, 40)) console.error(`  ${h}`);
  if (hits.length > 40) console.error(`  ...and ${hits.length - 40} more`);
  process.exit(1);
}
console.log("scripts/ typechecks");
