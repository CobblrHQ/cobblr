#!/usr/bin/env tsx
// A web surface that runs an action through the bare door (useRunAction or runAction) says on that line why its press carries every argument the action requires, and no press passes argsSchema null, so no button fires a call the door refuses.
//
// THE BUG THIS PREVENTS. LOG SERVICE failed on every record for ten days: the door refused calls missing a required argument and no button asked for it (#3865, 2026-09-28).
//
// THE RULE. The record surfaces run actions through useInvokeEntityAction,
// whose RunArgs.argsSchema is a required field: the type makes every button
// say what its action takes, and the hook asks for a required argument the
// press does not carry (askBeforePress). Two ways around that are left, and
// this closes both:
//   1. A call to useRunAction() or runAction(...) outside the door's own
//      files runs an action with no ask at all. It passes only with
//      `// PRESS-ARGS: <why>` on the same line or the line above, saying why
//      the press always carries what the action requires (the inventory
//      tap fixes its one argument), or pointing at the ask it does itself.
//   2. `argsSchema: null` / `argsSchema: undefined` written as a literal
//      satisfies the type and asks nothing. It never passes.
// Tests are not judged.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. run-action.ts builds the
// door and use-invoke-action.ts is the asking wrapper around it; both call
// runAction by construction and are skipped by path. A value passed through
// (`argsSchema: action.args_schema`, which may be null at runtime) is not a
// literal and passes: null there means the action declared no arguments.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-action-press-asks-first.ts   (pnpm lint action-press-asks-first)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

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

const DOOR_FILES = /packages\/platform-web\/src\/(run-action|use-invoke-action)\.ts$/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (DOOR_FILES.test(file)) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || /^\s*import\b/.test(line)) continue;
    const marked = /\/\/ PRESS-ARGS: \S/.test(line) || /\/\/ PRESS-ARGS: \S/.test(lines[i - 1] ?? "");
    if (/\buseRunAction\(\s*\)|\brunAction\(\s*api\b/.test(line) && !marked) {
      out.push({ file, line: i + 1, what: "runs an action through the bare door with no ask; say why the press carries every required argument (// PRESS-ARGS: <why>) or use useInvokeEntityAction" });
    }
    if (/\bargsSchema:\s*(null|undefined)\b/.test(line)) {
      out.push({ file, line: i + 1, what: "argsSchema written as a literal null asks nothing; pass the action's args_schema" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:action-press-asks-first - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:action-press-asks-first OK`);
