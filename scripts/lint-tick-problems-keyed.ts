#!/usr/bin/env tsx
// Every problem the CI box health tick raises carries the identity of its
// check as `key|text`, so a text whose detail moves is one condition updated,
// never a false green.
//
// THE BUG THIS PREVENTS. On 2026-09-20 (#3224) the leftovers check found five
// undeclared files and the tick posted 🔴 naming them; a widened match found
// nine; the alert library, keyed on the rendered text, opened a second
// condition for the nine and posted 🟢 "cleared" for the five, all of which
// were still on the box. A false green is the most expensive alert there is:
// it is the one people act on by doing nothing. The library now keys a
// condition by an identity when it is given one; this makes sure the tick
// always gives one.
//
// THE RULE. In scripts/ci-runner-health.sh every `problems+=("...")` literal
// starts with `<key>|`: the key is a lowercase word for the check (dns, disk,
// core-checkout), optionally `:` and a per-instance part that may be a shell
// variable (runner:$c, job-image:$img), or a variable that carries a key
// read from a helper's `🔴 [key]` line ($_k). A text that starts anywhere
// else (a capital, a `$` that is not a key variable, a sentence) fails. No
// opt-out: a condition without an identity is a condition keyed by its
// prose, which is the defect.
//
// PROVEN RED 2026-09-20 against the tick before its entries were keyed (14
// violations), then green once they were.
//
//   npx tsx scripts/lint-tick-problems-keyed.ts   (pnpm run lint tick-problems-keyed)
import { readFileSync } from "node:fs";

const FILE = "scripts/ci-runner-health.sh";
const KEYED = /^problems\+=\("(?:[a-z][a-z0-9-]*(?::[A-Za-z0-9_${}.:-]+)?|\$_k)\|/;

interface Violation {
  file: string;
  line: number;
  what: string;
}
const violations: Violation[] = [];
const lines = readFileSync(FILE, "utf8").split("\n");
let seen = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i] ?? "";
  const m = line.match(/problems\+=\("/);
  if (!m) continue;
  seen++;
  const from = line.slice(m.index ?? 0);
  if (!KEYED.test(from)) {
    violations.push({ file: FILE, line: i + 1, what: `problems+= without a \`key|\` identity: ${from.slice(0, 70)}` });
  }
}
if (seen === 0) {
  violations.push({ file: FILE, line: 1, what: "no problems+= found at all; the tick moved and this lint reads nothing" });
}

if (violations.length) {
  console.error(`lint:tick-problems-keyed - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Every problem is \"key|text\": the key is the check's identity (dns, disk, runner:$c), so a changing text is one condition updated and never a false 🟢 cleared (#3224).");
  process.exit(1);
}
console.log(`lint:tick-problems-keyed OK: ${seen} problem(s) in ${FILE} carry an identity`);
