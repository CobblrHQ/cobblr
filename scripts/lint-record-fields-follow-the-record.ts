#!/usr/bin/env tsx
// A field editor over a record's value drafts through useFieldDraft, so the open record shows what an action did to it
//
// THE BUG THIS PREVENTS. In Groceries, Restock one on whole milk's open
// detail moved the table behind it to quantity 2, bought today, while the
// detail itself went on saying 1 and the old date, however long anyone waited;
// closing and reopening it showed the truth (2026-09-24, #3615). The detail's
// query was refreshed. Its fields were not: each took the record's value once
// (an input's `defaultValue`, or `useState(initial)`) and never looked again,
// and the next blur on one of them compared the stale text with the new value
// and could write the old one back over what the action did.
//
// THE RULE. In the web app, the shared web package and every module's UI, a
// field editor drafts through `useFieldDraft` (packages/platform-web), which
// follows the record while the field is untouched and keeps the person's
// draft while they type. `defaultValue=` and `useState(initial)` /
// `useState(value)` fail, unless a `// DRAFT-OK: <why>` sits on the line or
// within the three above. The reason must say why nothing else moves that
// value while the input lives: an editor mounted only while the person is
// editing (a table cell opened for typing), or a setting that is not a
// record's value (a field definition's label on a settings page).
//
// THE BOUNDARY. `useState(initial)` in a hook or a form that is not over a
// record still matches by name; those carry DRAFT-OK with their reason (the
// person's own profile form, the scan correction form). Tests are not judged.
// A draft seeded under another name (`useState(props.qty)`) is not caught;
// the test "an item's open detail shows the result of an action run from it"
// is the backstop for the shared editors.
//
//   npx tsx scripts/lint-record-fields-follow-the-record.ts   (pnpm lint record-fields-follow-the-record)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
const DRAFT_FROM_VALUE = /\bdefaultValue=|\buseState\((initial|value)\)/;

function check(file: string, src: string): Violation[] {
  // Module code outside its UI (api handlers, migrations) renders nothing.
  if (file.startsWith("modules/") && !/\/src\/ui\//.test(file)) return [];
  if (file.endsWith("use-field-draft.ts")) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = DRAFT_FROM_VALUE.exec(line);
    if (!m) continue;
    // A type that names the prop to leave it out is not an editor.
    if (/"defaultValue"/.test(line)) continue;
    const near = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    if (/DRAFT-OK: \S/.test(near)) continue;
    out.push({ file, line: i + 1, what: `${m[0]} takes the record's value once; draft through useFieldDraft, or say why nothing moves it with // DRAFT-OK: <why>` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:record-fields-follow-the-record - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:record-fields-follow-the-record OK`);
