#!/usr/bin/env tsx
// A boot pass marked PERMANENT RECONCILE never skips itself on COBBLR_SKIP_HISTORICAL_MIGRATIONS: that flag is for one-shot historical upgrades, and a permanent catch-up it silenced left CI's nightly-baked pool without a pull request's new default wire.
//
// THE BUG THIS PREVENTS. backfillDefaultBindings honoured the historical-skip flag, so a PR adding a default wire failed every pooled test in CI (#4050, 2026-09-29)
//
// THE RULE. A file whose header says `PERMANENT RECONCILE` (the marker
// lint:heal-shims already requires on every forever-running boot pass) must
// not read COBBLR_SKIP_HISTORICAL_MIGRATIONS anywhere. The flag is CI's way
// of skipping one-shot historical upgrades against a pool baked by recent
// code; a permanent catch-up exists precisely because recent code keeps
// changing, so skipping it there hides the one case it is for. A one-shot
// shim (`DONE WHEN:`) may honour the flag, and is not judged here. There is
// no opt-out: a permanent pass that is too slow to run in CI is made cheap on
// its happy path (one read and an in-memory diff), not silenced.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The first draft matched any
// mention of the flag and caught heal-shim-log.ts, a PERMANENT RECONCILE that
// reads it to avoid RECORDING a zero from a shim that never looked. That skips
// no work, so it is right; the rule is now the early return, `if (…flag…)
// return`, which is how a pass silences itself. The historical passes that
// honour the flag (migrate-inventory-locations and the lens conversions) are
// DONE WHEN shims, so reading the flag there is correct and untouched. The
// flag is only matched as the env-var name, so prose that mentions it in a
// comment while explaining why the pass does NOT read it would be a false
// positive: comment lines are skipped.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-permanent-reconcile-runs.ts   (pnpm lint permanent-reconcile-runs)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!/PERMANENT RECONCILE/.test(src.split("\n").slice(0, 30).join("\n"))) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (/\bif\s*\(.*COBBLR_SKIP_HISTORICAL_MIGRATIONS.*\)\s*\{?\s*return\b/.test(line)) {
      out.push({ file, line: i + 1, what: "a PERMANENT RECONCILE skips itself on COBBLR_SKIP_HISTORICAL_MIGRATIONS" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:permanent-reconcile-runs - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("remove the COBBLR_SKIP_HISTORICAL_MIGRATIONS check, and make the pass cheap on the happy path instead");
  process.exit(1);
}
console.log(`lint:permanent-reconcile-runs OK`);
