#!/usr/bin/env tsx
// Guard: a test must not import a script that reads CREDENTIALS on import.
//
// A file in scripts/ is an executable: its module scope runs the moment it is
// imported. Most of that is harmless - a testbench that reads committed
// fixtures is fine, and this lint leaves it alone. The hazard is narrower: a
// script that resolves a CREDENTIAL at module scope. On the dev Mac that file
// exists, so the test passes; on a runner it does not, and the test fails at
// import with an error about a missing token that has nothing to do with what
// it asserts.
//
// That is exactly what happened on 2026-09-04: `scripts/reset-delay.test.ts`
// imported `bench-action-rail.ts` for one pure function, went green here and
// red in CI. The fix was to move the function into `scripts/lib/reset-delay.ts`
// and import that — which is the rule this lint makes permanent.
//
// scripts/lib/ is the exception BY DESIGN: it is where a script's pure parts
// go so they can be tested. Nothing in lib may read credentials or argv at
// module scope; that is what makes it importable.
//
//   npx tsx scripts/lint-test-imports-script.ts [--candidates]
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", "dist", ".git", "_tmp", "coverage", "build"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // A dot-directory is scratch (a test's mkdtemp, .git): a test running
    // beside this lint writes one under scripts/ and removes it, and a file
    // listed here and gone before it was read crashed the lint (main at
    // 22462e37a).
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) testFiles(full, out);
    else if (/\.test\.(ts|tsx|mts|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** The file an import specifier points at, if it is in scripts/. */
function resolveScript(from: string, spec: string): string | null {
  const guess = join(from, "..", spec).replace(/\.js$/, ".ts");
  for (const p of [guess, guess.replace(/\.ts$/, ".mts"), guess.replace(/\.ts$/, ".mjs")]) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** A credential read that happens on IMPORT: a top-level statement (column 0)
 *  that resolves a secret. A read inside a function body is lazy and fine. */
function readsCredentialsAtImport(file: string): string | null {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const raw of src.split("\n")) {
    if (/^\s/.test(raw) || raw.startsWith("//") || raw.startsWith("*")) continue;
    if (/secretFile\s*\(|\.secrets\b|process\.env\.[A-Z_]*(TOKEN|KEY|SECRET|PASSWORD)/.test(raw)) {
      return raw.trim().slice(0, 120);
    }
  }
  return null;
}

// THE TESTS THAT IMPORT FROM scripts/, PICKED BY git grep. Reading every test file to find the few that do grew with
// the suite past this lint's read budget: 3,981 files, 17.1 MB on 2026-10-19 against the 7.1 MB recorded on 09-29,
// and #7020's re-check went red on it with no test failing. git grep reads the tree in C and hands back only the
// candidates; --untracked keeps a new, not yet committed test in view. Without git, the walk below.
const IMPORTS_SCRIPTS = "(from|import)[[:space:]]+['\"][^'\"]*scripts/";
// HOW IT LOOKED, SAID (#7576): run 54906's test of this lint found a modules/ test missing from the candidates once in
// CI and never again, and nothing said whether git grep or the walk had picked them. Each pick now says which, and
// how many, so the next miss names its own path.
let how = "";
function candidates(): string[] {
  try {
    const out = execFileSync("git", ["grep", "-l", "--untracked", "-E", IMPORTS_SCRIPTS, "--", "*.test.ts", "*.test.tsx", "*.test.mts", "*.test.mjs"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const files = out
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.split("/").some((seg) => SKIP.has(seg) || seg.startsWith(".")))
      .map((f) => join(ROOT, f));
    how = `git grep listed ${files.length} test(s) importing from scripts/`;
    return files;
  } catch (e) {
    const err = e as { status?: number; stderr?: string | Buffer; message?: string };
    // git grep exits 1 when nothing matches: none to judge.
    if (err.status === 1) {
      how = "git grep matched no test";
      return [];
    }
    const files = testFiles(ROOT);
    how = `git grep failed (status ${err.status ?? "?"}: ${String(err.stderr ?? err.message ?? "").trim().split("\n")[0]}); the walk read ${files.length} test(s)`;
    return files;
  }
}

// --candidates: the files it would read, one per line (its test holds them to every test that imports from scripts/).
// THE LIST ENDS WHEN IT IS READ (#7576): stdout into a pipe is written behind node's back, and process.exit() dropped
// whatever the pipe had not taken yet. At load 26 the reader took 332 of 435 lines and the test named a test the
// lint "would not read". It ends by running out of work instead, and says its count for the reader to hold it to.
const listOnly = process.argv.includes("--candidates");
const picked = candidates();
if (listOnly) {
  process.stdout.write(picked.map((f) => relative(ROOT, f) + "\n").join(""));
  console.error(`candidates: ${how}`);
}

const offenders: string[] = [];
for (const file of listOnly ? [] : picked) {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue; // a test's scratch file, gone between the list and the read
  }
  for (const m of src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
    const spec = m[1]!;
    if (!/(^|\/)scripts\//.test(spec)) continue;
    if (/(^|\/)scripts\/lib\//.test(spec)) continue;
    const target = resolveScript(file, spec);
    const reason = target && readsCredentialsAtImport(target);
    if (!reason) continue;
    const line = src.slice(0, m.index).split("\n").length;
    offenders.push(
      `  ✗ ${relative(ROOT, file)}:${line} imports "${spec}", whose module scope reads a credential:\n` +
        `      ${reason}\n` +
        `      That file exists here and not on a runner, so this test passes locally and\n` +
        `      fails in CI at import. Move the pure part into scripts/lib/<name>.ts and\n` +
        `      import that instead.`,
    );
  }
}

if (offenders.length) {
  console.error(`lint:test-imports-script FAILED (${offenders.length})`);
  for (const o of offenders) console.error(o);
  process.exitCode = 1;
} else if (!listOnly) console.log("✓ test-imports-script: no test imports a script that reads credentials on import");
