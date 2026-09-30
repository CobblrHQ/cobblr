#!/usr/bin/env tsx
// A component test imports what it renders when the file loads, never inside a test or a helper a test calls.
//
// THE BUG THIS PREVENTS. 2026-09-30: a test imported a whole page inside a
// helper its test called. On a starved runner the import alone outlasted the
// test's timeout (15 s, already stretched for the box's load); the test was
// failed, cleanup ran, and THEN the import finished and mounted the page, which
// started its Discord connection during the next test. That test failed with a
// real-looking assertion (`expected 1 to be 0`) about code it never ran. An
// import at the top of the file is paid while the file is collected, before any
// test's clock starts, and can never land after a cleanup.
//
// THE RULE. In a *.test.tsx, `await import("./…")` or `("../…")` indented
// inside a function, whose imported name the file renders as `<Name`, fails. A
// top-level `const { X } = await import("./X")` after the vi.mock calls passes:
// that is the usual way to import after mocks, and it runs at collect time. An
// in-function import of something the file never renders (a module under test,
// a helper) passes: nothing mounts late. A genuine exception ends the line with
// `// renders-late: ok <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The first count found 42
// files importing a rendered component with `await import`; 40 were top-level
// awaits after vi.mock, which are the safe idiom. Only indentation separates
// them, so indentation is the boundary.
//
//   npx tsx scripts/lint-test-renders-what-it-imported.ts   (pnpm lint test-renders-what-it-imported)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.js";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const IN_FUNCTION_IMPORT = /^[ \t]+const\s*\{([^}]+)\}\s*=\s*await import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/;

/** Every in-function import of a rendered component in one file. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  src.split("\n").forEach((line, i) => {
    const m = IN_FUNCTION_IMPORT.exec(line);
    if (!m || /renders-late:\s*ok/.test(line)) return;
    const names = m[1]!
      .split(",")
      .map((s) => s.trim().split(/\s*:\s*/).pop()!)
      .filter(Boolean);
    const rendered = names.filter((n) => new RegExp(`<${n}[\\s/>]`).test(src));
    if (rendered.length) out.push({ file, line: i + 1, what: `${rendered.join(", ")} from ${m[2]} is imported inside a function and rendered` });
  });
  return out;
}

const violations: Violation[] = [];
for (const file of repoFiles(["web/src/**/*.test.tsx", "packages/**/*.test.tsx", "modules/**/*.test.tsx"])) {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  violations.push(...check(file, src));
}

if (violations.length) {
  console.error(`lint:test-renders-what-it-imported - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Import it at the top of the file (a top-level `const { X } = await import(\"./X\")` after vi.mock is fine): an import inside a test runs on the test's clock and can mount after cleanup, into the next test.");
  process.exit(1);
}
console.log(`lint:test-renders-what-it-imported OK`);
