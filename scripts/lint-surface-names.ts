#!/usr/bin/env tsx
// User-facing copy must call the config surface by its real name: Configuration.
//
// WHY THIS IS A LINT: an in-app string said "Add one under Settings, AI" while
// its sibling error said "(Configuration → AI)" — same feature, two names, and
// the wrong one was faithfully copied into the public docs (caught in the
// 2026-08-01 docs review). The platform surface is Configuration; "Settings" is
// only the managed-app menu item. Any "Settings, X" / "Settings → X" form in a
// source string is pointing users at a page that does not exist.
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

// "Settings" followed by a separator + a KNOWN Cobblr Configuration page name
// (the list mirrors configuration-nav.ts labels, plus past misnomers like "AI
// sharing" and "Blueprint" that never existed under any name). Bare "Settings"
// stays legal (the managed-app menu item really is called that), and so do
// third-party references like OctoPrint's "Settings → Application Keys".
const BANNED =
  /Settings(,| →| ->| >) (AI sharing|AI|Printers|Backup|Blueprint|API tokens|Modules|Bundles|Wires|Fields|Devices|Integrations|Scan rules|QR codes)\b/;

const files = sourceFiles("{packages,modules,web,api}/**/*.{ts,tsx}");

const offenders: string[] = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((line, i) => {
    if (BANNED.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
  });
}

if (offenders.length) {
  console.error(
    '[lint:surface-names] "Settings, X" / "Settings → X" in a source string — the\n' +
      'platform config surface is called Configuration ("Configuration → AI",\n' +
      '"Configuration → Printers"). Rename the reference.\n',
  );
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log(`lint:surface-names: config surface named consistently (${files.length} files scanned) ✓`);
