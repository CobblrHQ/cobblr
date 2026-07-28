// Guard: only the shared predicate may decide what a `cobblr-edge://` URL means.
//
// The scheme is a ROUTING decision — it says a printer or machine is reached
// through an on-site bridge rather than a direct address — and it had quietly
// grown five copies: core-print twice (edge.ts and drivers/registry.ts), digifab
// twice, and the print page. Each was the same regex written again because the
// caller sat behind a module boundary and importing across it felt heavier than
// retyping four tokens.
//
// The cost shows up when the answer has to change or a new caller appears. The
// Labels toolbar needed to ask the same question to say "via edge bridge"
// instead of "Network" for a bridged printer, and the honest options were a
// sixth copy or one shared predicate. Five copies also means five places for the
// scheme to drift, in code that decides whether a job goes to the LAN.
//
// Run: npx tsx scripts/lint-edge-url-predicate.ts

import { readFileSync, globSync } from "node:fs";

const CANONICAL = "packages/platform-contract/src/edge-bridge-client.ts";

// Only CLASSIFYING or PARSING the scheme counts. Naming it in help text, in a
// comment, or building a URL from it are all fine and common, so matching the
// bare string produced six false positives and zero real ones — a lint that
// cries wolf gets suppressed, which is worse than not having it.
const HAND_ROLLED = [
  /\/\^?cobblr-edge:/, // a regex literal against the scheme
  /\.(?:startsWith|includes|indexOf)\(\s*["'`]cobblr-edge:/,
];

const files = [
  ...globSync("web/src/**/*.{ts,tsx}"),
  ...globSync("api/src/**/*.ts"),
  ...globSync("modules/*/src/**/*.{ts,tsx}"),
  ...globSync("packages/*/src/**/*.{ts,tsx}"),
].filter((f) => !f.endsWith(CANONICAL) && !f.includes(".test."));

const offenders: Array<{ file: string; line: number; text: string }> = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const t = line.trim();
    // Comments and doc blocks may name the scheme; only code is the problem.
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    // Building a URL is not the same as classifying one: writing
    // `cobblr-edge://${instance}` is exactly what the connect flow should do.
    if (/`cobblr-edge:\/\/\$\{/.test(t) || /"cobblr-edge:\/\/"\s*\+/.test(t)) return;
    if (HAND_ROLLED.some((re) => re.test(t))) offenders.push({ file, line: i + 1, text: t.slice(0, 100) });
  });
}

if (offenders.length > 0) {
  console.error(`edge-url-predicate lint: a cobblr-edge:// URL is classified outside ${CANONICAL}.\n`);
  for (const o of offenders) console.error(`    ❌ ${o.file}:${o.line}\n       ${o.text}`);
  console.error(
    `\n  Import the shared predicate instead:` +
      `\n    import { isEdgeManagerUrl } from "@cobblr/platform-contract/edge-bridge-client";` +
      `\n\n  Constructing a URL is fine; deciding what one MEANS belongs in one place.`,
  );
  process.exit(1);
}

console.log(`edge-url-predicate lint: ${files.length} files, one predicate ✓`);
