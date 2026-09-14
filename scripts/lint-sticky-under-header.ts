#!/usr/bin/env tsx
// A sticky element in the app says which it is, sticky-under-header (offset by the shell's fixed header) or sticky-in-scroller (inside an overflow container); a bare sticky with a literal top sits under the header on a phone.
//
// THE BUG THIS PREVENTS. the Scan Inbox selection toolbar stuck at top:0 under the fixed header at 393px, count and scope covered while Confirm stayed reachable (core #2979, 2026-09-14)
//
// THE RULE. The shell's header is position:fixed on every width, and it
// publishes its live bottom edge as --app-header-bottom (AppLayout). A
// `sticky top-0` sticks to the VIEWPORT top, which is under that header, so a
// bar written that way is covered the moment the page scrolls. Two named
// classes in web/src/index.css say which of the two things a sticky element is:
//
//   sticky-under-header   viewport-sticky: top is the header variable.
//   sticky-in-scroller    sticks inside an overflow container (a modal's table
//                         head, a dropdown's group label): top:0 is right there,
//                         and the header is not in the picture.
//
// PASSES: an element carrying one of those two classes; a `sticky` that is
// not top-sticky at all (`sticky left-0` freezes a table column, `sticky
// bottom-0` docks a bar to the foot, and neither meets the header). FAILS:
// the bare Tailwind class `sticky` in the same class list as a `top-*` (or
// beside a `top:` style). A string equal to "sticky" on its own (`via ===
// "sticky"`, an enum value) is not a class and is not judged. An offset above
// the header (the configuration sidebar keeps a 1rem breath) is the
// --sticky-gap variable the utility adds, `[--sticky-gap:1rem]`, never a
// `top-*` of its own. There is no opt-out: the in-scroller class IS the way
// to say "top:0 on purpose", so every exception already has a spelling.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-sticky-under-header.ts   (pnpm run lint:sticky-under-header)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules"];

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

/** The bare class token: `sticky` bounded by whitespace or a quote, and not
 *  the head of `sticky-under-header` / `sticky-in-scroller`. */
const BARE_STICKY = /(^|[\s"'`])sticky(?=[\s"'`]|$)/;
/** A whole-string "sticky" is a VALUE (an enum, a comparison), not a class. */
const STICKY_AS_VALUE = /(===?|!==?|:|\?|,)\s*["'`]sticky["'`]|["'`]sticky["'`]\s*(:|,|\)|\]|===?|!==?)/;
/** Where a class token can live on a line. */
const CLASS_CONTEXT = /className|class=|\bcn\(|\bclsx\(|\btwMerge\(|\bcx\(/;
/** A quoted class list with more than one class in it (a className split
 *  across lines carries no `className` on its inner lines). */
const CLASS_LIST = /["'`][^"'`]*\S[^"'`]*\s[^"'`]*sticky(?=[\s"'`])[^"'`]*["'`]/;
/** Top-sticky: a `top-*` utility (with any variant prefix) or a top style. */
const TOP_OFFSET = /(^|[\s"'`:])-?top-(\d|\[|px|auto|full)|\btop:\s*["'`\d(]/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("{/*")) continue;
    if (!BARE_STICKY.test(line)) continue;
    if (STICKY_AS_VALUE.test(line) && !CLASS_CONTEXT.test(line)) continue;
    if (!CLASS_CONTEXT.test(line) && !CLASS_LIST.test(line)) continue;
    if (!TOP_OFFSET.test(line)) continue;
    out.push({ file, line: i + 1, what: "bare `sticky`: say sticky-under-header (viewport, offset by the header) or sticky-in-scroller (inside an overflow container)" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:sticky-under-header - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("replace 'sticky top-0' with sticky-under-header (viewport-sticky) or sticky-in-scroller (a table head or list label inside an overflow container)");
  process.exit(1);
}
console.log(`lint:sticky-under-header OK`);
