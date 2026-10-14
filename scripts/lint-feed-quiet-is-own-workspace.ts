#!/usr/bin/env tsx
// An api test that asserts the scan feed is empty or truncates its cursor does
// it in a workspace only that case wrote to, and says so.
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
// workspace is the case's alone>` on the line above. A cursor assigned after
// conversion through Date needs the same annotation: the page's newest
// activity can belong to another case's row, even when the asserted id is
// this case's own. A late pass on an older scan advanced the cursor beyond a
// precision fixture, so truncating it no longer replayed the fixture.
//
// THE BOUNDARY. Only the scan feed: it is the one listing whose whole point
// is "what changed since", so anything any case did lands in it. Other
// listings filter by what a case made (a title, an id) and their emptiness
// is about the case's own rows. Thirty-odd such assertions elsewhere in
// api/tests were read and left out for that reason.
// Date conversions inside timestamp assertions are comparisons, not cursors
// sent back to the feed, and are left out too. Non-empty assertions about
// one's own ids remain outside the rule.
//
//   npx tsx scripts/lint-feed-quiet-is-own-workspace.ts   (pnpm lint feed-quiet-is-own-workspace)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { onlyChanged } from "./lib/lint-only-files.ts";

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
export function check(file: string, src: string): Violation[] {
  if (!src.includes("/modules/core-scan/feed")) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\.scans\b/.test(line) || !/\.(toEqual\(\[\]\)|toHaveLength\(0\))/.test(line)) continue;
    if (/\/\/ FEED-OWN-WORKSPACE: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "the feed asserted empty without saying the workspace is this case's alone (FEED-OWN-WORKSPACE)" });
  }
  const tree = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const reported = new Set<number>();
  const visit = (node: ts.Node): void => {
    const date = ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date";
    const parse = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Date" && node.expression.name.text === "parse";
    if ((date || parse) && (ts.isNewExpression(node) || ts.isCallExpression(node))
      && node.arguments?.some((arg) => ts.isPropertyAccessExpression(arg) && arg.name.text === "cursor")) {
      let parent = node.parent;
      while (parent && !ts.isVariableDeclaration(parent) && !ts.isStatement(parent)) parent = parent.parent;
      if (parent && ts.isVariableDeclaration(parent)) {
        const i = tree.getLineAndCharacterOfPosition(parent.getStart(tree)).line;
        if (!reported.has(i) && !/\/\/ FEED-OWN-WORKSPACE: \S/.test(lines[i - 1] ?? "")) {
          reported.add(i);
          out.push({ file, line: i + 1, what: "a feed cursor precision control can borrow another scan's activity clock (FEED-OWN-WORKSPACE)" });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

  if (violations.length) {
    console.error(`lint:feed-quiet-is-own-workspace - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
    process.exit(1);
  }
  console.log(`lint:feed-quiet-is-own-workspace OK`);
}
