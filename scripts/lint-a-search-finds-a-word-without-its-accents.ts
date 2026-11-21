#!/usr/bin/env tsx
// A page that filters by what a person typed compares through textHas or foldForSearch from platform-contract, never a plain toLowerCase and includes, so a word typed without its accents finds the thing that has them.
//
// THE BUG THIS PREVENTS. A recipe titled 'Crème brûlée' could not be found on a phone by typing 'creme' in the knowledge base search (2026-11-21, #4115)
//
// THE RULE. In page code (web/src, a module's src/ui, platform-web), a match
// written as `x.toLowerCase().includes(y)`, or as `hay.includes(y.toLowerCase())`,
// is a search the person's keyboard can miss: it has no accents to type. It
// goes through textHas(text, typed) or compares foldForSearch on both sides.
// A comparison that is not a person's search (a status word, a file
// extension) says so on a `// plain-match-ok:` line, on its own line or the
// one above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A list of fixed words
// matched with `[...].includes(x.toLowerCase())` is not a search (the laser's
// status words), so a receiver that is an array literal is not judged. A
// variable lowercased on one line and matched on another is not seen; the
// rewrite of every page filter to textHas left none. Tests are not judged; a
// word in a comment is not code (stripComments).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-search-finds-a-word-without-its-accents.ts   (pnpm lint a-search-finds-a-word-without-its-accents)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { stripComments } from "./lib/source-scan.ts";

const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

const PLAIN = [/\.toLowerCase\(\)\.includes\(/, /[\w)]\.includes\([^;]*\.toLowerCase\(\)\s*\)/];

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
  // Under modules/, only a module's own pages: its server code searches in SQL.
  if (file.startsWith("modules/") && !/\/src\/ui\//.test(file)) return [];
  const lines = src.split("\n");
  const out: Violation[] = [];
  stripComments(src).split("\n").forEach((l, i) => {
    if (!PLAIN.some((re) => re.test(l))) return;
    if (/plain-match-ok: \S/.test(`${lines[i - 1] ?? ""}\n${lines[i]}`)) return;
    out.push({ file, line: i + 1, what: "a typed search compared with a plain toLowerCase: a word typed without its accents misses" });
  });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-search-finds-a-word-without-its-accents - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("textHas(text, typed) or foldForSearch on both sides (@cobblr/platform-contract/search-text), or // plain-match-ok: <why this is not a person's search>");
  process.exit(1);
}
console.log(`lint:a-search-finds-a-word-without-its-accents OK`);
