#!/usr/bin/env tsx
// A web surface runs an action only through platform-web's runAction / useRunAction / useInvokeEntityAction, never api.invokeAction itself, so the action's completion refreshes every query showing the record's kind.
//
// THE BUG THIS PREVENTS. Groceries What's on hand persisted Use / restock but the card kept x1 / in stock until a reload: the vending renderer refreshed the two keys it knew and the embedded page read through a third (#2969, 2026-09-14).
//
// THE RULE. In web/src, packages/platform-web/src and every module's src/ui,
// the text `invokeAction(` may appear only where the door is built:
// platform-web's run-action.ts (the door), the web api client that defines
// the request (web/src/lib/api.ts), and the App.tsx line that hands that
// client to platform-web's context. Everything else calls useRunAction(),
// runAction(...) or useInvokeEntityAction(...). Tests are not judged (a test
// mocks invokeAction to build its api). A genuine exception opts out with
// `// ONE-DOOR: <why>` on the same line.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-actions-run-through-one-door.ts   (pnpm run lint:actions-run-through-one-door)
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

const ALLOWED = new Set([
  "packages/platform-web/src/run-action.ts",
  // The api's own type and the request that defines it are not callers.
  "packages/platform-web/src/types.ts",
  "web/src/lib/api.ts",
  "web/src/App.tsx",
]);

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (ALLOWED.has(file)) return [];
  if (!/\/src\/ui\/|^web\/src\/|^packages\/platform-web\/src\//.test(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\binvokeAction\s*\(/.test(line)) continue;
    if (/ONE-DOOR:/.test(line)) continue;
    out.push({ file, line: i + 1, what: "calls invokeAction itself; run the action through useRunAction / runAction / useInvokeEntityAction" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:actions-run-through-one-door - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Call useRunAction() (or runAction(api, qc, slug, body) where no hook fits) instead of api.invokeAction; the door refreshes what the action touched.");
  process.exit(1);
}
console.log(`lint:actions-run-through-one-door OK`);
