#!/usr/bin/env tsx
// A store's order page link is opened only where it is read: link_sealed is named in modules/purchases/src/order-page/store.ts alone, and no log line there or in the reader prints a link.
//
// THE BUG THIS PREVENTS. A store's View order link signs the buyer in (#5461, 2026-10-09); one logged URL or one route returning the row would hand that sign-in to anyone reading logs or the API.
//
// THE RULE. Under modules/purchases/src:
//   - the table purchases_order_pages is read (selectFrom) and its column
//     link_sealed named only in order-page/store.ts, the one file that opens
//     a link, so no route can select the row and answer with it (db.ts, the
//     table's type, is exempt);
//   - in the files that hold an open link (order-page/store.ts,
//     order-page/shopify.ts, api/order-pages.ts) no console line names a
//     link, url or href.
// A genuine exception says why on the line: // ALLOW-ORDER-PAGE: <reason>.
//
// THE BOUNDARY. Writes stay free elsewhere on purpose: insertInto and
// updateTable carry no link out. Nothing has tested the edge yet.
//
// PROVED RED 2026-10-09 against a route that selected the row
// (selectFrom("purchases_order_pages").selectAll() in api/orders.ts) and a
// console.error printing the link in store.ts.
//
//   npx tsx scripts/lint-order-page-link-stays-sealed.ts   (pnpm lint order-page-link-stays-sealed)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules/purchases/src"];

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
  const lines = src.split("\n");
  const rel = file.split(/[\\/]/).join("/");
  const opener = rel.endsWith("order-page/store.ts");
  const holdsLink = opener || rel.endsWith("order-page/shopify.ts") || rel.endsWith("api/order-pages.ts");
  const typeFile = rel.endsWith("src/db.ts");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\/\/ ALLOW-ORDER-PAGE: \S/.test(line)) continue;
    if (!opener && !typeFile && /link_sealed|selectFrom\(\s*["']purchases_order_pages["']/.test(line)) {
      out.push({ file, line: i + 1, what: "reads the sealed order page link outside order-page/store.ts" });
    }
    if (holdsLink && /console\.(log|info|warn|error|debug)\(/.test(line) && /\b(link|url|href)\b/i.test(line)) {
      out.push({ file, line: i + 1, what: "a log line that names a link, in a file that holds an open one" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:order-page-link-stays-sealed - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:order-page-link-stays-sealed OK`);
