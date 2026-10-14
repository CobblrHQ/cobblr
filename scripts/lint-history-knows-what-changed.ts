#!/usr/bin/env tsx
// Every activity log of an update (action ending _updated) passes the record's before row, so history can say what each field was and is.
//
// THE BUG THIS PREVENTS. A record's History said "<name> updated" and nothing
// else for every custom-field edit, and "purchase price cents → 430000" for
// the rest: every update writer logged its patch (new values only), so the
// log could never say what a field had been, nor which custom fields an edit
// touched (#4517).
//
// THE RULE. An `activity.log({ ... })` whose action is a string ending in
// `_updated` passes `before:` (the row as it was). The log then stores the
// fields that really changed, old → new, custom fields included
// (platform-contract activity-changes). A write that genuinely has no
// before-image says `history-before-ok: <why>` inside the call.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only update actions: a
// create has nothing before it and a delete keeps its own snapshot. An
// action named by a variable is not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-history-knows-what-changed.ts   (pnpm lint history-knows-what-changed)
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
  for (const m of src.matchAll(/activity\.log\(\s*\{/g)) {
    const start = m.index ?? 0;
    let depth = 0;
    let end = src.length;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const call = src.slice(start, end);
    // The action as a string, or as a variable set just above to one.
    const named = /action:\s*["'`][\w.-]*_updated["'`]/.test(call);
    const viaVariable = /\baction\s*[,}]/.test(call) && /const action\s*=[^;]*_updated["'`]/.test(src.slice(Math.max(0, start - 400), start));
    if (!named && !viaVariable) continue;
    if (/\bbefore\s*[:,}]/.test(call) || /history-before-ok:\s*\S/.test(call)) continue;
    out.push({ file, line: src.slice(0, start).split("\n").length, what: "an update logged without `before`: history cannot say what changed" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:history-knows-what-changed - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:history-knows-what-changed OK`);
