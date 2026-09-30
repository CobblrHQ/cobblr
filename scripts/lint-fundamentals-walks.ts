#!/usr/bin/env tsx
// Every fundamentals audit area whose page has landed is walked every night: a walk script (e2e/fundamentals-*-walk.mjs) names that page, so an area cannot drop out of the nightly.
//
// THE BUG THIS PREVENTS. the 2026-09 fundamentals audit (#4115) found problems in features nobody had walked in months; the nightly walk keeps them walked, and this keeps every area in it (2026-09-30)
//
// THE RULE. Every page the audit README links (a landed area; a name still in
// backticks is pending and exempt) must be named by exactly one walk script,
// e2e/fundamentals-*-walk.mjs, through `export const page = "<file>.md"`. A
// landed page no walk names fails, and so does a walk that names a page the
// README does not link (a typo, or a page renamed without its walk).
//
// THE BOUNDARY. The page names the area, not the walk's file name: scan
// pipeline's walk is labels-files while its page is labels-files-camera.md,
// and the README table is edited by every area's page PR, so a column there
// would conflict with each of them.
//
//   npx tsx scripts/lint-fundamentals-walks.ts   (pnpm lint fundamentals-walks)
import { existsSync, readFileSync, readdirSync } from "node:fs";

const README = "docs/history/audits/2026-09-fundamentals/README.md";

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

const violations: Violation[] = [];
const readme = existsSync(README) ? readFileSync(README, "utf8") : "";
// The landed pages: a markdown link to a sibling .md in the areas table, and
// only there. The README links other pages too (the template, the guardrails
// list), and reading the whole file asked the nightly to walk guardrails.md.
const areasStart = readme.indexOf("## The areas");
const areasEnd = areasStart < 0 ? -1 : readme.indexOf("\n## ", areasStart + 1);
const areas = areasStart < 0 ? "" : readme.slice(areasStart, areasEnd < 0 ? undefined : areasEnd);
const landed = new Set([...areas.matchAll(/\]\(\.?\/?([a-z0-9-]+\.md)\)/g)].map((m) => m[1]!).filter((f) => f !== "_template.md"));
const walks = existsSync("e2e") ? readdirSync("e2e").filter((f) => /^fundamentals-.+-walk\.mjs$/.test(f)) : [];
const claimed = new Map<string, string[]>();
for (const w of walks) {
  const page = /export const page\s*=\s*["']([^"']+)["']/.exec(readFileSync(`e2e/${w}`, "utf8"))?.[1];
  if (!page) {
    violations.push({ file: `e2e/${w}`, line: 1, what: "a fundamentals walk that names no audit page (export const page = \"<file>.md\")" });
    continue;
  }
  claimed.set(page, [...(claimed.get(page) ?? []), w]);
  if (!landed.has(page)) violations.push({ file: `e2e/${w}`, line: 1, what: `names ${page}, which the audit README does not link` });
}
for (const page of landed) {
  const by = claimed.get(page) ?? [];
  if (by.length === 0) violations.push({ file: README, line: 1, what: `${page} has landed but no e2e/fundamentals-*-walk.mjs names it: the nightly would never walk that area` });
  if (by.length > 1) violations.push({ file: README, line: 1, what: `${page} is named by ${by.length} walks (${by.join(", ")}): one area, one walk` });
}

if (violations.length) {
  console.error(`lint:fundamentals-walks - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("ship e2e/fundamentals-<area>-walk.mjs with the page (the contract is on #4115) and export const page = \"<your-page>.md\"");
  process.exit(1);
}
console.log(`lint:fundamentals-walks OK`);
