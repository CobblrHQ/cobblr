#!/usr/bin/env tsx
// A test reads repository files by a path built from its own file (import.meta.url), never one relative to the working directory.
//
// THE BUG THIS PREVENTS. barcode-source.test.ts globbed modules/core-scan/src from the cwd; run from the module directory it matched nothing and its no-offenders check passed on empty input (2026-09-29)
//
// THE RULE. A test file that names a repository path in a file read
// (readFileSync, readdirSync, existsSync, statSync, globSync) with a literal
// starting at a top-level directory ("modules/...", "web/...") fails: that
// path resolves against the working directory, which is the repo root in CI
// and the package's own directory when someone runs the package's tests. A
// read then throws, and a glob quietly matches nothing, which is worse: every
// "no offenders" loop over it passes. Build the path from the test's own
// file instead. A genuine exception carries `// cwd-relative: <reason>` on the
// line.
//
// THE BOUNDARY. Only test files: the lints themselves read "web/src/..." from
// the working directory on purpose, and run-lints.mjs always starts them at
// the root. Only literals that begin at a top-level directory: a template
// literal built on a resolved root (`${REPO}web/...`) does not match.
//
//   npx tsx scripts/lint-test-paths-from-file.ts   (pnpm lint test-paths-from-file)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.js";

// A top-level directory, as the start of a path or the whole of it ("modules").
const TOP = "(?:api|web|modules|packages|scripts|bundles|docs|e2e|changelog\\.d|deploy|docker)(?:/|[\"'`])";
const CWD_READ = new RegExp(`\\b(?:readFileSync|readdirSync|existsSync|statSync|globSync)\\(\\s*["'\`]${TOP}`);

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // A glob given its own cwd resolves nothing against the working directory.
    const rooted = /\bglobSync\([^)]*\bcwd:/.test(line);
    if (CWD_READ.test(line) && !rooted && !/\/\/ cwd-relative: \S/.test(line)) {
      out.push({ file, line: i + 1, what: "reads a repository path relative to the working directory" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const file of repoFiles(["*.test.ts", "*.test.tsx", "*.test.mjs", "*.test.js"])) {
  if (file.includes("node_modules/")) continue;
  violations.push(...check(file, readFileSync(file, "utf8")));
}

if (violations.length) {
  console.error(`lint:test-paths-from-file - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("const REPO = fileURLToPath(new URL('../../../', import.meta.url)); then readFileSync(`${REPO}web/...`) or globSync(pattern, { cwd: REPO })");
  process.exit(1);
}
console.log(`lint:test-paths-from-file OK`);
