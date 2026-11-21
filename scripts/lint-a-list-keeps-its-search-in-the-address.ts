#!/usr/bin/env tsx
// A list page (one that renders CollectionHeader) keeps its search in the address through useListSearch from @cobblr/platform-web, never in the page's own state, so Back from a record finds the list as it was left.
//
// THE BUG THIS PREVENTS. A parts list searched on a phone came back unsearched, scrolled to the top, after a part was opened and Back pressed (2026-11-20, #4115)
//
// THE RULE. A .tsx file that renders <CollectionHeader (a list page) and
// holds a search in its own state (`const [query|search|q|filter, set…] =
// useState("")`) fails: the search is gone when the page is, and Back from a
// record comes back to the whole list at its top. useListSearch keeps it in
// the history entry (never the address, which is sent on as a Referer). A genuine exception says why on a `// search-not-kept:`
// line, on the state's line or the one above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A search inside a dialog or
// a picker on the same page is a different box and has its own name; only the
// four names a list's own search goes by are judged. A list page with no
// search state at all passes.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-list-keeps-its-search-in-the-address.ts   (pnpm lint a-list-keeps-its-search-in-the-address)
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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!file.endsWith(".tsx") || !/<CollectionHeader\b/.test(src)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  const re = /const \[(query|search|q|filter), set(Query|Search|Q|Filter)\] = useState(<string>)?\(""\)/g;
  for (const m of src.matchAll(re)) {
    const line = src.slice(0, m.index).split("\n").length;
    if (/\/\/ search-not-kept: \S/.test(`${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`)) continue;
    out.push({ file, line, what: `a list's search held in page state (${m[1]}): Back from a record loses it. Use useListSearch` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-list-keeps-its-search-in-the-address - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("const [query, setQuery] = useListSearch(\"q\"); or // search-not-kept: <why the list needs none>");
  process.exit(1);
}
console.log(`lint:a-list-keeps-its-search-in-the-address OK`);
