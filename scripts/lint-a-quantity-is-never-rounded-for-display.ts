#!/usr/bin/env tsx
// A quantity is shown as stored: no toFixed(0) or Math.round on a qty, quantity or count in a screen, because the rounded number sits beside a total made from the real one.
//
// THE BUG THIS PREVENTS. A purchase line of 1.5 at 4 read 2 x 4 beside a total of 6 (#7828, 2026-10-22).
//
// THE RULE. A name that says it is a quantity (qty, quantity, and their
// compounds: qtyBuilt, orderedQuantity) is not rounded where a person reads
// it: `<name>.toFixed(0)`, or Math.round(<name>) inside a `${...}` of a
// template. Everything else passes: formatQuantity, a decimals count above
// zero, a Math.round used for arithmetic and not for text. A genuine
// exception (a count that is a whole number by construction) opts out with
// `// ROUND-OK: <why>` on the line.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only names carrying qty or
// quantity count. A byte size, a percentage or a width in millimetres is
// rounded legitimately and is not named like one (BackupPage, PrintPage and
// the QR overlay all call toFixed(0) on such figures and stay clear).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-quantity-is-never-rounded-for-display.ts   (pnpm lint a-quantity-is-never-rounded-for-display)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

const QTY_NAME = String.raw`[A-Za-z_$][\w$]*(?:[Qq]ty|[Qq]uantity)[\w$]*|(?:qty|quantity)[\w$]*`;
const NAMED_TOFIXED = new RegExp(String.raw`\b(?:${QTY_NAME})(?:\??\.[\w$]+)*\s*\)?\s*\.toFixed\(\s*0\s*\)`);
const ROUNDED_IN_TEXT = new RegExp(String.raw`\$\{\s*Math\.round\(\s*[^)]*\b(?:${QTY_NAME})\b`);

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\/\/ ROUND-OK: \S/.test(line)) continue;
    if (NAMED_TOFIXED.test(line)) out.push({ file, line: i + 1, what: "a quantity rounded with toFixed(0) where it is read" });
    else if (ROUNDED_IN_TEXT.test(line)) out.push({ file, line: i + 1, what: "a quantity rounded with Math.round inside displayed text" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-quantity-is-never-rounded-for-display - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use formatQuantity from platform-web, which keeps up to three decimals.");
  process.exit(1);
}
console.log(`lint:a-quantity-is-never-rounded-for-display OK`);
