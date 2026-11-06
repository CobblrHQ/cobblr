#!/usr/bin/env tsx
// An edit form seeded from a record judges its Save against that record as it opened, not the copy a refresh just handed it.
//
// THE BUG THIS PREVENTS. Knowledge's form read another tab's rename as its own change once the list refreshed, and Save put the old title back, answering Saved (2026-11-06).
//
// THE RULE. A form whose fields start from a record, and which hands that same
// record to editOf, holds it as it opened: `const record = useRecordAsOpened(shown)`,
// or a useState of its own that it sets when it opens or saves. A form that cannot
// go stale says why with an annotation: EDIT-FORM-OK: <why>.
//
// THE BOUNDARY. Only a name both seeds a useState and goes to editOf. A form whose
// fields start blank, and editOf({ metadata: fields }, ...) on state the form itself
// keeps, are not this: neither can read a refresh as the person's change.
//
//   npx tsx scripts/lint-edit-forms-judge-what-they-opened-on.ts   (pnpm lint edit-forms-judge-what-they-opened-on)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules", "web/src", "packages/platform-web/src"];

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
  if (!src.includes("editOf(") || src.includes("EDIT-FORM-OK:")) return [];
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(/\beditOf\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
    const name = m[1]!;
    const n = name.replace(/\$/g, "\\$");
    // Its fields start from it: useState(tag.name), useState(tag?.name ?? "").
    const seeded = new RegExp(`useState(?:<[^>]*>)?\\(\\s*(?:\\(\\)\\s*=>\\s*)?${n}[?!]?\\.`).test(src);
    if (!seeded) continue;
    // Held: from the hook, or a useState of its own the form sets when it opens.
    const held = new RegExp(`const\\s+${n}\\s*=\\s*useRecordAsOpened\\(|const\\s+\\[\\s*${n}\\s*,`).test(src);
    if (held || seen.has(name)) continue;
    seen.add(name);
    out.push({ file, line: src.slice(0, m.index).split("\n").length, what: `editOf(${name}, ...) in a form whose fields start from ${name}: a refresh makes its older values read as this form's change` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:edit-forms-judge-what-they-opened-on - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Hold it: const record = useRecordAsOpened(shown), and pass that to editOf. Not a form that can go stale? Say so: EDIT-FORM-OK: <why>.");
  process.exit(1);
}
console.log(`lint:edit-forms-judge-what-they-opened-on OK`);
