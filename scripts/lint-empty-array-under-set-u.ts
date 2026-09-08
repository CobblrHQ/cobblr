#!/usr/bin/env tsx
// A shell script that runs under set -u never expands an array that may be empty without the plus guard, because bash 3.2 on macOS calls that unbound.
//
// THE BUG THIS PREVENTS. scripts/view-as.sh died on every Mac with 'op[@]: unbound variable' (2026-09-08): an optional --operator flag lived in an array that was empty by default, and the one command meant to replace ssh-and-poke could not even list workspaces.
//
// THE RULE. State it so the next reader can tell a violation from a false
// positive without running the script. Say what passes, what fails, and how
// a genuine exception opts out (an annotation with a reason, never a
// baseline that grows).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-empty-array-under-set-u.ts   (pnpm run lint:empty-array-under-set-u)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["scripts", ".forgejo", "docker"];

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
    else if (/\.sh$/.test(name) || (!/\./.test(name) && p.includes("git-hooks"))) yield p;
  }
}

/** Arrays this script declares empty (`name=()` / `local name=()`), so a
 *  bare `"${name[@]}"` is unbound under `set -u` on bash 3.2 (macOS) whenever
 *  nothing was pushed. The guarded form `${name[@]+"${name[@]}"}` expands to
 *  nothing instead. Only scripts that opt into nounset are judged. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (!/^\s*set\s+(-[a-zA-Z]*u[a-zA-Z]*|-o\s+nounset)/m.test(src)) return out;
  const declared = new Set<string>();
  for (const m of src.matchAll(/(?:^|[^\w])(?:local\s+|declare\s+-a\s+)?([A-Za-z_][A-Za-z0-9_]*)=\(\)/g)) declared.add(m[1]!);
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const m of line.matchAll(/"\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"/g)) {
      const name = m[1]!;
      if (!declared.has(name)) continue;
      const before = line.slice(0, m.index ?? 0);
      if (before.endsWith(`\${${name}[@]+`)) continue;
      out.push({ file, line: i + 1, what: `"\${${name}[@]}" may be empty under set -u; write \${${name}[@]+"\${${name}[@]}"}` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:empty-array-under-set-u - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Expand a possibly-empty array as ${arr[@]+\"${arr[@]}\"}, which is empty under bash 3.2 instead of unbound.");
  process.exit(1);
}
console.log(`lint:empty-array-under-set-u OK`);
