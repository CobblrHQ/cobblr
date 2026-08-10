// A write that establishes an IDENTITY must clear the identity it replaces.
//
// `suggested_metadata` carries the identify pass's derived attributes - category,
// entity_type, description, series, model, pack_size. When a later pass decides
// the item is a DIFFERENT product, those attributes belong to the rejected
// identification and are now wrong. `identityMeta()` exists to drop them
// (IDENTIFY_OWNED_KEYS) and overlay the new ones; plain `mergeMeta()` overlays
// without dropping.
//
// The photo cross-check used mergeMeta while renaming an item outright, so a
// monitor correctly renamed off its own label kept `category: "gas & flame
// detector"` from the gas detector it had been mistaken for - and the matchmaker
// then grouped it by that (reported 2026-08-10).
//
// The rule: setting `source` IS the identity marker. Any mergeMeta call whose
// object sets `source` must be identityMeta instead.
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

const files = sourceFiles("modules/**/src/**/*.ts");
const bad: string[] = [];

/** Strip comments before scanning. Without this the lint flagged mergeMeta's OWN
 *  doc-comment example — a lint matching its own prose, which is how a guardrail
 *  turns into noise and then gets disabled. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
          .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

for (const file of files) {
  const src = stripComments(readFileSync(file, "utf8"));
  // Walk each mergeMeta( call and read its balanced argument list.
  for (let i = src.indexOf("mergeMeta("); i !== -1; i = src.indexOf("mergeMeta(", i + 1)) {
    // identityMeta( ends with ...Meta( too - skip those.
    if (/[A-Za-z]/.test(src[i - 1] ?? "")) continue;
    let depth = 0;
    let end = i;
    for (let j = src.indexOf("(", i); j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    const call = src.slice(i, end + 1);
    // Passing IDENTIFY_OWNED_KEYS explicitly is exactly what identityMeta does,
    // so it is the same guarantee spelled out longhand — allow it.
    if (/\bsource\s*:/.test(call) && !/IDENTIFY_OWNED_KEYS/.test(call)) {
      const line = src.slice(0, i).split("\n").length;
      bad.push(`  ${file}:${line}  mergeMeta() sets \`source\` — use identityMeta() so the replaced identity's keys are dropped`);
    }
  }
}

if (bad.length) {
  console.error("✗ identity writes must drop the identity they replace:\n" + bad.join("\n"));
  console.error("\n  identityMeta(set, { keep: [...] }) drops IDENTIFY_OWNED_KEYS then overlays `set`.");
  process.exit(1);
}
console.log(`lint:identity-meta — no mergeMeta() call establishes an identity (${files.length} files).`);
