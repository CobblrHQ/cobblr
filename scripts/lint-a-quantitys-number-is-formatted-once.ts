#!/usr/bin/env tsx
// A quantity's number is formatted by quantityNumber in platform-contract, never by its own parseFloat(x.toFixed(3)), so 1.5 is 1.5 on every screen, export and sentence.
//
// THE BUG THIS PREVENTS. Twelve copies of the three-decimal rule sat across screens and the server, beside two copies of the unit formatter that had drifted: 3622.45 H read hours in the app and henries from the server (#7926, 2026-10-22).
//
// THE RULE. The text of a quantity's number comes from `quantityNumber`
// (packages/platform-contract/src/quantity-number.ts), which the unit formatter, the
// sentences and the screens all call. A line that builds it again with
// `parseFloat(<n>.toFixed(<digits>))` is a copy of the rule that can drift.
// quantity-number.ts is the one place (plural.ts, mirrored into the edge bridge, keeps its own copy until a repin folds it in). A genuine other use (a price, an angle, a
// measured coordinate, not a quantity) opts out with `// ROUND-OK: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only parseFloat around
// toFixed counts; a bare toFixed(2) for a price is not this rule. Twelve real
// copies of the three-decimal form sat in screens and the server before this
// lint, and were replaced by the call.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-quantitys-number-is-formatted-once.ts   (pnpm lint a-quantitys-number-is-formatted-once)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages", "api/src"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The files that could break the rule: git picks the few that hold a parseFloat around a toFixed, so the
 *  lint reads those and not the whole tree (a lint that reads everything grows into the CI job). */
function candidates(): string[] {
  const out = spawnSync("git", ["grep", "--untracked", "-l", "-E", "parseFloat\\(.*toFixed\\(", "--", ...ROOTS.flatMap((r) => [`:(glob)${r}/**/*.ts`, `:(glob)${r}/**/*.tsx`])], { encoding: "utf8", maxBuffer: 1 << 24 });
  return out.stdout.split("\n").filter((f) => f && !/\.test\.tsx?$/.test(f) && !isEmbeddedPayload(f));
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (file.endsWith("platform-contract/src/quantity-number.ts") || file.endsWith("platform-contract/src/plural.ts") || /\/\/ ROUND-OK: \S/.test(line)) continue;
    if (/parseFloat\(\s*[\w$.?()\[\]]+\.toFixed\(\s*\d+\s*\)\s*\)/.test(line)) out.push({ file, line: i + 1, what: "a number rounded for display with its own parseFloat(x.toFixed(n)); call quantityNumber" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const file of candidates()) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-quantitys-number-is-formatted-once - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Import quantityNumber from @cobblr/platform-contract/plural.");
  process.exit(1);
}
console.log(`lint:a-quantitys-number-is-formatted-once OK`);
