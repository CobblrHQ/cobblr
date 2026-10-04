#!/usr/bin/env tsx
// A .mjs script under scripts/ or e2e/ never uses a name that nothing declares or imports, because node only finds that ReferenceError on the line that runs it.
//
// THE BUG THIS PREVENTS. 2026-10-04: fundamentals-nightly.mjs called
// endPassTrace without importing it. Node loads such a file without a word, the
// walk reached the call in every area, and every area failed setup with
// "endPassTrace is not defined": eight issues filed (#4765 to #4772) for a
// product that was fine. `node --check` and the unit tests (which import the
// library, not the script) were green.
//
// THE RULE. TypeScript's checker, run over every .mjs under scripts/ and e2e/
// as plain JavaScript, must report no "Cannot find name 'x'" (TS2304/TS2552).
// Only that one diagnostic is judged: types, JSDoc and the rest of checkJs are
// not. A name that really exists at run time but the checker cannot see (a
// global a page injects) says so with `// names-defined: <why>` on that line.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. e2e/prod-look.mjs documents a
// parameter as `@param persona { email, uniqueEmail }`: the checker reads that
// comment as a type and reports `email`. A diagnostic whose line is a comment
// is not a use of a name, so comment lines are skipped.
//
//   npx tsx scripts/lint-mjs-names-defined.ts   (pnpm lint mjs-names-defined)
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.ts";

const ROOTS = ["scripts", "e2e"];

interface Violation {
  file: string;
  line: number;
  what: string;
}

const all = repoFiles(ROOTS).filter((f) => f.endsWith(".mjs"));

// A name can only become undefined by editing the file that uses it, so a branch
// is judged on the .mjs files it changed (checking all 490 took 8 to 14 s and
// read as an 18x-over-budget lint on a loaded runner). The whole tree is checked
// when asked (LINT_ALL=1), when this lint itself changed, or when git cannot say
// what changed.
function changedSinceMain(): string[] | null {
  if (process.env.LINT_ALL === "1") return null;
  try {
    const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const diff = (...a: string[]) => execFileSync("git", [...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
    // changed since the base: edited tracked files, and files the base does not have (new, committed or not)
    const inBase = new Set(diff("ls-tree", "-r", "--name-only", base, "--", ...ROOTS));
    const names = [...diff("diff", "--name-only", base, "--"), ...all.filter((f) => !inBase.has(f))];
    if (names.some((n) => n === "scripts/lint-mjs-names-defined.ts")) return null;
    return names.filter((n) => n.endsWith(".mjs") && ROOTS.some((r) => n.startsWith(`${r}/`)));
  } catch {
    return null;
  }
}
const changed = changedSinceMain();
const files = changed === null ? all : all.filter((f) => changed.includes(f));
if (!files.length) {
  console.log("lint:mjs-names-defined OK (no .mjs file changed)");
  process.exit(0);
}
const program = ts.createProgram(files, {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  // Imported bindings are enough for a name check. Dependency declarations
  // can hide a missing runtime import and pull in the whole application.
  noResolve: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  types: ["node"],
});

const violations: Violation[] = [];
// the checker reports real paths; the checkout is reached through a symlink on some machines
const cwd = realpathSync(process.cwd());
const wanted = new Set(files.map((f) => realpathSync(f)));
for (const sf of program.getSourceFiles()) {
  if (!wanted.has(realpathSync(sf.fileName))) continue;
  const lines = sf.text.split("\n");
  for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
    if ((d.code !== 2304 && d.code !== 2552) || d.start === undefined) continue;
    const line = sf.getLineAndCharacterOfPosition(d.start).line;
    const text = (lines[line] ?? "").trim();
    if (/^(\*|\/\/|\/\*)/.test(text) || /\/\/ names-defined: \S/.test(text)) continue;
    violations.push({ file: realpathSync(sf.fileName).replace(`${cwd}/`, ""), line: line + 1, what: ts.flattenDiagnosticMessageText(d.messageText, " ") });
  }
}

if (violations.length) {
  console.error(`lint:mjs-names-defined - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Import or declare the name; a name only a page or the runtime provides opts out with `// names-defined: <why>` on that line.");
  process.exit(1);
}
console.log(`lint:mjs-names-defined OK (${files.length} .mjs file${files.length === 1 ? "" : "s"}${changed === null ? ", the whole tree" : ""})`);
