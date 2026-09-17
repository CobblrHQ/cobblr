#!/usr/bin/env tsx
// A scan row's doubt (low_trust), its duplicate, its route's basis and its fields' standing are read through the contract's resolvers, never from the raw metadata in web/src
//
// THE BUG THIS PREVENTS. A hosted user tapped "Looks fine" on an 8-digit
// barcode and the amber "double-check this is the right product" stayed on
// the row and the item screen with nothing left to dismiss it (#3057,
// feedback 29a2515b). The contract owned the rule ("Looks fine" sets
// `reviewed`, which retires `low_trust`), but three surfaces re-derived the
// doubt from the raw flag and never saw `reviewed`.
//
// THE RULE. In web/src, a row's state is read through the contract's
// resolvers (scan-triage: scanRowState / scanSessionAction / scanDestination
// / scanToolsFold, and the doubt resolvers scanDoubt / scanDoubtOpen /
// scanDoubtWords, or the predicates that read them). A surface RENDERS the
// answer; it does not derive its own (#3059 Engine 1, #3076). So these fail
// anywhere in web/src outside the contract:
//   - a raw read of `low_trust` on a row's metadata (the doubt is the
//     resolver's), or a truthiness test of `tracked_match` (the duplicate
//     doubt is the resolver's; reading the match's title or picture to SHOW
//     it is fine);
//   - a read of a candidate's `basis` against "keywords" (the keyword-route
//     doubt is the resolver's);
//   - the action words written by hand: "Install & add", "Install & file",
//     a "File {n}" template, "unlikely for this one" (the words are
//     scan-copy's, chosen by the resolver);
//   - a raw read of a field's standing: `field_provenance`, a candidate's
//     `inferred` list, `photo_read` (#3059 Engine 4, #3070). What the AI
//     asserted and what the evidence contradicts are the contract's calls
//     (scan-evidence: scanAssertedFields / scanEvidenceConflicts /
//     fieldStandingsOf); a surface that reads the raw keys dresses a guess
//     in the identification's confidence, which is the defect;
//   - the words "catalog knowledge" written by hand (scan-evidence's
//     standing words, not a note a surface composes).
// Tests are exempt (they build rows). No opt-out: a surface that needs a
// new answer asks the contract owner for it.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified. Red first on ScanInboxCard.tsx's
// `lowTrust` read at f191fb210 (COBBLR_LINT_ROOT=<a checkout> points it at
// another tree).
//
//   npx tsx scripts/lint-scan-doubt-from-contract.ts   (pnpm run lint:scan-doubt-from-contract)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const BASE = process.env.COBBLR_LINT_ROOT?.trim() || ".";
const ROOTS = ["web/src"].map((r) => join(BASE, r));

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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\{\/\*)/.test(line)) continue;
    if (/\blow_trust\b/.test(line)) {
      out.push({ file, line: i + 1, what: "reads low_trust; the doubt is the contract's call (scanDoubt / scanDoubtOpen in @cobblr/platform-contract/scan-triage), which already knows about Looks fine" });
    }
    if (/!!\s*\(?[\w.?]*tracked_match|tracked_match\??\.title\s*\)?\s*\?/.test(line)) {
      out.push({ file, line: i + 1, what: "judges the duplicate itself; the contract's scanRowState does (DUPLICATE_SENTENCE), scanTrackedMatch names it" });
    }
    if (/\bbasis\s*[!=]==?\s*["']keywords["']/.test(line)) {
      out.push({ file, line: i + 1, what: "judges a keyword route itself; the contract's scanRowState does (KEYWORD_ROUTE_SENTENCE)" });
    }
    if (/Install & (add|file)|File all \{|>File \{|unlikely for this one/.test(line)) {
      out.push({ file, line: i + 1, what: "writes the action's words by hand; they are scan-copy's, chosen by scanRowState / scanSessionAction / scanToolsFold" });
    }
    if (/\bfield_provenance\b|\.inferred\b|\bphoto_read\b|catalog knowledge/.test(line)) {
      out.push({ file, line: i + 1, what: "reads a field's standing raw; what the AI asserted and what the evidence contradicts are the contract's calls (scanAssertedFields / scanEvidenceConflicts / fieldStandingsOf in @cobblr/platform-contract/scan-evidence)" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:scan-doubt-from-contract - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:scan-doubt-from-contract OK`);
