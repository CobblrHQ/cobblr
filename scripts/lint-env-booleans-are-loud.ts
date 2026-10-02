#!/usr/bin/env tsx
// An env flag is parsed by z.enum(["true","false"]) with a transform, never z.coerce.boolean(): a wrong value is refused at boot by name, never coerced to true.
//
// THE BUG THIS PREVENTS. COBBLR_TRY_SANDBOX=false turned the no-account
// sandbox ON. z.coerce.boolean() is Boolean(string), and every non-empty
// string is true: "false", "0", "no", "off", a typo. The comment above the
// line promised "OFF unless COBBLR_TRY_SANDBOX=true, so prod / staging /
// self-host never hand out an anonymous workspace", which is the exact
// invariant the line beneath it failed to implement. The person most likely
// to write =false is the careful one who read the docs and set it rather
// than trusting the default; they got an anonymous workspace handed out and
// nothing told them, while somebody who never heard of the variable was
// safe (#3303, 2026-09-20, found while proving a booth test red).
//
// THE RULE. Under api/src and packages/*/src, no `z.coerce.boolean(`. An env
// flag is parsed as
//   z.enum(["true", "false"]).default("false").transform((v) => v === "true")
// (COBBLR_AI_ENABLED and COBBLR_DISABLE_EXPERIMENTAL_MODULES in api/src/env.ts
// are the precedent), so a wrong value fails boot naming the value and the
// two it accepts. This is the same rule as docs/architecture/platform-spec.md §14.6's `||` not `??`:
// an env var that silently takes a wrong value is invisible until it is
// expensive; a wrong value must be loud, never plausible. A genuine
// exception (a non-env boolean that really wants Boolean(x) semantics) says
// so on the line: // ALLOW-COERCE-BOOLEAN: <reason>.
//
// PROVE IT RED before you trust it green: against the tree as of fe0f065b1
// it names api/src/env.ts:130.
//
//   npx tsx scripts/lint-env-booleans-are-loud.ts   (pnpm run lint env-booleans-are-loud)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LINT_ROOT = process.env.COBBLR_LINT_ROOT || ".";
const ROOTS = ["api/src", "packages"].map((r) => join(LINT_ROOT, r));

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
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  src.split("\n").forEach((line, i) => {
    // A comment naming the trap is how the rule is remembered, not the trap.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (!/\bz\.coerce\.boolean\s*\(/.test(line)) return;
    if (/\/\/ ALLOW-COERCE-BOOLEAN: \S/.test(line)) return;
    out.push({ file, line: i + 1, what: "z.coerce.boolean() reads every non-empty string as true (\"false\" included)" });
  });
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:env-booleans-are-loud - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    'Parse the flag as z.enum(["true", "false"]).default("false").transform((v) => v === "true") (COBBLR_AI_ENABLED in api/src/env.ts is the precedent); a typo then fails boot with the value and the two it accepts.',
  );
  process.exit(1);
}
console.log(`lint:env-booleans-are-loud OK`);
