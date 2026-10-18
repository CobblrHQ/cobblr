#!/usr/bin/env tsx
// A box that is w-full never also takes a negative side margin: the margin moves it, it does not widen it, so its own padding comes out of what its column was sized for and a word that fit breaks.
//
// THE BUG THIS PREVENTS. #7334 (2026-10-18): the yarn stash table's Fibre column read Acryli / c, Cheni / lle, Alpac / a at a desk; the editable cell's box was w-full -mx-1.5 px-1.5.
//
// THE RULE. One className string (a "..." or `...` literal) that holds
// `w-full` and a negative side margin (`-mx-*`, `-ml-*`, `-mr-*`) on an
// element that is not a form control fails. A block with auto width and a
// negative margin is already its container plus the margin; `w-full` pins it
// back to the container, so the margin only shifts it and its padding is
// taken out of the width the table gave the column for its longest word.
// A deliberate one says `// full-bleed: <why>` on that line.
//
// THE BOUNDARY. An <input>, <textarea> or <select> is not judged: a form
// control has an intrinsic width, so auto does not fill, and `w-full` is how
// it fills its row (inventory's settings name field, w-full px-1 -mx-1).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-full-width-box-is-not-pulled-wider.ts   (pnpm lint a-full-width-box-is-not-pulled-wider)
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\/\/ full-bleed: \S/.test(line)) continue;
    for (const m of line.matchAll(/(["`])([^"`]*)\1/g)) {
      const cls = ` ${m[2]} `;
      if (!/\sw-full\s/.test(cls) || !/\s-m[xlr]-[\w.[\]]+\s/.test(cls)) continue;
      // The element this className belongs to: the nearest opening tag above.
      const before = [...lines.slice(Math.max(0, i - 24), i), line.slice(0, m.index ?? 0)].join("\n");
      const tag = [...before.matchAll(/(?:^|[\s({>])<([A-Za-z][\w.]*)/g)].pop()?.[1] ?? "";
      if (/^(input|textarea|select)$/i.test(tag)) continue;
      out.push({ file, line: i + 1, what: "w-full with a negative side margin: the margin shifts the box instead of widening it, so its padding eats its column and a word that fit breaks" });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-full-width-box-is-not-pulled-wider - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("drop w-full (a block with auto width and a negative margin is its column plus the margin), or say // full-bleed: <why> on that line");
  process.exit(1);
}
console.log(`lint:a-full-width-box-is-not-pulled-wider OK`);
