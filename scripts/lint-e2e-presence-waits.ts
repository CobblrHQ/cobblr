#!/usr/bin/env tsx
// An e2e check that something is on screen waits for it through seen() (e2e/lib/seen.mjs), never asks a locator's isVisible(), which answers at once and counts a page still held see-through as shown.
//
// THE BUG THIS PREVENTS. record-sold-walk failed both nightly tries in e2e 61623 (2026-11-02, #9112): its button sat in a page held see-through until its reads answered.
//
// THE RULE. A line that calls check( and asks `await <locator>.isVisible()`
// fails, unless the ask is negated (`!(await ...)`): that is an absence
// check, which waiting would not make true sooner, and is not this rule's
// business. The presence form is `check(await seen(locator), ...)`: seen()
// waits up to ten seconds for the element to be Playwright-visible and
// outside a held page (`[data-page-held]`, aria-hidden, inert). A check that
// must answer this very instant says why with `// NOW: <why>` on the line.
//
// WHY isVisible() IS THE WRONG QUESTION. Every page is laid out at once and
// held at opacity 0 until its first reads answer (PageHoldsStill). Playwright
// calls an opacity-0 element visible, so a walk that waited for a row's text
// went on inside the hold; isVisible() never waits, and the header button
// it then asked for by role was still under aria-hidden. The walk's next
// line clicked the same button (a click waits) and passed, which is how a
// presence race read as a missing button.
//
// THE BOUNDARY. Only a check( line: an isVisible() used to choose a branch
// (record-action.mjs asks whether the action is already open before it opens
// the menu) is a probe whose false answer is handled, not a verdict. The
// 40 presence checks this rule found when it was written all moved to seen().
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-e2e-presence-waits.ts   (pnpm lint e2e-presence-waits)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["e2e"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.mjs$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bcheck\(/.test(line) || /\/\/ NOW: \S/.test(line)) continue;
    // Each ask of isVisible() on the line, judged by what stands just before its await.
    for (const m of line.matchAll(/(!\s*\(\s*)?await\s+(?:(?!await\b)[^;])*?\.isVisible\(\)/g)) {
      if (m[1]) continue;
      out.push({ file, line: i + 1, what: "check(await ….isVisible()) answers at once and counts a held page as shown; use check(await seen(locator), …)" });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:e2e-presence-waits - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Write check(await seen(locator), ...) with import { seen } from \"./lib/seen.mjs\"; an absence check (!) is not judged. A check that must answer this instant says why with // NOW: <why>.");
  process.exit(1);
}
console.log(`lint:e2e-presence-waits OK`);
