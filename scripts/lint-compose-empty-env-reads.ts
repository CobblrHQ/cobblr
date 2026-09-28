#!/usr/bin/env tsx
// A setting any compose file forwards as ${NAME:-} is never read with Number() or a non-empty ?? fallback, because it arrives as an empty string.
//
// THE BUG THIS PREVENTS. b11714fb2 (2026-08-13) forwarded the sandbox tuning keys from docker-compose.yml; pool.ts read Number(process.env.X ?? 64), so a stack run from the file got 0 workers, a 0 ms deadline and a 0 ms CPU quota (found 2026-09-26, #3734)
//
// THE RULE. Collect every NAME a tracked compose file forwards as `${NAME:-}` (empty
// default). In api/src, modules/*/src and packages/*/src (tests excluded), a read of
// such a NAME fails when it is `Number(process.env.NAME ...)`, or
// `process.env.NAME ?? <x>` with x anything but an empty string or undefined: both
// turn the "" compose delivers into 0 or into "" where the author meant a default.
// Passes: envNumber("NAME", n) (packages/platform-contract/src/env-number.ts),
// `process.env.NAME || x`, `process.env.NAME?.trim()`, `?? ""`. No opt-out: a key
// compose forwards empty is always read as possibly "".
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only compose-forwarded names: a
// `Number(process.env.X ?? 4)` whose X no compose file forwards (SANDBOX_MAX_
// CONCURRENCY_PER_WS) cannot arrive as "" from a stack and is left alone. And
// `?? ""` inside a template literal (`Bearer ${process.env.TOKEN ?? ""}`) is
// harmless: "" and the fallback are the same thing.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-compose-empty-env-reads.ts   (pnpm lint compose-empty-env-reads)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.js";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src/", "modules/", "packages/"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

const tracked = (): string[] => repoFiles();

/** Every NAME a tracked compose file forwards with an empty default. */
export function forwardedEmpty(files: { path: string; text: string }[]): Set<string> {
  const keys = new Set<string>();
  for (const f of files) for (const m of f.text.matchAll(/\$\{([A-Z][A-Z0-9_]*):-\}/g)) keys.add(m[1]!);
  return keys;
}

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string, keys: Set<string>): Violation[] {
  const out: Violation[] = [];
  const re = /(Number\(\s*)?process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])(\s*\?\?\s*([^,;)}`\n]+))?/g;
  for (const m of src.matchAll(re)) {
    const key = m[2] || m[3];
    if (!key || !keys.has(key)) continue;
    const fallback = (m[5] ?? "").trim();
    const numeric = Boolean(m[1]);
    const badFallback = Boolean(m[4]) && !/^(""|''|undefined)$/.test(fallback);
    if (!numeric && !badFallback) continue;
    out.push({
      file,
      line: src.slice(0, m.index).split("\n").length,
      what: numeric
        ? `Number(process.env.${key}) reads the "" compose forwards as 0`
        : `process.env.${key} ?? ${fallback} never falls back: compose forwards "" (not undefined)`,
    });
  }
  return out;
}

const violations: Violation[] = [];
const files = tracked();
const keys = forwardedEmpty(files.filter((f) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(f)).map((path) => ({ path, text: readFileSync(path, "utf8") })));
for (const file of files) {
  if (!ROOTS.some((r) => file.startsWith(r)) || !/\.(ts|mts|js|mjs)$/.test(file) || /\.test\.|\/tests?\//.test(file)) continue;
  violations.push(...check(file, readFileSync(file, "utf8"), keys));
}

if (violations.length) {
  console.error(`lint:compose-empty-env-reads - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("read it with envNumber() from @cobblr/platform-contract/env-number, or || instead of ??");
  process.exit(1);
}
console.log(`lint:compose-empty-env-reads OK`);
