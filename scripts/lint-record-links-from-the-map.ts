#!/usr/bin/env tsx
// A link to a record is built by the contract's address map (resolveDetailPath, recordHref), never hand-assembled from a module's route
//
// THE BUG THIS PREVENTS. In Locations, What's here listed a Home Inventory
// item, and tapping it opened "part not found" (2026-09-24, #3623). The row
// named the item's base kind, inventory:part, and the page spliced its id into
// that kind's registry route, /inventory/parts/{id}, which only reaches the
// default collection. Search, tags, the calendar, the create dialogs of three
// pages and three resolvers each built the same addresses by hand, each with
// its own idea of where a collection's items live (one sent machines to
// /<collection>?machine=, the map says /instances/<collection>?machine=).
//
// THE RULE. A link to a record comes from the contract's address map
// (packages/platform-contract/src/instance-detail.ts): `resolveDetailPath` on
// the server and in a module's own page, `recordHref` (the row's detailUrl,
// else the open door for a base kind of a module with collections, else the
// kind's template) on a surface. Hand-built shapes fail: a module's item route
// with an id spliced in (`/inventory/parts/${id}`, `/assets/${id}`), a
// collection's `?asset=${id}` / `?machine=${id}` / `?record=${id}` or
// `/instances/${n}/items/${id}`, and a registry template spliced with
// `.replace("{id}", ...)`. A module's own page opening its own default record
// in place may say so with `// RECORD-LINK-OK: <why>`.
//
// THE BOUNDARY. The same shapes are also API paths (`/orgs/${slug}/...`,
// `this.request(..., `/projects/${id}/extract-pattern`)`); a line in a call
// passes, the api's in-process doors (apiFetch, selfFetch) as much as fetch. Purchases has no collections, so its one address is not judged.
//
//   npx tsx scripts/lint-record-links-from-the-map.ts   (pnpm lint record-links-from-the-map)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "web/src", "packages/platform-web/src"];
const HOME = join("packages", "platform-contract", "src", "instance-detail.ts");

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
/** A record's address assembled by hand: a module's item route with an id
 *  spliced in. */
const HAND_BUILT = [
  /`\/(inventory\/parts|assets|machines|records|projects|projects\/tasks)\/\$\{/,
  // A registry template spliced by a surface: a base kind's template knows no collection.
  /\.replace\(\s*["']\{id\}["']/,
  /\?(asset|machine|record)=\$\{/,
  /\/instances\/\$\{[^}]+\}\/items\/\$\{/,
];
/** The same shapes are also the module's own API paths; a call is not a link. */
const API_CALL = /\/api\/v1|\/orgs\/\$\{|\brequest\s*[(<]|\b(?:fetch|apiFetch|selfFetch)\s*\(|\bpostToModulePath\b/;

function check(file: string, src: string): Violation[] {
  if (file === HOME) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!HAND_BUILT.some((re) => re.test(line))) continue;
    // A call spreads its path over lines: `this.request<X>(\n "POST",\n `/projects/${id}/...``.
    if (API_CALL.test(lines.slice(Math.max(0, i - 2), i + 1).join("\n"))) continue;
    const near = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    if (/RECORD-LINK-OK: \S/.test(near)) continue;
    out.push({ file, line: i + 1, what: "a record's address built by hand; take it from resolveDetailPath / recordHref so it follows the record's collection" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:record-links-from-the-map - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:record-links-from-the-map OK`);
