// "Is it due yet?" answered in UTC.
//
// `new Date().toISOString().slice(0, 10)` is the UTC calendar day. Anywhere west
// of Greenwich that runs AHEAD of the local day for part of every evening, so
// comparing a stored `YYYY-MM-DD` against it fires a day early: an order due the
// 25th was announced as "was due today. Did it turn up?" at 8pm on the 24th,
// from two different sweepers with the same line in them (reported 2026-08-24).
//
// The rule is narrow on purpose. Formatting a date VALUE back to a string is
// fine, and so is stamping a filename with today - neither asks "has this day
// arrived for a person". What is banned is slicing the CURRENT time and then
// COMPARING it, because that comparison is always a scheduling decision.
//
// Use `arrivedEverywhere(now)` from @cobblr/platform-contract: a date has
// arrived when it has arrived in the last zone on earth, so it can never be
// early for anybody.
//
// Run: npx tsx scripts/lint-utc-day-comparison.ts

import { readFileSync, globSync } from "node:fs";

const ROOTS = ["api/src/**/*.ts", "modules/**/src/**/*.ts", "packages/*/src/**/*.ts"];

/** The current instant, sliced to a UTC day. */
const NOW_SLICE = /(?:new Date\(\)|\b(?:now|today|at)\b)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/;
/** ...used in a comparison, which is what makes it a decision rather than a
 *  formatting. An ARROW is not a comparison: `() => new Date()...` tripped this
 *  on a filename stamp the first time it ran, which is exactly the noise a
 *  narrow rule is supposed to avoid. */
const COMPARISON = /(?:<=|>=|===|!==|(?<![=<>|-])[<>](?!=))/;
const withoutArrows = (line: string) => line.replace(/=>/g, "  ");

const failures: Array<{ file: string; line: number; text: string }> = [];

for (const pattern of ROOTS) {
  for (const file of globSync(pattern)) {
    if (/\.(test|spec)\.ts$/.test(file) || file.includes("/dist/") || file.includes("node_modules")) continue;
    const src = readFileSync(file, "utf8");
    // The helper itself, and the kernel's localDay fallback, are the sanctioned
    // implementations of this and say so.
    if (src.includes("SANCTIONED-UTC-DAY")) continue;
    src.split("\n").forEach((line, i) => {
      if (!NOW_SLICE.test(line)) return;
      // Compared anywhere on the line, either side of the slice - or DEFAULTED
      // into a value (`args.day ?? <today>`): a fallback stamp decides which
      // calendar day an event happened on, and "Yes, it turned up" pressed at
      // 8pm US Eastern recorded TOMORROW (2026-08-25 audit). Formatting that
      // is neither compared nor defaulted stays legal.
      const decided = COMPARISON.test(withoutArrows(line)) || /\?\?\s*new Date\(\)/.test(line);
      if (!decided) return;
      failures.push({ file, line: i + 1, text: line.trim().slice(0, 110) });
    });
  }
}

if (failures.length) {
  console.error("✗ lint-utc-day-comparison: a scheduling decision made in the UTC day:\n");
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`      ${f.text}`);
  }
  console.error(
    "\n  The UTC day runs ahead of the local one every evening west of Greenwich, so\n" +
      "  this fires a day early. Use arrivedEverywhere(now) from @cobblr/platform-contract,\n" +
      "  which treats a date as arrived only once it has arrived in the last zone on earth.\n" +
      "  Formatting a date value, or stamping a filename, is fine and is not flagged.\n" +
      "  A deliberate exception says so with a // SANCTIONED-UTC-DAY comment and a reason.",
  );
  process.exit(1);
}

console.log("✓ utc-day lint: no scheduling decision is made in the UTC calendar day.");
