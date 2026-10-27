#!/usr/bin/env tsx
// A bundle declares no field for who has a thing or when it is due back; that is the platform loan (Lend on the record), and a second field for it is never filled by the loan.
//
// THE BUG THIS PREVENTS. The Tool Library bundle added Borrower and Due back fields that stayed blank while a tool was lent out and overdue (#8627, 2026-10-27).
//
// THE RULE. For every bundles/*.json manifest, no field_defs entry (top-level
// or under an instance) is named borrower, borrowed_by, lent_to, loaned_to,
// checked_out_to, due_back or lent_until. A loan (platform:lend, docs/design-
// decisions/record-loans.md) is the one record of who has a thing and until
// when; it reaches the calendar, Needs you and It's back, and a field beside
// it only goes stale. A genuine exception renames its field to what it really
// is (a deposit, a condition), never keeps the loan's own words.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. `due_date` is not on the
// list: small-shop's invoice due date is not a loan. Nothing else has tested
// the boundary yet.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-bundle-does-not-redeclare-the-loan.ts   (pnpm lint a-bundle-does-not-redeclare-the-loan)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites: the generated bundle manifests. */
const ROOTS = ["bundles"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isFile() && /^[^.]+\.json$/.test(name) && !name.endsWith(".lock.json")) yield p;
  }
}

/** What a loan already says: who has the thing, and the day it is due back. */
const LOAN_FIELD = /^(borrower|borrowed_by|lent_to|loaned_to|checked_out_to|due_back|lent_until)$/;

/** Every field_defs array in a manifest: the top-level one and each instance's. */
function* fieldDefs(node: unknown): Generator<{ name?: string }> {
  if (Array.isArray(node)) {
    for (const n of node) yield* fieldDefs(n);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "field_defs" && Array.isArray(v)) yield* v as Array<{ name?: string }>;
      else yield* fieldDefs(v);
    }
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (const def of fieldDefs(JSON.parse(src))) {
    if (!def.name || !LOAN_FIELD.test(def.name)) continue;
    const at = lines.findIndex((l) => l.includes(`"name": "${def.name}"`));
    out.push({ file, line: at + 1, what: `declares a "${def.name}" field; who has a thing and when it is due back is the platform loan (Lend on the record)` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-bundle-does-not-redeclare-the-loan - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Drop the field: the loan is the record of who has it and until when. A field that is truly about something else carries a name that says so.");
  process.exit(1);
}
console.log(`lint:a-bundle-does-not-redeclare-the-loan OK`);
