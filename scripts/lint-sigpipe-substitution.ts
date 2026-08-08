// A command substitution that pipes into an early-exiting consumer, inside a
// script that `set -o pipefail`, is a script that exits 141 having printed
// nothing.
//
// `head -20` closes the pipe on its 20th line. The producer then takes SIGPIPE
// and dies 141, `pipefail` promotes that to the pipeline's status, and `set -e`
// ends the script. The assignment has already happened, so there is no error
// message and no partial output — the script simply stops.
//
// The reason this needs a lint rather than care is that it is TIMING-dependent.
// A pipe holds ~64KB, so a producer whose entire output fits is finished before
// the consumer exits and nothing is ever signalled. The same line works for
// months and then fails the first time the input grows past the buffer.
//
// scripts/deploy-gap.sh had exactly this (2026-08-08): `git log … | head -20`,
// so it exited 141 and printed nothing whenever more than 20 unshipped commits
// existed — which is to say only ever when it had something to report. It is
// the gate the shipping-a-pr skill tells you to trust before saying a fix is
// live, and it had been failing open.
//
// Two ways to satisfy this:
//   1. Let the producer do its own limiting — `git log -n 20`, `sed -n 1p`,
//      `awk 'NR==1{print;exit}'`. No pipe, nothing to fail. Prefer this.
//   2. Append `|| true` when an empty result is a valid answer the script
//      already handles (reading the first line of a token file).
//
// Run: npx tsx scripts/lint-sigpipe-substitution.ts

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIRS = ["scripts", "deploy"];

/**
 * Consumers that close their input early, on purpose. The lookarounds keep `||`
 * out of it, so `[ -n "$head" ] || head="$(…)"` is not read as a pipe into
 * head(1).
 */
const EARLY_EXIT = /(?<!\|)\|(?!\|)\s*(head\b|grep\s+-[a-zA-Z]*q|grep\s+-[a-zA-Z]*m\s*\d)/;

const failures: string[] = [];
let checked = 0;

const shFiles = DIRS.filter((d) => existsSync(d)).flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".sh"))
    .map((f) => join(d, f)),
);

for (const file of shFiles) {
  const src = readFileSync(file, "utf8");
  if (!/set\s+-[a-zA-Z]*o\s+pipefail|set\s+-o\s+pipefail/.test(src)) continue;
  checked++;

  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("#")) continue;
    // Only inside a command substitution: a bare pipeline's 141 is visible in
    // the exit status and usually intended.
    //
    // `\$(` is escaped, so THIS shell never evaluates it — it is a hint being
    // printed for a human to paste, or a payload handed to a remote shell over
    // ssh. Either way the substitution runs somewhere that does not inherit
    // this script's pipefail, so the trap does not apply.
    if (!/(?<!\\)\$\(/.test(line)) continue;
    if (!EARLY_EXIT.test(line)) continue;
    // Already guarded.
    if (/\|\|\s*true/.test(line)) continue;

    failures.push(
      `${file}:${i + 1}: \`${line.trim().slice(0, 90)}\`\n` +
        `      pipes into an early-exiting consumer inside \`$(...)\` while pipefail is on. ` +
        `When the producer outputs more than the pipe buffer holds it takes SIGPIPE and the ` +
        `script exits 141 with no output. Limit in the producer (\`git log -n 20\`, ` +
        `\`sed -n 1p\`) or append \`|| true\`.`,
    );
  }
}

if (failures.length) {
  console.error("✗ lint-sigpipe-substitution: a script can exit 141 with no output:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ sigpipe-substitution lint: ${checked} pipefail script(s) clean`);
process.exit(0);
