#!/usr/bin/env tsx
// A price each is formatted by formatUnitPrice, never by formatStoredMoney, so a sub-cent unit price keeps the digits that explain its line total.
//
// THE BUG THIS PREVENTS. A bottled-water style sub-cent price read $0.00 beside a $0.80 total (#8137); three more unit-price cells still used the 2-decimal formatter (#7926).
//
// THE RULE. A value named like a price each (unit_price, unitPrice, unit_cost,
// unitCost, price_each) is formatted by `formatUnitPrice`
// (packages/platform-contract/src/money.ts), which keeps the digits a sub-cent
// price was stored with. Passing one to `formatStoredMoney(...)` rounds it to the
// currency's two decimals, so 1,000 at $0.0008 reads "$0.00" beside "$0.80". A
// genuine other use opts out with `// UNIT-PRICE-OK: <why>` on the line.
//
// THE BOUNDARY. Only a call whose first argument names a unit price counts.
// A line total, a subtotal or a balance goes through formatStoredMoney, and the
// name is what separates them: this lint does not guess from a bare variable.
// money.ts (which defines both) and test files are not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-unit-price-keeps-its-digits.ts   (pnpm lint a-unit-price-keeps-its-digits)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The files that could break the rule: git picks the few that name a unit price near formatStoredMoney, so the
 *  lint reads those and not the whole tree (a lint that reads everything grows into the CI job). */
function candidates(): string[] {
  const out = spawnSync("git", ["grep", "--untracked", "-l", "-E", "formatStoredMoney\\(", "--", ...ROOTS.flatMap((r) => [`:(glob)${r}/**/*.ts`, `:(glob)${r}/**/*.tsx`])], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.stdout.split("\n").filter((f) => f && !/\.test\.tsx?$/.test(f) && !isEmbeddedPayload(f));
}

const UNIT_PRICE_FORMATTED_AS_MONEY = /formatStoredMoney\(\s*[^,)]*\b(?:unit_?price|unit_?cost|price_?each)\b/i;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (file.endsWith("platform-contract/src/money.ts") || /\/\/ UNIT-PRICE-OK: \S/.test(line)) continue;
    if (UNIT_PRICE_FORMATTED_AS_MONEY.test(line)) out.push({ file, line: i + 1, what: "a price each rounded to the currency's decimals by formatStoredMoney; call formatUnitPrice" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const file of candidates()) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-unit-price-keeps-its-digits - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Import formatUnitPrice from @cobblr/platform-contract/money.");
  process.exit(1);
}
console.log(`lint:a-unit-price-keeps-its-digits OK`);
