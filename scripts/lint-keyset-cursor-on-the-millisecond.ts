#!/usr/bin/env tsx
// A page cursor is built by encodeKeysetCursor, and a file that builds one orders and compares on the millisecond; a since-cursor never passes through a Date.
//
// THE BUG THIS PREVENTS. 2026-09-30: /me/activity, walked page by page, came
// up one entry short of its own total (54 of 55) and main went red. Postgres
// keeps a timestamp to the microsecond, the cursor (a JavaScript Date) to the
// millisecond, and a query comparing the raw column with the cursor skips
// every row inside the last row's millisecond but below its microsecond. Four
// lists did it (activity, files, the scan inbox, print jobs); the
// notification lists had already been fixed the right way, one at a time.
//
// And 2026-10-05 (#4916): the scan feed's FORWARD cursor ("what changed
// since") went through a Date, sat just below a row stamped by now(), and
// handed the same scan back on every poll; a watch would replay it for ever.
// The millisecond is the wrong fix there (a later row in the same millisecond
// is the one it would skip), so a since-cursor is kept at the microsecond,
// built in SQL by sinceCursorSql.
//
// THE RULE, three halves:
//   1. No cursor is built by hand from toISOString(): `${…toISOString()}|${…}`
//      fails. encodeKeysetCursor (@cobblr/platform-contract/keyset-cursor)
//      is the one encoder.
//   2. A file that reads a cursor with decodeKeysetCursor orders and compares
//      on `date_trunc('milliseconds', <column>)`, the precision the cursor
//      carries, with the id breaking a tie.
//   3. A cursor is never a JavaScript Date: a response field named cursor,
//      next_cursor, next_before or next_after built with toISOString() or
//      new Date(, and a SQL comparison against `${new Date(after|before|
//      since|cursor …)}`, both fail. A page cursor is encodeKeysetCursor; a
//      since-cursor is sinceCursorSql + latestSinceCursor, compared as
//      `> ${after}::timestamptz`.
//
// THE BOUNDARY. Half 2 reads the DECODING file, not the encoding one: the
// notification routes encode a cursor that lib code in another file reads,
// and that file is where the comparison lives. A list keyed on something
// other than time (inventory's name and id) never touches either helper.
//
// PROVE IT RED: on main before this change, half 1 names the four
// hand-built cursors (me.ts twice, orgs.ts, core-files). Half 3, on main at
// 700589ae2, names the scan feed twice (its compare and its cursor). A
// cut-off computed from the clock (deleted-records' thirty days) is a window,
// not a cursor, and is not judged.
//
//   npx tsx scripts/lint-keyset-cursor-on-the-millisecond.ts   (pnpm lint keyset-cursor-on-the-millisecond)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const BASE = process.env.COBBLR_LINT_ROOT?.trim() || ".";
const ROOTS = ["api/src", "modules"].map((r) => join(BASE, r));

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
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/toISOString\(\)\}\|\$\{/.test(lines[i] ?? "")) {
      out.push({ file, line: i + 1, what: "a page cursor built by hand from toISOString(): use encodeKeysetCursor" });
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\b(cursor|next_cursor|next_before|next_after|nextCursor)\s*:\s*[^,}]*(toISOString\(\)|new Date\()/.test(line)) {
      out.push({ file, line: i + 1, what: "a cursor built from a JavaScript Date: use encodeKeysetCursor (a page) or sinceCursorSql + latestSinceCursor (since)" });
    }
    if (/[<>]=?\s*\$\{new Date\(\s*(after|before|since|cursor|c\.at|req\.)/.test(line)) {
      out.push({ file, line: i + 1, what: "a cursor compared as a JavaScript Date: compare `> ${after}::timestamptz` against a since-cursor" });
    }
  }
  const decodes = lines.findIndex((l) => /\bdecodeKeysetCursor\(/.test(l));
  if (decodes >= 0 && !src.includes("date_trunc('milliseconds'")) {
    out.push({ file, line: decodes + 1, what: "reads a keyset cursor but never orders or compares on date_trunc('milliseconds', …)" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:keyset-cursor-on-the-millisecond - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("encodeKeysetCursor/decodeKeysetCursor from @cobblr/platform-contract/keyset-cursor, and order + compare on date_trunc('milliseconds', <col>), id");
  process.exit(1);
}
console.log(`lint:keyset-cursor-on-the-millisecond OK`);
