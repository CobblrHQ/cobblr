#!/usr/bin/env tsx
// A page that sorts names compares them through compareNames from platform-contract, numbers by value and accents with their letter, never a plain localeCompare, and never re-sorts a list the server pages.
//
// THE BUG THIS PREVENTS. Things kept on a shelf listed Hex bolt M10 above M2 and M8 on a location's Stock here (2026-11-21, #4115)
//
// THE RULE. In page code (web/src, a module's src/ui, platform-web), a name,
// label, title or display name is never compared with `.localeCompare(`: a
// plain comparison reads "10" as "1" then "0". It goes through compareNames.
// A comparison that means character order on purpose says so on a
// `// sort-order-ok:` line, on its own line or the one above. A list the
// server pages is ordered by the server (#9713); re-sorting one page of it
// looks right and is wrong, so it is not done here at all.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Dates, ISO timestamps and
// ids compare correctly as text ("2026-11-21" < "2026-12-01"), so only a
// receiver whose last part names a name (name, label, title, display_name,
// displayName, holder, defaultLabel) is judged. Tests are not judged; a word
// in a comment is not code (stripComments).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-names-sort-the-way-people-count.ts   (pnpm lint names-sort-the-way-people-count)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { stripComments } from "./lib/source-scan.ts";

const ROOTS = ["web/src", "modules", "packages/platform-web/src"];
const NAME_SORT = /\.(?:name|label|title|display_name|displayName|holder|defaultLabel)\s*\.localeCompare\(/;

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

function check(file: string, src: string): Violation[] {
  if (file.startsWith("modules/") && !/\/src\/ui\//.test(file)) return [];
  const lines = src.split("\n");
  const out: Violation[] = [];
  stripComments(src).split("\n").forEach((l, i) => {
    if (!NAME_SORT.test(l)) return;
    if (/sort-order-ok: \S/.test(`${lines[i - 1] ?? ""}\n${lines[i]}`)) return;
    out.push({ file, line: i + 1, what: "names compared with a plain localeCompare: M10 sorts before M2" });
  });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:names-sort-the-way-people-count - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("compareNames(a.name, b.name) from @cobblr/platform-contract/name-compare, or // sort-order-ok: <why character order is meant>");
  process.exit(1);
}
console.log(`lint:names-sort-the-way-people-count OK`);
