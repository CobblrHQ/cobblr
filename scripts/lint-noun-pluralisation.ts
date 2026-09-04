// lint:noun-pluralisation — a noun that came from a workspace is never pluralised
// by sticking an "s" on it.
//
// `${noun}s` is correct whenever the author wrote the noun themselves. It is
// wrong the moment the noun is DATA: an instance's item_noun, a user's label, a
// bundle's word. Those produced "18 inventorys" on the dashboard, and
// `pluralise()` was written to fix it. Then nothing made anyone use it, so a
// year later twenty sites still concatenated, including the empty state under a
// Bookshelf (reported 2026-09-03: "didn't we fix this entire class?").
//
// This is that "make anyone use it". It flags a template or JSX expression that
// appends a bare "s" to an identifier whose NAME says it holds a noun
// (noun, itemNoun, nounPlural, singular, ...). Anything else is left alone: the
// ~180 author-written plurals in this repo are fine and are not the class.
//
// Use `pluralise(noun)` for the word, or `countOf(n, noun)` when a number is in
// front of it. Both are in @cobblr/platform-contract.

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * An identifier that plainly holds a WORD SOMEBODY ELSE CHOSE.
 *
 * The first version only knew noun-shaped names, and missed
 * `plural = str(args.plural) || \`${name}s\`` in the rename action - a word a
 * person typed into chat, pluralised by hand, which is the whole class. So
 * `name` / `label` / `title` / `word` are in the list too: those hold user text
 * far more often than they hold an author's own constant, and the escape hatch
 * is one comment for the rare case that they do not.
 */
const NOUN_IDENT =
  /^(?:\w*[iI]tem)?[nN]oun\w*$|^(?:singular|plural)\w*$|^\w+Noun$|^(?:name|label|title|word|thing|kindLabel|displayName)$|^\w+(?:Name|Label|Title|Word)$/;

// `${x}s` in a template, and `{x}s` in JSX text.
const PATTERNS = [
  /\$\{\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\}s\b/g,
  /\{\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*\}s\b/g,
];

const files = globSync("{web/src,packages/*/src,modules/*/src,api/src}/**/*.{ts,tsx}", {
  cwd: ROOT,
}).filter((f) => !f.includes("node_modules") && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

const seen = new Set<string>();
const problems: string[] = [];
for (const rel of files) {
  const src = readFileSync(`${ROOT}/${rel}`, "utf8");
  if (rel.endsWith("plural.ts")) continue; // the helper itself explains the rule
  src.split("\n").forEach((line, i) => {
    if (/lint-noun-pluralisation-ok/.test(line)) return;
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        const ident = (m[1] ?? "").split(".").pop() ?? "";
        if (!NOUN_IDENT.test(ident)) continue;
        const at = `${relative(ROOT, `${ROOT}/${rel}`)}:${i + 1}`;
        if (seen.has(at)) continue;
        seen.add(at);
        problems.push(`${at}  ${line.trim().slice(0, 140)}`);
      }
    }
  });
}

if (problems.length) {
  console.error("lint:noun-pluralisation FAILED\n");
  console.error("  A noun that came from a workspace cannot be pluralised with a bare \"s\".");
  console.error("  It produced \"18 inventorys\" once already. Use pluralise(noun), or");
  console.error("  countOf(n, noun) when a number goes in front, from @cobblr/platform-contract.\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("\n  A genuinely author-written plural can say // lint-noun-pluralisation-ok");
  process.exit(1);
}
console.log(`lint:noun-pluralisation OK — no workspace noun is pluralised by hand (${files.length} files).`);
