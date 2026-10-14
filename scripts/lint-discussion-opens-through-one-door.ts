#!/usr/bin/env tsx
// Discussion is opened only through openDiscussion({ record }), so every door says which record it is about.
//
// THE BUG THIS PREVENTS. A record's Discuss button opened the side panel's
// Discussion tab with `openRail("discussion")` and said nothing about the
// record. The tab worked it out from the URL, and most record views are
// modals that leave the URL alone, so Discuss on a bike opened the
// workspace-wide room with no sign of the bike (2026-10-01).
//
// THE RULE. Opening the Discussion tab goes through `openDiscussion({ record })`
// (packages/platform-web/src/open-discussion.ts), where `record` is required:
// the record, or null when the caller genuinely has none. Refused anywhere
// else: `openRail("discussion")`, and a hand-built `cobblr:open-rail` event
// whose tab is "discussion". No opt-out: a door with no record says
// `{ record: null }`, which is the opt-out, typed.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Other tabs (Cobb, Pinned)
// still open through openRail: only Discussion is about a record. The
// rail's own tab registration (`id: "discussion"`) is not an opening and is
// not matched, because the patterns need the opening call or the event.
//
//   npx tsx scripts/lint-discussion-opens-through-one-door.ts   (pnpm lint discussion-opens-through-one-door)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];
const DOOR = "packages/platform-web/src/open-discussion.ts";

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
  if (file === DOOR) return out;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/openRail\(\s*["'`]discussion["'`]\s*\)/.test(line)) {
      out.push({ file, line: i + 1, what: 'openRail("discussion") opens Discussion without saying which record: use openDiscussion({ record })' });
    }
    if (/cobblr:open-rail/.test(line) && /tab:\s*["'`]discussion["'`]/.test(lines.slice(i, i + 3).join(" "))) {
      out.push({ file, line: i + 1, what: "a hand-built cobblr:open-rail event for Discussion: use openDiscussion({ record })" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:discussion-opens-through-one-door - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:discussion-opens-through-one-door OK`);
