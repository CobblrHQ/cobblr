#!/usr/bin/env tsx
// No product code draws a native radio input; a pick-one of a few options is the shared SegmentedChoice (rectangular buttons, the selected one filled).
//
// THE BUG THIS PREVENTS. The owner disliked radio buttons as outdated (2026-10-06); twenty had accumulated across screens, each a different shape.
//
// THE RULE. A source file under the roots must not draw `type="radio"` (or
// `type: "radio"`, or `type={"radio"}`): a pick-one of a few options is the
// shared SegmentedChoice (packages/platform-web/src/SegmentedChoice.tsx). The
// segmented buttons it draws are role="radio" BUTTONS, which this rule does not
// touch. Past about five options the control is a <select>. A genuine exception
// (a native input a third-party form needs) opts out with
// `// ALLOW-RADIO: <reason>` on the line or the one above it.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Test files are not product
// code and are skipped; scripts/museum is outside the roots on purpose. Nothing
// else has needed an exception yet.
//
// PROVE IT RED before you trust it green: run against main it names the twenty
// radios this replaced (the owner, 2026-10-06).
//
//   npx tsx scripts/lint-no-radio-inputs.ts   (pnpm lint no-radio-inputs)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages", "bundles"];

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
    const line = lines[i] ?? "";
    if (/\btype\s*(=\s*\{?\s*|:\s*)["']radio["']/.test(line)) {
      const note = `${lines[i - 1] ?? ""}\n${line}`;
      if (/ALLOW-RADIO: \S/.test(note)) continue;
      out.push({ file, line: i + 1, what: 'a native radio input: use SegmentedChoice (rectangular buttons), or a select past about five options' });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-radio-inputs - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use SegmentedChoice from @cobblr/platform-web (more than about five options: a select).");
  process.exit(1);
}
console.log(`lint:no-radio-inputs OK`);
