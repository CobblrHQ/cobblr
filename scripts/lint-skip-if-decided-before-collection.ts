#!/usr/bin/env tsx
// A test's skipIf or runIf never reads a variable a beforeAll or beforeEach assigns, because vitest decides the skip when the file is collected, before any hook runs, so the test is skipped every time and reads green.
//
// THE BUG THIS PREVENTS. sandbox-install-happy-path skipped both its cases on every run (#9109)
//
// THE RULE. In a test file, the condition of `it/test/describe.skipIf(...)` or
// `.runIf(...)` names no variable that a `beforeAll`/`beforeEach` body assigns
// and that is declared with `let`. vitest reads the condition while it collects
// the file, so such a variable still holds its initial value: the case is
// skipped (or run) the same way every time, whatever the hook finds. Decide
// it with a top-level `const x = await ...` (top-level await runs before
// collection), or keep the case and make a missing requirement fail in the
// hook. A real exception says `// ALLOW-HOOK-SKIP: <why>` on the line.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The 186 other conditions in
// the tree read a top-level `const` set by top-level await (`!live`, `!up`,
// `!metaUp`) or the environment, and are right; the `let` requirement is what
// keeps them out. A `const` cannot be reassigned in a hook, so it never fires.
//
// PROVE IT RED: on main it names sandbox-install-happy-path.test.ts:209 and :349.
//
//   npx tsx scripts/lint-skip-if-decided-before-collection.ts   (pnpm lint skip-if-decided-before-collection)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api", "modules", "web", "packages", "scripts"];

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
    else if (/\.(test|spec)\.(ts|tsx|mjs)$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The text inside the parentheses that open at `open`. */
function parenBody(src: string, open: number): string {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")" && --depth === 0) return src.slice(open + 1, j);
  }
  return src.slice(open + 1);
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!/\.(skipIf|runIf)\s*\(/.test(src)) return [];
  const setInHook = new Set<string>();
  for (const m of src.matchAll(/\bbefore(?:All|Each)\s*\(/g)) {
    const body = parenBody(src, m.index! + m[0].length - 1);
    for (const a of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) setInHook.add(a[1]!);
  }
  const declaredLet = (name: string) => new RegExp(`\\blet\\s+(?:[^;=]*,\\s*)?${name.replace(/\$/g, "\\$")}\\b`).test(src);
  const out: Violation[] = [];
  for (const m of src.matchAll(/\b(it|test|describe)\.(skipIf|runIf)\s*\(/g)) {
    const at = m.index!;
    const line = src.slice(0, at).split("\n").length;
    if (/\/\/ ALLOW-HOOK-SKIP: \S/.test(src.split("\n")[line - 1] ?? "")) continue;
    const cond = parenBody(src, at + m[0].length - 1);
    const names = [...cond.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)].map((x) => x[1]!);
    const late = [...new Set(names.filter((n) => setInHook.has(n) && declaredLet(n)))];
    if (late.length) {
      out.push({ file, line, what: `${m[1]}.${m[2]}(${cond.trim()}) reads ${late.join(", ")}, which a hook assigns after vitest has already decided the skip` });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:skip-if-decided-before-collection - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("decide it with a top-level const (await is allowed there), or make the requirement fail in the hook");
  process.exit(1);
}
console.log(`lint:skip-if-decided-before-collection OK`);
