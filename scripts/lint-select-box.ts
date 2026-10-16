#!/usr/bin/env tsx
// A checkbox that picks a row for a bulk action is a SelectBox (@cobblr/platform-web), so a finger has 44 px around it on a phone, never a bare 12 px box.
//
// THE BUG THIS PREVENTS. The phone-shapes audit, 2026-10-15 (#6782): every collection list's row select was a 12 px tap beside a row that opens the record.
//
// THE RULE. A JSX <input type="checkbox"> whose name starts "Select " (a
// row's "Select <name>", or "Select all") fails anywhere but SelectBox.tsx:
// a box cannot carry the room touch-targets.css gives a label, so on a phone
// it stays a 12 px tap. No opt-out: SelectBox takes every placement a row
// needs (className, boxClassName, title, words beside it).
//
// A box already inside a label of its own passes too: the label carries the
// room (the scan inbox's session select-all is one, sized by hand).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A readOnly box is a picture
// of the state inside a card the person presses as a whole (the farm view's
// tiles, where the card toggles the pick): the card is the target, so a
// readOnly box passes. A checkbox named for anything else (a setting, a
// filter) is a different control and is judged by the walk's tapTargets.
//
//   npx tsx scripts/lint-select-box.ts   (pnpm lint select-box)
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

/** An element's attributes, from just after its tag name to its closing ">":
 *  a ">" inside {…} (an arrow function, a comparison) is not the end. */
function jsxAttrs(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(from, i);
  }
  return src.slice(from);
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (file.endsWith("SelectBox.tsx")) return out;
  for (const m of src.matchAll(/<input\b/g)) {
    const attrs = jsxAttrs(src, m.index + m[0].length);
    if (!/type="checkbox"/.test(attrs) || /\breadOnly\b/.test(attrs)) continue;
    if (!/aria-label=(\{`Select |"Select )/.test(attrs)) continue;
    // Already in a label of its own: the label carries the room (touch-targets.css).
    if (src.lastIndexOf("<label", m.index) > src.lastIndexOf("</label>", m.index)) continue;
    out.push({ file, line: src.slice(0, m.index).split("\n").length, what: "a row's select checkbox drawn bare: a 12 px tap on a phone" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:select-box - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Write <SelectBox checked onChange label /> from @cobblr/platform-web.");
  process.exit(1);
}
console.log(`lint:select-box OK`);
