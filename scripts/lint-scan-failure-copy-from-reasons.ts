#!/usr/bin/env tsx
// A sentence on the scan and inbox surfaces that claims a failure (couldn't, could not, didn't answer, failed) comes from the platform contract's reason words, or says on its line why it is true (failure-copy: <the error or record it reports>); a reason code is never defaulted to a failure
//
// THE BUG THIS PREVENTS. An Amazon sticker's scan card said "The AI could
// not read this one." with a Retry, and the owner rescanned a sharp photo and
// read it again (#4933, 2026-10-05). No AI had been asked: the record carried
// no failure, and the sentence was the card's default for a nameless row.
// It read as an outage. The desk card said "Couldn't identify this barcode"
// over the same record, and a keyword match with no recorded reason said "the
// AI didn't answer" because its reason defaulted to "no-answer".
//
// THE RULE. On the scan and inbox surfaces (web/src pages, components and
// libs whose file name starts with Scan or scan, and identifySentence), a
// string or JSX text that claims a failure ("couldn't", "could not", "didn't
// answer", "did not answer", "failed.", "unable to") fails unless:
//   - it is on a toast, a thrown Error or a console line: those report the
//     error a request just returned, which is true by construction; or
//   - the line, or one of the three above it, says `failure-copy: <the error
//     or record it reports>`.
// Words chosen from the record live in the contract (scan-nameless.ts,
// scan-fallback.ts, scan-copy.ts) and are imported, so they never appear here
// as literals. And a reason code is never DEFAULTED to a failure:
// `?? "no-answer"`, `?? "ai-failed"` and the like fail too, because a missing
// reason is the absence of a record, not a failure.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A sentence shown in a catch
// for the request that just failed ("Couldn't file this: <its message>") is
// true, and is annotated rather than banned. Comments are not judged, block
// comments included: the card's comments quote the old sentences on purpose.
//
// PROVE IT RED: on main at fb3963f19 (17 violations) it names identifySentence's "The AI could
// not read this one.", the card's "Couldn't identify this ...", "Matching
// failed; the AI did not answer.", the phone row's "The AI did not answer last
// time", the history's "the AI didn't answer" and the three
// `?? "no-answer"` defaults (COBBLR_LINT_ROOT=<a checkout> points it at
// another tree).
//
//   npx tsx scripts/lint-scan-failure-copy-from-reasons.ts   (pnpm lint scan-failure-copy-from-reasons)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const BASE = process.env.COBBLR_LINT_ROOT?.trim() || ".";
const ROOTS = ["web/src/pages", "web/src/components", "web/src/lib"].map((r) => join(BASE, r));
/** The scan and inbox surfaces, discovered by name. */
const onScanSurface = (name: string) => /^(Scan|scan|identifySentence)/.test(name);
const CLAIM = /(could ?n[o'’]t|could not|did ?n[o'’]t answer|did not answer|\bfailed[;.:!]|\bunable to)/i;
const DEFAULTED = /\?\?\s*["'](no-answer|no_answer|ai-failed|provider-error|ai_unavailable)["']/;
const TRUE_BY_CONSTRUCTION = /toast\.|console\.|new Error\(|throw /;
/** Literals and JSX text on a line, comments taken out first. */
const literalsOf = (code: string): string[] => code.match(/"[^"]*"|'[^'\n]*'|`[^`]*`|>[^<>{}]+</g) ?? [];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && onScanSurface(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    let code = lines[i] ?? "";
    // Take comments out: a block comment (JS or JSX) may span lines.
    if (inBlock) {
      const end = code.indexOf("*/");
      if (end < 0) continue;
      code = code.slice(end + 2);
      inBlock = false;
    }
    code = code.replace(/\/\*.*?\*\//g, "");
    const open = code.indexOf("/*");
    if (open >= 0) {
      inBlock = true;
      code = code.slice(0, open);
    }
    code = code.replace(/(^|[^:"'`])\/\/.*$/, "$1");
    if (!code.trim()) continue;
    const near = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    const note = /failure-copy:\s*(.*)/.exec(near);
    const annotated = !!note && note[1]!.replace(/\*\/\s*\}?\s*$/, "").trim().length >= 8;
    if (DEFAULTED.test(code)) {
      out.push({ file, line: i + 1, what: "a reason code defaulted to a failure: a missing reason is no record, not a failure (pass null and let the contract say the neutral thing)" });
      continue;
    }
    if (TRUE_BY_CONSTRUCTION.test(code) || annotated) continue;
    // JSX text on a line of its own (between tags on other lines).
    const bareText = /^\s*[A-Za-z][^=;{}()<>]*$/.test(code);
    if (literalsOf(code).some((l) => CLAIM.test(l)) || (bareText && CLAIM.test(code))) {
      out.push({ file, line: i + 1, what: note ? "a failure-copy: annotation with no reason" : "a failure sentence as a literal: take its words from the contract's reason map, or say failure-copy: <the error or record it reports>" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:scan-failure-copy-from-reasons - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:scan-failure-copy-from-reasons OK`);
