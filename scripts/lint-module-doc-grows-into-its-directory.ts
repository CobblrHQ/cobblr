#!/usr/bin/env tsx
// A module doc over 1,500 lines takes no new ## section: the next part goes in docs/modules/<name>/, so two PRs adding unrelated things never edit one file.
//
// THE BUG THIS PREVENTS. docs/modules/core-scan.md reached 8,072 lines and was
// in 33 of a week's 224 merge re-checks (#7380): every scan PR appended its
// section at the end of the one file, so any two of them collided there and
// the merge queue sent the green one back to re-run.
//
// THE RULE. A top-level docs/modules/<name>.md longer than 1,500 lines may hold
// no more `## ` sections than scripts/module-doc-sections-baseline.json allows
// it (none for a doc not listed). A new part goes in a page of its own under
// docs/modules/<name>/, linked from the doc. The baseline only shrinks: a doc
// that loses sections or drops under the cap should lose its entry, and the
// merge driver keeps the lower count (scripts/merge-shrink-only.mjs).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only the top-level module
// docs: a page already inside docs/modules/<name>/ is the split, not the
// hotspot. Lines are counted, not sections, for the cap, because core-ai.md's
// 17 sections were as much a single file to collide in as core-scan.md's 93.
// Nothing has tested the edge between a long section and a new one yet.
//
//   npx tsx scripts/lint-module-doc-grows-into-its-directory.ts   (pnpm lint module-doc-grows-into-its-directory)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

const MODULE_DOCS = "docs/modules";
const CAP = 1500;
const BASELINE_PATH = "scripts/module-doc-sections-baseline.json";

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** Sections of a doc: its `## ` headings outside fenced code. Pure. */
function sectionsOf(src: string): number[] {
  const at: number[] = [];
  let fenced = false;
  src.split("\n").forEach((l, i) => {
    if (/^\s*```/.test(l)) fenced = !fenced;
    else if (!fenced && /^## /.test(l)) at.push(i + 1);
  });
  return at;
}

/** The verdict on one doc. Pure. */
function judge(file: string, src: string, allowed: number | undefined): Violation[] {
  const lines = src.split("\n").length;
  if (lines <= CAP) return [];
  const sections = sectionsOf(src);
  const may = allowed ?? 0;
  if (sections.length <= may) return [];
  const name = file.replace(/^docs\/modules\//, "").replace(/\.md$/, "");
  return [
    {
      file,
      line: sections[may] ?? 1,
      what: `${lines} lines and ${sections.length} sections (${may} allowed): put the new part in docs/modules/${name}/<topic>.md and link it from here`,
    },
  ];
}

const baseline: Record<string, number> = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
const violations: Violation[] = [];
const stale: string[] = [];
for (const name of readdirSync(MODULE_DOCS)) {
  if (!name.endsWith(".md")) continue;
  const file = join(MODULE_DOCS, name);
  const src = readFileSync(file, "utf8");
  if (file in baseline && (src.split("\n").length <= CAP || sectionsOf(src).length < baseline[file]!)) stale.push(file);
  if (onlyChanged(file)) violations.push(...judge(file, src, baseline[file]));
}
for (const file of Object.keys(baseline)) if (!existsSync(file)) stale.push(file);

if (stale.length) console.log(`(${BASELINE_PATH} can shrink: ${stale.join(", ")})`);
if (violations.length) {
  console.error(`lint:module-doc-grows-into-its-directory - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(`A module doc over ${CAP} lines is an index: each part is a page under docs/modules/<name>/ (#7380).`);
  process.exit(1);
}
console.log(`lint:module-doc-grows-into-its-directory OK`);
