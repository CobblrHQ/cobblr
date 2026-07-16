#!/usr/bin/env tsx
// A view renderer must not read a config key no UI can set.
//
// THE BUG THIS EXISTS FOR (found in the 2026-07-16 record-substrate review):
// GalleryRenderer read `cfg.caption_field` to draw a caption under each card,
// but neither the New-view nor the Edit-view modal ever wrote that key. The
// capability shipped, looked done in the diff, and was unreachable — a dead
// knob. The only way to set it was hand-writing JSON into the saved view.
//
// The class: a renderer grows a `cfg.<key>` read and the modal that builds the
// config isn't updated in the same change. It is invisible in review (both
// halves look fine alone) and invisible at runtime (the key just reads
// undefined and the feature silently no-ops).
//
// So: parse the renderers' `cfg.<key>` READS and the modals' `config.<key> =`
// WRITES out of ViewsPage.tsx, and fail when a read has no writer. Textual on
// purpose — it needs no view-model refactor, and the two halves live in one
// file, so a grep-level check is exactly as reliable as the thing it guards.

import { readFileSync } from "node:fs";

const FILE = "web/src/pages/ViewsPage.tsx";
const src = readFileSync(FILE, "utf8");

// Keys a renderer reads: `cfg.foo` / `(cfg.foo as X)` / `cfg["foo"]`.
const reads = new Set<string>();
for (const m of src.matchAll(/\bcfg(?:\.(\w+)|\[["'](\w+)["']\])/g)) {
  const key = m[1] ?? m[2];
  if (key) reads.add(key);
}

// Keys a modal writes: `config.foo = …` / `delete config.foo` /
// `Object.assign(config, …)` helpers are handled by the allowlist below.
const writes = new Set<string>();
for (const m of src.matchAll(/\bconfig(?:\.(\w+)\s*=|\[["'](\w+)["']\]\s*=)/g)) {
  const key = m[1] ?? m[2];
  if (key) writes.add(key);
}

// Keys that are legitimately not written by the view modals.
const ALLOW = new Set([
  // Filter/sort ride in via filterRowsToConfig()/rowsToSort() spreads, not a
  // literal `config.x =`, and have their own editors.
  "sort",
  "filters",
  "filter",
  // Read off the row/config bag generically, never a per-view setting.
  "length",
]);

const orphans = [...reads].filter((k) => !writes.has(k) && !ALLOW.has(k)).sort();

if (orphans.length > 0) {
  console.error(
    `[lint:view-config-keys] ✗ ${FILE}: renderer reads a config key nothing can set:\n`,
  );
  for (const k of orphans) console.error(`    cfg.${k}`);
  console.error(
    "\n  Each key a renderer reads needs a control in BOTH the New-view and\n" +
      "  Edit-view modals (write it as `config.<key> = …`), or the feature is\n" +
      "  unreachable — a dead knob only hand-written JSON can turn on.\n" +
      "  If the key genuinely isn't a per-view setting, add it to ALLOW here\n" +
      "  with a reason.\n",
  );
  process.exit(1);
}

console.log(
  `[lint:view-config-keys] ✓ ${reads.size} renderer config key(s) all settable in the view modals`,
);
