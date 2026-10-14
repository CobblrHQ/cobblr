#!/usr/bin/env tsx
// No code checks out pool clients with a bare Promise.all over connect(): when one checkout times out the rest are stranded, so use holdClients (api/src/db/pool-stats.ts), which gives back what it got.
//
// THE BUG THIS PREVENTS. a CI run's meta pool wedged for good (#3666): a test endpoint's Promise.all over metaPool.connect() lost a race with the connect timeout and stranded every client it had taken
//
// THE RULE. A `Promise.all(` whose argument (the whole parenthesised call,
// across lines) contains a `.connect(` fails: that is a batch of checkouts
// that strands every client it got when any one of them rejects, because the
// caller only ever sees the rejection. `Promise.allSettled` passes, and so
// does holdClients, which is built on it and releases what it got before
// rethrowing. No opt-out: there is no case where a stranded client is right.
//
// THE BOUNDARY. Only `.connect(` counts, not `.query(`: a pool query takes and
// returns its own client inside one call, so a Promise.all of queries can
// wait on a busy pool but cannot strand anything. Test files are out of scope;
// a test's fake pool is thrown away with the test.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-no-promise-all-over-connect.ts   (pnpm lint no-promise-all-over-connect)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "packages"];

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
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const re = /\bPromise\.all\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // The argument of this Promise.all, by counting parentheses.
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (let i = end; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    const arg = src.slice(m.index, end + 1);
    if (/\.connect\s*\(/.test(arg)) {
      out.push({
        file,
        line: src.slice(0, m.index).split("\n").length,
        what: "Promise.all over connect(): one checkout timing out strands every client the others got",
      });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-promise-all-over-connect - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("use holdClients(pool, n) from api/src/db/pool-stats.ts");
  process.exit(1);
}
console.log(`lint:no-promise-all-over-connect OK`);
