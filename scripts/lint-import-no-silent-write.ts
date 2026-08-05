#!/usr/bin/env tsx
// An importer may not swallow a write.
//
// homebox-import.ts did `.catch(() => undefined)` around a tag attach. Items
// import concurrently, so two rows racing to create the same tag is routine and
// the loser gets a non-2xx — which the catch ate. The import then reported
// `items_imported: 2, items_failed: 0` while the tags were simply gone (the CI
// failure that surfaced it was the drill coming back tagged ['power'] instead
// of ['tools','power'], and it was intermittent, so it read as flake).
//
// A silent catch is defensible in plenty of places — a cache put, an activity
// log, a snapshot write — and ~97 files in this repo have one. What makes it a
// LIE here is the neighbourhood: an importer's whole output is a COUNT the user
// reads as "this is what happened". So the rule is scoped to import paths: a
// failed write must reach the tally (or the errors array), never a bare catch.
//
// If a swallow is genuinely right in an import path, say why on the line:
//   `.catch(() => undefined) // import-swallow-ok: <reason>`
//
//   cd <repo> && npx tsx scripts/lint-import-no-silent-write.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Import paths: where a swallowed write becomes a false success count. */
const ROOTS = ["modules/core-import/src"];
/** `.catch(() => undefined)` / `.catch(() => {})` / `.catch(() => null)`. */
const SILENT_CATCH = /\.catch\(\s*\(\s*\)\s*=>\s*(undefined|null|\{\s*\})\s*\)/;
const ESCAPE = /import-swallow-ok:/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const failures: string[] = [];
for (const root of ROOTS) {
  let files: string[] = [];
  try {
    files = walk(root);
  } catch {
    continue; // root not present in this checkout
  }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
        if (!SILENT_CATCH.test(line)) return;
        // The reason may sit on the line itself or in the comment above it —
        // a real explanation rarely fits as a trailing comment.
        if (ESCAPE.test(line) || ESCAPE.test(lines[i - 1] ?? "") || ESCAPE.test(lines[i - 2] ?? "")) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment about the rule is not the rule
        failures.push(
          `${file.replace(/\\/g, "/")}:${i + 1} swallows a failure in an import path:\n` +
            `    ${line.trim()}\n` +
            `    → count it (a *_failed tally) or push it into the errors array.\n` +
            `      An importer's numbers are what the user believes happened.\n` +
            `      Genuinely fine? append: // import-swallow-ok: <reason>`,
        );
    });
  }
}

if (failures.length) {
  console.error(`[lint:import-no-silent-write] ✗ ${failures.length} swallowed failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:import-no-silent-write] ✓ no import path swallows a write failure");
