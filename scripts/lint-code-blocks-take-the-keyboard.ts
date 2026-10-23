#!/usr/bin/env tsx
// A code block that scrolls sideways (a pre with overflow auto) can be reached from the keyboard: it carries tabIndex={0}, so a keyboard user can focus it and read its hidden end with the arrow keys.
//
// THE BUG THIS PREVENTS. #7856, 2026-10-22: on iPhone WebKit no code block on Connect an assistant took focus, so a keyboard user could not read the right-hand end of a 1477 px setup command in a 338 px box
//
// THE RULE. A <pre> whose className makes it scroll (overflow-auto,
// overflow-x-auto, overflow-scroll, overflow-x-scroll) carries tabIndex={0}
// in the same opening tag. Desktop Chromium focuses an overflowing box by
// itself; WebKit does not, so on an iPhone with a keyboard the box was never
// reached. A <pre> that wraps (whitespace-pre-wrap, no overflow class) has no
// hidden end and passes.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only <pre>: the code blocks
// are the scrollers whose content is text to read in place. A scrolling list
// or table holds controls of its own a Tab already reaches, so it is not
// judged. Nothing has tested the boundary beyond that yet.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-code-blocks-take-the-keyboard.ts   (pnpm lint code-blocks-take-the-keyboard)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  for (const m of src.matchAll(/<pre\b([^>]*)>/g)) {
    const tag = m[1] ?? "";
    if (!/\boverflow-(?:x-)?(?:auto|scroll)\b/.test(tag) || /\btabIndex=\{0\}/.test(tag)) continue;
    out.push({ file, line: src.slice(0, m.index).split("\n").length, what: "a scrolling <pre> without tabIndex={0}: WebKit never focuses it, so a keyboard cannot read its hidden end" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:code-blocks-take-the-keyboard - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("add tabIndex={0} to the pre");
  process.exit(1);
}
console.log(`lint:code-blocks-take-the-keyboard OK`);
