// One name for the thing a user sets: a LOCATION, and the action is "Set location".
//
// The scan surfaces had accumulated six synonyms for one concept - "New scans →",
// "pick a location", "Choose a location…", "No filing location", "need a place",
// "tap to place them" - plus a chip that said "No filing location" on a desktop
// and "Set location" on a phone, so the same control taught two different words
// depending on the window width (the author, 2026-08-01: "keep 'set location' as the
// consistent phrase regardless of desktop vs mobile").
//
// Synonyms are not a style problem. A person who learns "Set location" in the
// bulk toolbar has to re-learn it as "filing location" in the header and "a
// place" in the session chip, and then cannot tell whether the three do the same
// thing. (They nearly don't - see the active-bin bug in activeBinFiling.test.ts.)
//
// So: this lint fails on the banned synonyms in user-facing strings under the
// scan surfaces. It checks JSX text, string literals and title/placeholder
// attributes; it deliberately does NOT check comments, where naming the old
// wording is how we explain the history.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// TWO KINDS OF RULE, because a control LABEL and a SENTENCE are not the same
// thing. "Pick a location and all 3 are filed" is good prose using the right
// noun; "pick a location" as a picker's placeholder is a second name for the
// Set location button. So:
//   noun  - a wrong WORD for the concept. Banned anywhere, prose included.
//   label - the right noun in a rival verb form. Banned only when the string
//           literal IS essentially that phrase, i.e. when it names a control.
interface Rule {
  phrase: RegExp;
  use: string;
  kind: "noun" | "label";
}

const BANNED: Rule[] = [
  // Wrong noun for the concept - never right, in prose or in a label.
  { phrase: /\bfiling location\b/, kind: "noun", use: '"location" (the action is "Set location")' },
  { phrase: /\bno location set\b/, kind: "noun", use: '"Set location"' },
  { phrase: /\bneeds? a place\b/, kind: "noun", use: '"needs a location"' },
  // Missed on the first pass: SessionLocationModal said "Pick a place and all 3
  // are filed" and sailed through, which is exactly the drift this lint is for.
  { phrase: /\bpick a place\b/, kind: "noun", use: '"Pick a location"' },
  { phrase: /\bchoose a place\b/, kind: "noun", use: '"Set location"' },
  { phrase: /\ba place for\b/, kind: "noun", use: '"a location for"' },
  { phrase: /\bhave nowhere to go\b/, kind: "noun", use: '"have no location yet"' },
  // Right noun, rival verb - only a problem when it names a control.
  { phrase: /\bpick a location\b/, kind: "label", use: '"Set location"' },
  { phrase: /\bchoose a location\b/, kind: "label", use: '"Set location"' },
  { phrase: /\bset a location\b/, kind: "label", use: '"Set location" or "Set the location"' },
];

/**
 * Is this phrase acting as a LABEL here? A label is a short standalone string
 * (`"Set location"`, `placeholder="pick a location"`), not a clause inside a
 * sentence. Approximated by: some quoted run on the line is ~just the phrase.
 */
function usedAsLabel(line: string, phrase: RegExp): boolean {
  const literals = line.match(/(["\'`])((?:\\.|(?!\1).)*)\1/g) ?? [];
  return literals.some((lit) => {
    const inner = lit.slice(1, -1).trim();
    return phrase.test(inner.toLowerCase()) && inner.replace(/[….?!]/g, "").length <= 24;
  });
}

/** Files whose user-facing copy this covers. */
const FILES = [
  "web/src/pages/ScanPage.tsx",
  "web/src/pages/sessionCategory.ts",
  "web/src/pages/scanFileAll.ts",
  "web/src/components/SessionLocationModal.tsx",
  "web/src/components/LocationTreePicker.tsx",
  "web/src/components/LocationChipPicker.tsx",
  "web/src/components/OrganizePlanSheet.tsx",
  "web/src/components/OrganizeWalkSheet.tsx",
];

/** Strip comments so history can name the old wording without failing. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + m.slice(p1.length).replace(/./g, " "));
}

let failures = 0;
// A renamed/moved file must not silently stop being checked.
const missing = FILES.filter((f) => !existsSync(join(ROOT, f)));
if (missing.length) {
  console.error(`lint:location-vocabulary — these covered files no longer exist:\n  ${missing.join("\n  ")}`);
  console.error("Update the FILES list (or restore the file) so the check keeps its coverage.");
  process.exit(1);
}
for (const file of FILES) {
  const raw = readFileSync(join(ROOT, file), "utf8");
  const code = stripComments(raw);
  code.split("\n").forEach((line, i) => {
    for (const { phrase, use, kind } of BANNED) {
      if (!phrase.test(line.toLowerCase())) continue;
      if (kind === "label" && !usedAsLabel(line, phrase)) continue;
      console.error(
        `${file}:${i + 1}  banned ${kind === "label" ? "control label" : "wording"} ${phrase} - use ${use}\n` +
          `    ${line.trim().slice(0, 120)}`,
      );
      failures++;
    }
  });
}

if (failures > 0) {
  console.error(
    `\nlint:location-vocabulary — ${failures} synonym${failures === 1 ? "" : "s"} for "location".\n` +
      `One concept, one name: the noun is a LOCATION and the action is "Set location", at every width.\n`,
  );
  process.exit(1);
}
console.log(`lint:location-vocabulary ✓ one name for location across ${FILES.length} scan surfaces.`);
