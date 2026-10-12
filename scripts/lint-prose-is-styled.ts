#!/usr/bin/env tsx
// A prose class only ships where the app styles it: web/src/index.css gives .prose headings, lists, quotes and code their look, or the Typography plugin is installed.
//
// THE BUG THIS PREVENTS. 2026-10-12 #6069: the Knowledge Base preview showed a heading as body text and a list without bullets; the prose class was used in six places and no Typography plugin or .prose rule existed, so every one was inert.
//
// THE RULE. A source file that sets a Typography size class (prose-sm, prose-base,
// prose-lg …) needs something to give `prose` its look: the @tailwindcss/typography
// plugin in web/package.json, or rules in web/src/index.css for `.prose` headings,
// lists, quotes and code. Neither present is one violation, reported at the first
// use. A comment that mentions the word is not a use.
//
// THE BOUNDARY. Only the size classes count as a use: every real wrapper carries
// one, and the bare word "prose" turns up in comments and sentences.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-prose-is-styled.ts   (pnpm lint prose-is-styled)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules", "packages/platform-web/src", "web/src"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

const CSS = "web/src/index.css";
const WEB_PACKAGE = "web/package.json";
const STYLED_BY_CSS = [".prose h2", ".prose ul", ".prose ol", ".prose blockquote", ".prose pre"];
const USE = /\bprose-(?:sm|base|lg|xl|2xl)\b/;

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

/** Where `prose` is relied on in one file (1-based lines). */
export function usesOf(src: string): number[] {
  const out: number[] = [];
  src.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (USE.test(line)) out.push(i + 1);
  });
  return out;
}

/** What is missing for `prose` to look like anything; empty when it is styled. */
export function proseGaps(css: string, webPackage: string): string[] {
  if (/@tailwindcss\/typography/.test(webPackage)) return [];
  return STYLED_BY_CSS.filter((sel) => !css.includes(sel));
}

const violations: Violation[] = [];
const gaps = proseGaps(readFileSync(CSS, "utf8"), readFileSync(WEB_PACKAGE, "utf8"));
if (gaps.length) {
  for (const root of ROOTS)
    for (const file of walk(root)) {
      const [first] = usesOf(readFileSync(file, "utf8"));
      if (first && violations.length === 0)
        violations.push({ file, line: first, what: `uses prose-* but ${CSS} has no rule for ${gaps.join(", ")} and the Typography plugin is not installed, so it styles nothing` });
    }
}

if (violations.length) {
  console.error(`lint:prose-is-styled - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:prose-is-styled OK`);
