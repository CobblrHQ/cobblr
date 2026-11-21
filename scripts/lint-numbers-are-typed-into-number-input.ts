#!/usr/bin/env tsx
// A number is typed into NumberInput (or NumberField, NumberStepper, EditField numeric) from @cobblr/platform-web, never a bare <input type="number">, so it is read the way the person's locale writes it and 1,5 is never kept as 15.
//
// THE BUG THIS PREVENTS. A part's Minimum typed 1,5 on an English-language phone was kept as 15, and 1.500 on a German phone as 1.5 (2026-11-19, #4115)
//
// THE RULE. A JSX `<input>` whose `type` is the literal "number", or an
// expression that can be "number" (`type={def.type === "number" ? "number" :
// "text"}`), fails; so does a props object handed to a bare <input> with
// `type: "number"`. <NumberInput> takes the same props and hands the page the
// plain number text in e.target.value, so the swap is the tag alone; for a type
// chosen at run time it draws a plain input when the type is not "number". A
// genuine exception carries `// ALLOW-NUMBER-BOX: <reason>` on a line of the
// element or the one above it. No baseline.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A comment that names the old
// box (`an <input type="number"> dropped the comma`) is prose, not an element,
// and the comments in NumberInput.tsx, NumberField.tsx and EditField.tsx are
// exactly that; comments are blanked before the scan. NumberInput.tsx itself is
// the one place a number box may be built. A `type: "number"` in a field
// DEFINITION (a schema, a custom field's def) is data about a field, not a box:
// only an object literal on the same line as a spread into a bare <input>, or
// handed to a helper that spreads into one, is judged, and the helper in
// PatternNeeds.tsx drew that line.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-numbers-are-typed-into-number-input.ts   (pnpm lint numbers-are-typed-into-number-input)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { stripComments } from "./lib/source-scan.ts";

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
function check(file: string, raw: string): Violation[] {
  const out: Violation[] = [];
  if (/\/NumberInput\.tsx$/.test(file)) return out;
  const src = stripComments(raw);
  const lines = raw.split("\n");
  const allowed = (at: number, span: number) => /ALLOW-NUMBER-BOX: \S/.test(lines.slice(Math.max(0, at - 2), at + span).join("\n"));
  for (const m of src.matchAll(/<input\b/g)) {
    const end = src.indexOf("/>", m.index!);
    const el = src.slice(m.index!, end < 0 ? m.index! + 800 : end + 2);
    if (!/\btype=(?:"number"|\{"number"\}|\{[^}]*"number")/.test(el)) continue;
    const line = src.slice(0, m.index!).split("\n").length;
    if (allowed(line, el.split("\n").length)) continue;
    out.push({ file, line, what: 'a bare <input type="number">: it drops a comma it does not understand ("1,5" kept as 15). Use <NumberInput>' });
  }
  // A props object with type "number" that a helper spreads into a bare <input>.
  if (/<input\b[^>]*\{\.\.\.\w+\}/.test(src)) {
    const srcLines = src.split("\n");
    for (let i = 0; i < srcLines.length; i++) {
      if (!/\btype:\s*"number"/.test(srcLines[i]!) || !/\w+\([^)]*\{[^}]*\btype:\s*"number"/.test(srcLines[i]!)) continue;
      const helper = srcLines[i]!.match(/(\w+)\([^)]*\{[^}]*\btype:\s*"number"/)?.[1];
      const body = helper ? src.match(new RegExp(`(?:const|function)\\s+${helper}\\b[\\s\\S]{0,600}?(?:\\n\\s*\\);|\\n\\s*\\})`))?.[0] : undefined;
      if (!body || !/<input\b[^>]*\{\.\.\.\w+\}/.test(body) || /NumberInput/.test(body)) continue;
      if (allowed(i + 1, 1)) continue;
      out.push({ file, line: i + 1, what: `type: "number" handed to ${helper}(), which spreads it into a bare <input>. Draw <NumberInput> there for a number` });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:numbers-are-typed-into-number-input - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Swap <input type=\"number\"> for <NumberInput> from @cobblr/platform-web: same props, e.target.value is the plain number text");
  process.exit(1);
}
console.log(`lint:numbers-are-typed-into-number-input OK`);
