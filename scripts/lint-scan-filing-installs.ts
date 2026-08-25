// A filing surface that skips the install files into a bundle nobody has.
//
// A scan candidate can carry `bundle_external_id`, and for a bundle that SKINS
// a module's default table the candidate's `instance` is a synthetic routing
// token that will never exist as an instance. Confirm it verbatim and every
// line 404s against a bundle that would have installed perfectly.
//
// That mistake shipped THREE times on 2026-08-22 across ScanPage's call sites,
// was fixed by funnelling them through resolveInstanceForFiling, and then
// shipped a FOURTH time in the Sorting plan (found by the 2026-08-25 audit) -
// because the capability row's detect only catches a hand-rolled
// materializeQuickstart, and a surface that simply OMITS the install matches
// nothing. This lint closes that half of the class.
//
// The rule: a web file that calls confirmScanItem AND reads
// suggested_candidates must route through one of the two sanctioned shapes -
//   1. resolveInstanceForFiling (install, then file each line into the
//      instance the install actually created), or
//   2. its own materializeQuickstart call (the server installs AND files in
//      one shot - the WhatToDoPanel pattern).
// A file with neither is filing candidates verbatim.
//
// Run: npx tsx scripts/lint-scan-filing-installs.ts

import { readFileSync, globSync } from "node:fs";

const offenders: string[] = [];

for (const f of globSync("web/src/**/*.{ts,tsx}")) {
  const s = readFileSync(f, "utf8");
  if (!/confirmScanItem\s*\(/.test(s)) continue;
  // Keyed on reading candidates, not on mentioning bundle_external_id: the
  // Sorting plan's broken version never mentioned the field at all - it filed
  // cand.instance blind, which is the worst case, and a mention-based trigger
  // skipped it entirely.
  if (!/suggested_candidates/.test(s)) continue;
  if (/resolveInstanceForFiling/.test(s)) continue;
  if (/materializeQuickstart\s*\(/.test(s)) continue;
  offenders.push(f);
}

if (offenders.length) {
  console.error("✗ lint-scan-filing-installs: files scan candidates without installing what they need:\n");
  for (const f of offenders) console.error(`  ${f}`);
  console.error(
    "\n  A candidate carrying bundle_external_id may name a bundle the workspace has\n" +
      "  not installed, and for a skinning bundle its `instance` is a synthetic token\n" +
      "  that never resolves. Route the confirm through resolveInstanceForFiling\n" +
      "  (web/src/pages/scanInstall.ts), or hand the item ids to materializeQuickstart\n" +
      "  and let the server install and file in one shot.",
  );
  process.exit(1);
}

console.log("✓ scan-filing-installs: every candidate-filing surface installs what it files into.");
