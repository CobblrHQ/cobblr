#!/usr/bin/env tsx
// A sentence the scan card shows (a lookup verdict, a routing note, a review reason, a tool-hint reason) is one plain sentence of at most 70 characters with no parentheses and no because or so-that clause; the why goes in the title.
//
// THE BUG THIS PREVENTS. the store-code note ran to 154 characters with a parenthetical and the phone card clipped it at 'so there is nothi...'; the owner asked for these sentences to be severely shortened (#3017, 2026-09-15)
//
// THE RULE. Over the files that write the sentences a scan card shows (the
// lookup verdicts and notes in enrich.ts, routing-note.ts, the review
// reasons in scan-triage.ts, the tool-hint reasons in scan-tools.ts, the
// fallback hints in scan-fallback.ts, the split, provenance and
// acquisition-source sentences), every string literal that reads as a
// sentence (starts with a capital letter, holds a space, ends in
// punctuation) or is assigned to a *_NOTE / *_WORDS constant must be
//   - at most 70 characters,
//   - free of parentheses,
//   - free of a "because" or "so that" clause.
// A phone card has one line for it. The why goes in the title or tooltip.
// The matchmaker's `notes` instruction must carry its cap ("twelve words or
// fewer, no parentheses"), or a model sentence has no ceiling at all.
//
// A sentence that must stay longer is listed in
// scripts/scan-card-copy-baseline.json with its reason, the way
// lint-ui-jargon keeps its baseline; the baseline may shrink, never grow
// without a reason. A comment is not judged; a template literal is judged
// on its literal text with each ${...} counted as one word. A `detail:`
// beside a sentence, a *_TITLE constant and a RETIRED_* list (the old
// wordings kept for the note stripper) are not card lines and pass.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-scan-card-copy.ts   (pnpm run lint:scan-card-copy)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules/core-scan/src/services", "packages/platform-contract/src"];

/** The files whose literals reach a card. Narrow on purpose: enrich.ts holds
 *  prompts and log lines too, so only its *_NOTE / *_WORDS constants count. */
const CARD_FILES = new Set([
  "modules/core-scan/src/services/routing-note.ts",
  "modules/core-scan/src/services/split-inherit.ts",
  "modules/core-scan/src/services/field-provenance.ts",
  "packages/platform-contract/src/scan-triage.ts",
  "packages/platform-contract/src/scan-tools.ts",
  "packages/platform-contract/src/scan-fallback.ts",
  "packages/platform-contract/src/scan-copy.ts",
  "packages/platform-contract/src/acquisition-source.ts",
]);
const CONSTANT_ONLY_FILES = new Set(["modules/core-scan/src/services/enrich.ts"]);
const MATCHMAKER = "modules/core-scan/src/services/matchmaker.ts";
const MAX = 70;
const BASELINE = "scripts/scan-card-copy-baseline.json";

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

interface Baseline {
  sentences: Array<{ text: string; reason: string }>;
}

function loadBaseline(): Set<string> {
  try {
    const b = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
    return new Set(b.sentences.filter((s) => s.reason?.trim()).map((s) => s.text));
  } catch {
    return new Set();
  }
}
const baseline = loadBaseline();

/** A template literal's text with each ${...} counted as one short word. */
const flatten = (lit: string): string => lit.replace(/\$\{[^}]*\}/g, "x");

const readsAsSentence = (t: string): boolean => /^[A-Z][^]*\s[^]*[.!?;:]$/.test(t.trim()) && !/^[A-Z_]+$/.test(t);

function judge(text: string): string | null {
  if (baseline.has(text)) return null;
  const flat = flatten(text);
  if (flat.length > MAX) return `${flat.length} chars, over ${MAX}`;
  if (/[()]/.test(flat)) return "has parentheses";
  if (/\b(because|so that)\b/i.test(flat)) return "has a because / so-that clause";
  return null;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (file === MATCHMAKER) {
    if (!/twelve words or fewer, no parentheses/.test(src)) {
      out.push({ file, line: 1, what: "the matchmaker notes instruction lacks its cap: 'twelve words or fewer, no parentheses'" });
    }
    return out;
  }
  const constantOnly = CONSTANT_ONLY_FILES.has(file);
  if (!CARD_FILES.has(file) && !constantOnly) return out;
  const lines = src.split("\n");
  // A RETIRED_* list holds the sentences a row was once written with, kept
  // so the note stripper still recognises them; nothing shows them. A
  // `detail:` is the title beside a sentence, not the line the card shows.
  let inRetired = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (/\bRETIRED_[A-Z_]+\b.*=\s*\[/.test(line)) inRetired = true;
    if (inRetired) {
      if (/^\s*\];/.test(line)) inRetired = false;
      continue;
    }
    if (/\bdetail:\s*"/.test(line) && !/\bsentence:/.test(line.replace(/detail:\s*"[^"]*"/, ""))) continue;
    // A *_TITLE constant is the tooltip beside a sentence, which may explain.
    if (/_TITLE\s*=/.test(line) || (i > 0 && /_TITLE\s*=\s*$/.test(lines[i - 1] ?? ""))) continue;
    if (constantOnly && !/(_NOTE|_WORDS)\s*=/.test(line) && !(i > 0 && /(_NOTE|_WORDS)\s*=\s*$/.test(lines[i - 1] ?? ""))) continue;
    // The line with a detail beside its sentence: judge the sentence only.
    const judged = line.replace(/\bdetail:\s*"(?:[^"\\]|\\.)*"/, "detail: 0");
    for (const m of judged.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      const text = (m[1] ?? m[2] ?? "").trim();
      if (!readsAsSentence(text)) continue;
      const why = judge(text);
      if (why) out.push({ file, line: i + 1, what: `${why}: ${JSON.stringify(text.length > 80 ? text.slice(0, 77) + "..." : text)}` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:scan-card-copy - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Shorten the sentence; move the explanation to the title or tooltip. A sentence that must stay longer is listed in scripts/scan-card-copy-baseline.json with its reason.");
  process.exit(1);
}
console.log(`lint:scan-card-copy OK`);
