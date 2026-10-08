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
// A GENERATED MULTI-MEGABYTE FILE IS NEVER TYPECHECKED THROUGH scripts/. A test
// that imported the 6 MB embedded bridge bundle made every run of this check
// parse it, and its read budget went red on every push from every session
// (17.3 MB against 7, 2026-10-08). tsc lists what it read; a file over
// BIG_BYTES outside node_modules is named, with the remedy.
//
// Placement row: dev-script + lint (scripts/placement-registry.ts).

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const BIG_BYTES = 1_500_000;
let out = "";
try {
  out = execFileSync("npx", ["tsc", "-p", "tsconfig.scripts.json", "--listFiles"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  const err = e as { stdout?: string; stderr?: string };
  out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
}

const big = out
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.includes("/node_modules/") && !/error TS\d+/.test(l))
  .flatMap((f) => {
    try {
      const n = statSync(f).size;
      return n > BIG_BYTES ? [`${f.replace(`${process.cwd()}/`, "")} (${(n / 1e6).toFixed(1)} MB)`] : [];
    } catch {
      return [];
    }
  });
if (big.length > 0) {
  console.error("scripts/ typechecks a file too big to parse on every run:");
  for (const b of big) console.error(`  ${b}`);
  console.error("  A script or test imports it statically. Load it when the test runs instead, through a");
  console.error("  specifier tsc does not follow (see scripts/lib/a-downloaded-bridge-can-serve-several-instruments.test.ts).");
  process.exit(1);
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
