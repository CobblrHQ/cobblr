// Guard: only the shared parser may decide what a `/qr/<token>` payload means.
//
// This bug shipped and stayed invisible for over a week. Three files each
// hand-rolled the match; two used `[A-Za-z0-9_-]{16,}`, written when tokens were
// randomBytes(18) = 24 chars. #919 shortened them to randomBytes(9) = 12 chars
// on 2026-07-11, and both copies stopped matching that day. Scanning a Cobblr
// label with the camera OR a hardware scanner staged a junk "no catalog match"
// inbox row instead of opening the thing, for every label printed since. Labels
// printed earlier kept working, so it read as "this used to work."
//
// Nothing caught it: each regex is valid, every test passed, and the failure was
// a silent fallthrough rather than an error. A duplicated constant is the whole
// bug class, so the rule is that there is exactly one implementation.
// Run: npx tsx scripts/lint-qr-token-parser.ts

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const CANONICAL = "packages/platform-contract/src/qr-token.ts";
const TEST = "packages/platform-contract/tests/qr-token.test.ts";

// A regex literal that reaches into a /qr/ path and captures something.
const HAND_ROLLED = /\/\\?\/qr\\?\/\(|qr\\\/\(\[|\\\/qr\\\/\(/;

const files = [
  ...globSync("web/src/**/*.{ts,tsx}"),
  ...globSync("api/src/**/*.ts"),
  ...globSync("modules/*/src/**/*.{ts,tsx}"),
  ...globSync("packages/*/src/**/*.{ts,tsx}"),
].filter((f) => f !== CANONICAL && f !== TEST);

const offenders: Array<{ file: string; line: number; text: string }> = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
    if (HAND_ROLLED.test(line)) offenders.push({ file, line: i + 1, text: line.trim().slice(0, 100) });
  });
}

if (offenders.length > 0) {
  console.error(`qr-token-parser lint: a /qr/ payload is parsed outside ${CANONICAL}.\n`);
  for (const o of offenders) console.error(`    ❌ ${o.file}:${o.line}\n       ${o.text}`);
  console.error(
    `\n  Import the shared parser instead:` +
      `\n    import { qrTokenFromUrl } from "@cobblr/platform-contract/qr-token";   // camera + wedge (full URL)` +
      `\n    import { qrTokenFromScan } from "@cobblr/platform-contract";           // bridge intake (lenient)` +
      `\n\n  A second copy is how the 16-char floor outlived the 12-char token and` +
      `\n  killed QR routing on both local scan paths for a week.`,
  );
  process.exit(1);
}

// The canonical file must not reintroduce a length assumption on the URL form.
// Checked across the whole file, not just inside the function: the pattern is
// assembled from a module-level SEGMENT const, so a floor added there would sit
// outside any single function body (an earlier version of this check missed
// exactly that and passed while the floor was live).
//
// `t.length >= 6` in the LENIENT path is deliberate and stays: a bare token with
// no URL around it needs some floor to not swallow every short string. Only the
// regex quantifier form is banned.
const canon = readFileSync(CANONICAL, "utf8");
const codeLines = canon
  .split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
const floor = codeLines.find((l) => /\{\s*\d+\s*,\s*\}/.test(l));
if (floor) {
  console.error(`qr-token-parser lint: a {n,} length floor is back in ${CANONICAL}:`);
  console.error(`    ❌ ${floor.trim().slice(0, 100)}`);
  console.error(`\n  The /qr/ path is already conclusive evidence of a Cobblr label. Every`);
  console.error(`  length assumption here has been wrong at least once: this exact floor`);
  console.error(`  was 16 while tokens were 24 chars, then #919 made them 12 and four`);
  console.error(`  scan surfaces went quietly dead.`);
  process.exit(1);
}

console.log(`qr-token-parser lint: ${files.length} files, one parser ✓`);
