#!/usr/bin/env tsx
// Code that invokes an action reads its answer: an action that says no has not happened, and throwing its answer away reports it as done.
//
// THE BUG THIS PREVENTS. a stale Approve on a request already declined came back as done, 200 in the app and a tick in Discord, because the notification press never read the handler's no (#3594); an import counted refused creates as imported
//
// THE RULE. A statement that is only `await platform().actions.invoke(...)`
// (or `void platform().actions.invoke(...)`) throws the answer away. An action
// answers `{ ok: false, error }` to say no WITHOUT throwing, so the caller
// carries on as though it happened (@cobblr/platform-contract/action-result
// is the one reading: only `ok: true` acted). Keep the answer and read it with
// actionActed(). A call whose answer genuinely does not matter says why on the
// line above: `// ACTION-ANSWER-IGNORED: <why>`.
//
//   npx tsx scripts/lint-action-answer-read.ts   (pnpm lint action-answer-read)
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

const DISCARDED = /^\s*(await|void)\s+platform\(\)\.actions\.invoke\(/;
const REASON = /ACTION-ANSWER-IGNORED:\s*\S/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!DISCARDED.test(line)) continue;
    if (REASON.test(lines[i - 1] ?? "") || REASON.test(line)) continue;
    out.push({ file, line: i + 1, what: "an action's answer is thrown away; a no reads as done" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:action-answer-read - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("const r = await platform().actions.invoke(...); if (!actionActed(r)) ... (@cobblr/platform-contract/action-result)");
  process.exit(1);
}
console.log(`lint:action-answer-read OK`);
