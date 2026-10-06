#!/usr/bin/env tsx
// An api test that asserts the scan feed is empty does it in a workspace only
// that case wrote to, and says so.
//
// THE BUG THIS PREVENTS. `a-scan-with-no-screen-is-watchable-elsewhere`
// passed only on a retry three times (#4957, #4987, #5059), each time on an
// assertion that the feed had nothing new: `expected [ {...} ] to deeply
// equal []`. Every case shared one workspace, and a case's scans keep
// changing after it ends (the identify, the match, a picture search land
// detached), which is real activity the feed is right to show. #4964 scoped
// one case to its own row; the next run failed on another case's emptiness.
//
// THE RULE. In api/tests, an emptiness assertion (`.toEqual([])`,
// `.toHaveLength(0)`) on a scan-feed read (`.scans`, in a file that reads
// `/modules/core-scan/feed`) carries `// FEED-OWN-WORKSPACE: <why this
// workspace is the case's alone>` on the line above. A non-empty assertion
// about one's own rows (`.toContain(id)`, `.not.toContain(id)`) is not
// judged.
//
// THE BOUNDARY. Only the scan feed: it is the one listing whose whole point
// is "what changed since", so anything any case did lands in it. Other
// listings filter by what a case made (a title, an id) and their emptiness
// is about the case's own rows. Thirty-odd such assertions elsewhere in
// api/tests were read and left out for that reason.
//
//   npx tsx scripts/lint-feed-quiet-is-own-workspace.ts   (pnpm lint feed-quiet-is-own-workspace)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests"];

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
    else if (/\.test\.ts$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!src.includes("/modules/core-scan/feed")) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\.scans\b/.test(line) || !/\.(toEqual\(\[\]\)|toHaveLength\(0\))/.test(line)) continue;
    if (/\/\/ FEED-OWN-WORKSPACE: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "the feed asserted empty without saying the workspace is this case's alone (FEED-OWN-WORKSPACE)" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:feed-quiet-is-own-workspace - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:feed-quiet-is-own-workspace OK`);
