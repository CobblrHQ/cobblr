#!/usr/bin/env tsx
// A deferred, later or follow-up section in a module doc links docs/BACKLOG.md, and BACKLOG names that doc, so a deferral has one owner and a shipped one is noticed.
//
// THE BUG THIS PREVENTS. module docs listed NFC, streaming chat, the MCP server and receipt scanning as deferred long after they shipped (2026-10-14)
//
// THE RULE. In docs/modules/*.md and docs/design-decisions/*.md, a section whose heading says it holds
// what is not built yet (deferred, defers, later, not yet, not done,
// follow-ups, future tasks) carries a link to docs/BACKLOG.md somewhere in its body, and
// BACKLOG.md names that doc (its path under docs/, like `modules/labels.md`).
// The BACKLOG entry is where each item's one-line why lives, and where an item
// is struck when it ships. A heading that says SHIPPED (a list kept as the
// record of what landed) is not a deferral and passes.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A version number alone is
// not a deferral: "3.1 Direct CSV upload (v0.1, built in)" and "Open
// questions for v0.1" matched a bare v0.x and were wrong. "Explicitly out of scope"
// (operator-impersonation's stealth mode) is a decision not to build, not a
// deferral, so out-of-scope headings are not judged. Some headings only use
// the words ("Why the indirection now, not later", "In-app is never
// deferred"); such a section opts out with `<!-- not-a-deferral: <why> -->`
// as the first line under its heading, the reason required.
//
//   npx tsx scripts/lint-deferred-names-backlog.ts   (pnpm lint deferred-names-backlog)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["docs/modules", "docs/design-decisions"];
const OPT_OUT = /^<!-- not-a-deferral: \S.*-->$/;
const BACKLOG = "docs/BACKLOG.md";
const DEFERRED_HEADING = /^(#{2,6})\s+(.*(?:deferr|\bdefers\b|\blater\b|not yet|not done|follow-?ups?|future tasks).*)$/i;

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.md$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string, backlog: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const named = file.replace(/^docs\//, "");
  for (let i = 0; i < lines.length; i++) {
    const m = DEFERRED_HEADING.exec(lines[i] ?? "");
    if (!m || /shipped/i.test(m[2] ?? "")) continue;
    const next = lines.slice(i + 1).find((l) => l.trim() !== "") ?? "";
    if (OPT_OUT.test(next.trim())) continue;
    const level = m[1]!.length;
    let end = i + 1;
    while (end < lines.length && !(/^(#{1,6})\s/.test(lines[end] ?? "") && /^(#{1,6})/.exec(lines[end]!)![1]!.length <= level)) end++;
    const body = lines.slice(i + 1, end).join("\n");
    if (!/BACKLOG\.md/.test(body)) out.push({ file, line: i + 1, what: `"${m[2]}" lists what is not built yet but does not link docs/BACKLOG.md` });
    else if (!backlog.includes(named)) out.push({ file, line: i + 1, what: `"${m[2]}" links BACKLOG.md, but BACKLOG.md never names ${named}` });
    i = end - 1;
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
const backlog = readFileSync(BACKLOG, "utf8");
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file) || onlyChanged(BACKLOG)) violations.push(...check(file, readFileSync(file, "utf8"), backlog));

if (violations.length) {
  console.error(`lint:deferred-names-backlog - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Add a BACKLOG.md entry naming the doc, with each still-deferred item and its why, and link it from the section; move anything that shipped into the doc's main text.");
  process.exit(1);
}
console.log(`lint:deferred-names-backlog OK`);
