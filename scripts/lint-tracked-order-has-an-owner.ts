#!/usr/bin/env tsx
// An order written with a tracking number also records who added it, so the arrival sweep asks that person alone instead of every member.
//
// THE BUG THIS PREVENTS. purchases:plan-order inserted fab orders with tracking and no owner, so arrival questions went to the whole workspace (2026-10-06)
//
// THE RULE. A Kysely insertInto/updateTable on purchases_orders whose values
// name `tracking_number:` must also name `tracking_added_by_user_id` in the
// same statement (up to its .execute). parcelAudience falls back to EVERY
// member when the owner is null, so an ownerless tracked order turns one
// person's parcel into everybody's notification. A write that genuinely has
// nobody to own it opts out with `// TRACKING-OWNER: <why>` inside the
// statement.
//
// THE BOUNDARY. Spreads (`...parsed.data`) are not read: the orders route
// spreads its body and sets the owner explicitly beside it, and a spread that
// forgot would carry no literal `tracking_number:` for this to see. Only the
// table that parcelAudience reads is held; receipts in core-scan carry their
// own owner column and fall back to their creator first.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-tracked-order-has-an-owner.ts   (pnpm lint tracked-order-has-an-owner)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules"];

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
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const re = /\.(insertInto|updateTable)\(\s*"purchases_orders"\s*\)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = src.indexOf(".execute", m.index);
    const stmt = src.slice(m.index, end === -1 ? m.index + 2000 : end);
    if (!/\btracking_number\s*:/.test(stmt)) continue;
    if (/tracking_added_by_user_id/.test(stmt) || /\/\/ TRACKING-OWNER: \S/.test(stmt)) continue;
    out.push({ file, line: src.slice(0, m.index).split("\n").length, what: "writes tracking_number without tracking_added_by_user_id" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:tracked-order-has-an-owner - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:tracked-order-has-an-owner OK`);
