#!/usr/bin/env tsx
// Every .tsx the app draws (web/src, modules, packages) lies inside a Tailwind content glob, so a class written only there is in the CSS.
//
// THE BUG THIS PREVENTS. #6165 (2026-10-13): a linked list line's dark ground, dark:bg-emerald-900/30, was written only in modules/lists, which Tailwind did not read; the dark theme drew pale green text on the light ground, 1.45:1
//
// THE RULE. Every tracked .tsx under web/src, modules/ and packages/
// (tests aside) matches one of the content globs in web/tailwind.config.js,
// read from the config itself, so the check and the build never disagree.
//
// THE BOUNDARY. Only .tsx: a class string in a plain .ts is still read when
// it sits inside a glob, but a module draws its UI in .tsx, and a .ts outside
// every glob (an API file) has no classes to lose. Nothing has tested this
// edge yet.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-tailwind-sees-every-ui-file.ts   (pnpm lint tailwind-sees-every-ui-file)
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { repoFiles } from "./lib/repo-files.ts";

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

/** A content glob (relative to web/) as a regex over a repo path: "**\/"
 *  is any depth, "*" one segment, "{a,b}" either. */
export function globToRegExp(glob: string): RegExp {
  const repo = posix.normalize(posix.join("web", glob));
  let re = "";
  for (let k = 0; k < repo.length; k++) {
    const c = repo[k]!;
    if (repo.startsWith("**/", k)) { re += "(?:.*/)?"; k += 2; }
    else if (c === "*") re += "[^/]*";
    else if (c === "{") { const end = repo.indexOf("}", k); re += `(?:${repo.slice(k + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`; k = end; }
    else re += c.replace(/[.+^$()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The content globs, read from the config's source: an array of strings
 *  after "content:". */
export function contentGlobs(config: string): string[] {
  const m = config.match(/content:\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** The check. Every file outside every glob. */
export function check(files: string[], globs: string[]): Violation[] {
  const res = globs.map(globToRegExp);
  return files
    .filter((f) => !res.some((r) => r.test(f)))
    .map((file) => ({ file, line: 1, what: "Tailwind does not read this file: a class written only here is not in the CSS" }));
}

if (process.argv[1] && /lint-tailwind-sees-every-ui-file/.test(process.argv[1])) {
const files = repoFiles([":(glob)web/src/**/*.tsx", ":(glob)modules/**/*.tsx", ":(glob)packages/**/*.tsx"]).filter((f) => !/\.test\.tsx$/.test(f));
const violations = check(files, contentGlobs(readFileSync("web/tailwind.config.js", "utf8")));

if (violations.length) {
  console.error(`lint:tailwind-sees-every-ui-file - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Widen content in web/tailwind.config.js (modules/*/src and packages/*/src are read whole); never list modules one by one");
  process.exit(1);
}
console.log(`lint:tailwind-sees-every-ui-file OK`);
}
