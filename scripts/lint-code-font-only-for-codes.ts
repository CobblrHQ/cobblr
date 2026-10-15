#!/usr/bin/env tsx
// The code font shows only what is a code: a barcode, an id, a hex, through <Code> from @cobblr/platform-web; never a time and never plain text, and no new font-mono anywhere else.
//
// THE BUG THIS PREVENTS. #6564: Recent activity's 8h ago and 10h ago in the code font, after #6357 caught only uppercase labels
//
// THE RULE. Two parts.
//   1. A time is never in the code font: a <time> element, or a class with
//      font-mono beside relativeTime(…) or a toLocale…String(…), fails with
//      no way out. "8h ago" is words.
//   2. Anything else in the code font goes through <Code> (platform-web),
//      which is what says "this is a code". A class with font-mono anywhere
//      else is held to its file's count in scripts/code-font-baseline.json,
//      which may only shrink: 616 uses predate the rule, and each one moved
//      to <Code> or to the app's face is one fewer. A real code that cannot
//      use <Code> (an <input> holding a token) says so with a
//      `mono: <what it is>` note on its line or the line above, the same
//      escape lint:section-headings reads.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. #6357's rule caught font-mono
// only beside `uppercase`, so a lower-case time ("8h ago") and plain text kept
// the code font. Counting per file, not per line, lets an untouched file move
// lines without failing; a file only fails when it gains one.
//
// PROVE IT RED: the dashboard's and the Activity page's times on main.
//
//   npx tsx scripts/lint-code-font-only-for-codes.ts   (pnpm lint code-font-only-for-codes)
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const BASELINE_PATH = "scripts/code-font-baseline.json";
const baseline: Record<string, number> = (() => {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
})();
const WRITE = process.argv.includes("--write-baseline");
const counts: Record<string, number> = {};
/** The one file allowed to spell the code font for everyone. */
const CODE_COMPONENT = "packages/platform-web/src/Code.tsx";
/** Text that is a time: a relative one, a date or time said by the locale, or
 *  a Date said whole. A number's toLocaleString ("1,204 calls") is not. */
const TIME_TEXT = /relativeTime\(|formatRelative\(|toLocale(?:Date|Time)String\(|new Date\([^()]*(?:\([^()]*\))?[^()]*\)\.toLocaleString\(|_at\)\.toLocaleString\(/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (file === CODE_COMPONENT || !file.endsWith(".tsx")) return out;
  const lines = src.split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/\bfont-mono\b/.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    // The element's own text: from the code font to its closing tag, a few
    // lines at most. A code that merely sits beside a time is not a time.
    const from = lines.slice(i, i + 5).join("\n");
    const own = from.slice(from.indexOf("font-mono"), from.indexOf("</", from.indexOf("font-mono")) >= 0 ? from.indexOf("</", from.indexOf("font-mono")) : undefined);
    const opening = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    const isTime = /<time\b[^<]*$/.test(opening) || TIME_TEXT.test(own);
    if (isTime) {
      out.push({ file, line: i + 1, what: "a time in the code font: say it in the app's face (tabular-nums for alignment)" });
      continue;
    }
    if (/mono: \S/.test(line) || /mono: \S/.test(lines[i - 1] ?? "")) continue;
    count++;
  }
  if (count) counts[file] = count;
  const allowed = baseline[file] ?? 0;
  if (!WRITE && count > allowed) out.push({ file, line: 0, what: `${count} use(s) of font-mono, ${allowed} allowed: show a code through <Code> from @cobblr/platform-web, or say it in the app's face` });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (WRITE || onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));
if (WRITE) {
  writeFileSync(BASELINE_PATH, JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
  console.log(`lint:code-font-only-for-codes: baseline written (${Object.values(counts).reduce((a, b) => a + b, 0)} uses in ${Object.keys(counts).length} files)`);
}

if (violations.length) {
  console.error(`lint:code-font-only-for-codes - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:code-font-only-for-codes OK`);
