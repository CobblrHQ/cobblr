#!/usr/bin/env tsx
// A sentence never writes a or an in front of a noun that is data; withArticle picks the article from the noun.
//
// THE BUG THIS PREVENTS. The Small shop's order board, the first screen after
// its install, read "Add your first order. Nothing here yet. Add a order by
// hand" (2026-09-29 staging walk, #4146). The empty view wrote `Add a ${noun}`,
// and the noun was data: a collection's item noun. The same shape was in
// fifteen more places, every one of them fine for "part" and wrong for
// "order", "item", "egg" or an Inventory: the Add button on a list, Cobb's
// "Adding a …" line, the wire composer's "When a … is created".
//
// THE RULE. In UI code, a literal "a " or "an " directly in front of an
// interpolation (`a ${noun}` in a string, `a {noun}` in JSX) fails. Write
// `${withArticle(noun)}` (`@cobblr/platform-contract/plural`) instead, which
// picks a or an from the noun's sound. There is no opt-out: withArticle is
// right for every word, a number included, so an exception can only ever be
// wrong later.
//
// WHY NO OPT-OUT. The first version had one, and all three of its uses were
// wrong or about to be: an invite's pace ("at most 5 a ${period}", which says
// "a hour" the day an hour is offered), and the machine words ("to a
// ${manager}"), a closed list until an "embroidery machine" or "OctoPrint"
// joins it. Each said "the author knows the article", which holds only until
// the list grows. THE BOUNDARY: a bundle's help
// text `Open a {{noun}}` is a runtime template filled elsewhere, not code
// interpolation, so a double brace is out of scope. api/src is out of
// scope: its strings are log lines, and the few user-facing ones read nouns
// the module named itself.
//
// PROVEN RED on the tree before this change: 23 hits, among them
// ViewEmptyState's "Add a {noun}".
//
//   npx tsx scripts/lint-article-before-data-noun.ts   (pnpm lint article-before-data-noun)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
    if (name === "node_modules" || name === "dist" || name === "migrations" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const ARTICLE_BEFORE_DATA = /(^|[\s"'`>(])[Aa]n? (\$\{|\{(?!\{))(?!\s*\/\*)/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (!ARTICLE_BEFORE_DATA.test(line)) continue;
    out.push({ file, line: i + 1, what: `"a"/"an" written before an interpolated noun: use withArticle(noun)` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:article-before-data-noun - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Write ${withArticle(noun)} (@cobblr/platform-contract/plural); it is right for every word and number, so there is no opt-out.");
  process.exit(1);
}
console.log(`lint:article-before-data-noun OK`);
