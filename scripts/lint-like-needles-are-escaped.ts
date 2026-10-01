#!/usr/bin/env tsx
// A LIKE pattern built from a person's text escapes it: `%${x}%` puts x through
// likeEscape (or is likeNeedle), so what was typed is matched literally.
//
// THE BUG THIS PREVENTS. The fundamentals audit of search (#4199, 2026-09-29):
// `%` and `_` are wildcards to Postgres, and the shared likeNeedle passed them
// through, as did seven hand-built patterns beside it. A search for "50%"
// matched everything holding "50", and "a_b" matched "axb". Two copies in
// core-files escaped correctly and by hand, so the rule existed, in two places.
//
// THE RULE. In a template literal, an interpolation with `%` directly before or
// after it is a LIKE pattern, and its expression starts with `likeEscape(`.
// A pattern built from something that is not a person's text (a constant
// prefix the code chose) opts out with `LIKE-OK: <why>` on the line or the
// line above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A `%` before `${` is always a
// pattern. A `%` after `}` is also every percentage in a sentence: the first
// run flagged nineteen of them (a battery gauge, "40% done", a colour stop).
// So a trailing `%` counts only when its line or the two above say `like` or
// `ilike`, which is how the one real prefix pattern (the migration runner's
// `${scope}::%`) reads. SQL written as `'%' || $1 || '%'` is not a template
// interpolation and is not seen. Tests are not judged.
//
// PROVE IT RED before you trust it green: it failed on the ten unescaped
// patterns (catalogs x2, parts x2, conversations, entries, records, the bundle
// suffix, the migration runner's prefix, likeNeedle itself) before they moved
// onto likeEscape, and on the two core-files copies that escaped by hand.
//
//   npx tsx scripts/lint-like-needles-are-escaped.ts   (pnpm lint like-needles-are-escaped)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Server code that queries a database: the api, modules, shared packages. */
const ROOTS = ["api/src", "modules", "packages"];
const OPT_OUT = /LIKE-OK: \S/;

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
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

/** `%${x}`: a contains or suffix pattern, whatever the line says. */
const LEADING = /%\$\{([^}]*)\}/g;
/** `${x}%`: a prefix pattern, but also every percentage in a sentence
 *  ("40% left"), so it counts only near a LIKE. */
const TRAILING = /\$\{([^}]*)\}%/g;
const NEAR_LIKE = /\b(i?like)\b/i;

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes("%${") && !line.includes("}%")) continue;
    const nearLike = [line, lines[i - 1] ?? "", lines[i - 2] ?? ""].some((l) => NEAR_LIKE.test(l));
    const found = [...line.matchAll(LEADING), ...(nearLike ? [...line.matchAll(TRAILING)] : [])];
    for (const m of found) {
      const expr = (m[1] ?? "").trim();
      if (expr.startsWith("likeEscape(")) continue;
      if (OPT_OUT.test(line) || OPT_OUT.test(lines[i - 1] ?? "")) continue;
      out.push({ file, line: i + 1, what: `\`${m[0]}\`: a LIKE pattern from unescaped text; use likeEscape(${expr}) or likeNeedle` });
    }
  }
  return out;
}

const violations = ROOTS.flatMap((root) => [...walk(root)].flatMap((f) => check(f, readFileSync(f, "utf8"))));
if (violations.length) {
  console.error(`lint:like-needles-are-escaped - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "`%` and `_` are wildcards to Postgres: \"50%\" matched everything holding \"50\". Build the\n" +
      "pattern with likeNeedle(q) (lower-cased, matched anywhere) or `%${likeEscape(text)}%`\n" +
      "from @cobblr/platform-contract. Not a person's text? Say so: `LIKE-OK: <why>`.",
  );
  process.exit(1);
}
console.log("lint:like-needles-are-escaped OK");
