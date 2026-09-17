#!/usr/bin/env tsx
// A test that sets PATH starts it with a directory it made (its own fakes), never a system directory: a PATH trimmed to /usr/bin means a tool is absent only where the runner keeps nothing there.
//
// THE BUG THIS PREVENTS. scripts/lib/rig-restarts.test.ts set PATH=/usr/bin:/bin to mean "no docker" and asserted the watch exits 0 with no output. The CI runner has /usr/bin/docker, so the test asked the REAL daemon and its verdict was whether that answered inside five seconds; it did not, mid-storm, and main went red on a merge nowhere near it (7fb6a42ca, 2026-09-17). Six merges before it passed on the daemon's mood. A check that cannot fail for its stated reason is worse than no check.
//
// THE RULE. In a test file, a PATH handed to a process, as an env-object key
// (`env: { PATH: "..." }`) or a shell prefix (`env PATH=... cmd`), begins
// with something the test built: an interpolation or a variable
// (`${bin}:${process.env.PATH}`), never a system directory literal
// (/usr/bin, /bin, /usr/local/bin, /opt/homebrew/bin, /sbin, ...). To make a
// tool absent, put a shim that fails first on PATH; to make one fake, put the
// fake first. A `PATH=` inside fixture text (a container's env dump) is data,
// not a PATH the test runs under, and is not judged. A genuine exception opts
// out with `// OWN-PATH: <why>` on the same line.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-test-path-starts-with-its-own-bin.ts   (pnpm run lint:test-path-starts-with-its-own-bin)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api", "modules", "packages", "web", "scripts", "e2e"];

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
    else if (/\.test\.(ts|tsx|mjs|js)$/.test(name)) yield p;
  }
}

/** `PATH: "/usr/bin..."`, `PATH: '/bin'`, `PATH: \`/usr/bin...\`` in an env
 *  object, or `env PATH=/usr/bin... cmd` as a shell prefix: the env key PATH
 *  (a word on its own, so MCP_NARRATE_PATH is not it) handed to a process
 *  with a value whose FIRST entry is a system directory. */
const SYSTEM_FIRST = /(?:(?<![\w$])PATH\s*:\s*["'`]?|\benv\s+PATH=)\/(?:usr|bin|sbin|opt|etc)\b/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!SYSTEM_FIRST.test(line)) continue;
    if (/OWN-PATH:/.test(line)) continue;
    out.push({ file, line: i + 1, what: "sets PATH to a system directory first; start it with a directory the test made (a shim that fails, or the fake it wants) so the tool is absent or fake by construction, not by what the runner keeps in /usr/bin" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:test-path-starts-with-its-own-bin - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("A test that removes a tool by trimming PATH is only as true as the runner's /usr/bin; put your own bin first.");
  process.exit(1);
}
console.log(`lint:test-path-starts-with-its-own-bin OK`);
