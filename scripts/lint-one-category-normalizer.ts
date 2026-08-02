// One concept, one normalizer.
//
// "Is this category already one we use?" was answered in three places, each with
// its own inline `s.toLowerCase().replace(/[^a-z0-9]+/g, "")`:
//
//   modules/core-scan/src/api/inbox.ts        growCategoryChoices  (grows it)
//   modules/core-scan/src/services/matchmaker resolveCategory      (enforces it)
//   api/src/platform/instance-promote.ts      growParentCategory   (grows it)
//
// None handled plurals or synonyms, while the shared reconciler
// `normaliseCategory` handled both. So confirming "Figurines" into a vocabulary
// already holding "Figurine" added a SECOND entry - permanently - and every
// later scan could then legitimately "reuse an existing value" and pick either
// one. The vocabulary whose whole job is to make scans converge was what split
// them (the author, 2026-08-02, nine Royal Doulton character jugs).
//
// The reason it happened three times is that an inline normalizer is four
// obvious-looking tokens. Nobody was careless; the shape is just easy to retype
// and impossible to notice in review. So this fails CI on the SHAPE, in the
// files that decide category identity: use the shared reconciler.
//
// Deliberately narrow. `[^a-z0-9]` is a fine normalizer for a slug, a vendor key
// or a filename, and this must not become a repo-wide ban on a common idiom -
// only the files below are about a category's identity.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that decide whether two category labels mean the same thing. */
const CATEGORY_IDENTITY_FILES = [
  "modules/core-scan/src/api/inbox.ts",
  "modules/core-scan/src/services/matchmaker.ts",
  "api/src/platform/instance-promote.ts",
  "web/src/pages/sessionCategory.ts",
];

/** The retyped-normalizer shape: lowercase + strip everything non-alphanumeric. */
const AD_HOC = /toLowerCase\(\)[\s\S]{0,40}?replace\(\s*\/\[\^a-z0-9\]\+?\/g\s*,\s*""\s*\)/;

/** Blank comments so documenting the old shape does not fail the check. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + m.slice(p1.length).replace(/./g, " "));
}

let failures = 0;
for (const rel of CATEGORY_IDENTITY_FILES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(
      `lint:one-category-normalizer — ${rel} no longer exists.\n` +
        `Update the file list rather than losing the check.`,
    );
    process.exit(1);
  }
  const code = stripComments(readFileSync(abs, "utf8"));
  code.split("\n").forEach((line, i) => {
    if (!AD_HOC.test(line)) return;
    console.error(
      `${rel}:${i + 1}  an inline category normalizer\n` +
        `    ${line.trim().slice(0, 110)}\n` +
        `    Use normaliseCategory from @cobblr/platform-contract/category-reconcile:\n` +
        `    it folds case, punctuation, plurals AND synonyms, so "Figurines" and\n` +
        `    "Figurine" are one entry rather than two.`,
    );
    failures++;
  });
}

if (failures > 0) {
  console.error(
    `\nlint:one-category-normalizer — ${failures} inline normalizer(s) where category identity is decided.\n`,
  );
  process.exit(1);
}
console.log(
  `lint:one-category-normalizer ✓ category identity is decided by the shared reconciler in all ${CATEGORY_IDENTITY_FILES.length} places.`,
);
