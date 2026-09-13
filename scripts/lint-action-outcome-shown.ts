#!/usr/bin/env tsx
// A surface that invokes an action through useInvokeEntityAction mounts
// ActionOutcome, so the action's own reason for not running is shown and
// kept, never a flash of ERR.
//
// THE BUG THIS PREVENTS. The item page's Print label chip flashed ERR for
// 2.4 seconds and reset. The reason it did not run was "labels:print: no
// label base URL is set ... set one under Configuration → Labels → QR
// codes", a sentence written for exactly that person, and it reached nobody:
// the hook had the words in its error handler and the surface rendered a
// three-letter state (#2847, 2026-09-13 staging review).
//
// THE RULE. Any .tsx file under web/src, packages/platform-web/src or a
// module's src/ui that calls `useInvokeEntityAction(` must also mount
// `<ActionOutcome` (the shared line that shows `note` and keeps `failure`
// until dismissed). The hook itself and its tests are skipped. A surface with
// a genuine reason to show the outcome another way says so on the line that
// calls the hook: `// ACTION-OUTCOME: <reason>`.
//
// PROVEN RED on RecordHeaderChips.tsx as shipped before #2847 (the hook
// called, only `flash` read, nothing mounted); green once <ActionOutcome>
// sat beside the chip.
//
//   npx tsx scripts/lint-action-outcome-shown.ts   (pnpm run lint:action-outcome-shown)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];
const HOOK = "useInvokeEntityAction(";
const MOUNT = "<ActionOutcome";
const SKIP = /(^|\/)(use-invoke-action\.ts|ActionOutcome\.tsx)$/;

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
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && (!dir.startsWith("modules") || /\/src\/ui(\/|$)/.test(p))) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (SKIP.test(file)) return [];
  const lines = src.split("\n");
  const hookLine = lines.findIndex((l) => l.includes(HOOK));
  if (hookLine === -1) return [];
  if (src.includes(MOUNT)) return [];
  if (/\/\/ ACTION-OUTCOME: \S/.test(lines[hookLine] ?? "")) return [];
  return [
    {
      file,
      line: hookLine + 1,
      what: `calls ${HOOK}) but never mounts ${MOUNT}>, so a failure is a flash of "err" and the action's own sentence is lost; render <ActionOutcome note failure onDismiss /> beside the control, or say why not: // ACTION-OUTCOME: <reason>`,
    },
  ];
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:action-outcome-shown - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:action-outcome-shown OK`);
