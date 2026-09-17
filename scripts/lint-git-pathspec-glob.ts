#!/usr/bin/env tsx
// A git grep or git ls-files call in scripts/ whose pathspec contains ** carries
// :(glob), because a plain git pathspec has no ** and a file directly in the
// root is never read.
//
// THE BUG THIS PREVENTS (#3097, #3099). lint-role-gate-shared enumerated its
// candidates with `git grep -lE -- <pattern> api/src/**/*.ts`. A git pathspec
// is not a shell glob: `**` there needs a second slash, so a file sitting
// DIRECTLY in a root was never matched, and the lint never read
// api/src/index.ts, which is where the defect it was written to stop (#3072)
// lived. A lint that never reads a file cannot fail on it, so this was
// invisible by construction. `:(glob)` makes `**` mean "any depth, including
// none". Node's fs.globSync (and sourceFiles() in scripts/lib/glob-exclude.mjs,
// which every other lint uses) already means that, and
// scripts/lib/glob-exclude.test.ts asserts it.
//
// THE RULE. In scripts/**/*.{ts,mjs}, an invocation of git grep or git ls-files
// (execFileSync/spawnSync/execSync with "git" and "grep"/"ls-files", or a
// `git grep`/`git ls-files` shell string) may not carry a pathspec argument
// containing `**` unless that argument starts with `:(glob)`. Prefer
// sourceFiles() from ./lib/glob-exclude.mjs and read the files yourself; if
// git has to do the search, write `:(glob)root/**/*.ts`.
//
// PROVE IT RED before you trust it green: put
// `execFileSync("git", ["grep", "-l", "x", "--", "api/src/**/*.ts"])` in a
// scratch script under scripts/, run it, watch it fail, delete the file.
//
//   npx tsx scripts/lint-git-pathspec-glob.ts   (pnpm run lint:git-pathspec-glob)
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

const SELF = "scripts/lint-git-pathspec-glob.ts";

interface Violation {
  file: string;
  line: number;
  what: string;
}

// A call that reaches git grep / git ls-files can span lines (an args array),
// so judge a window: from a line mentioning "git" with grep|ls-files to the
// closing of that statement (the next `);` or `)`-terminated line).
function windows(src: string): { start: number; text: string }[] {
  const lines = src.split("\n");
  const out: { start: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
    if (!/(\bgit\b.*\b(grep|ls-files)\b|"git"[\s\S]*$)/.test(l)) continue;
    if (!/"git"|git (grep|ls-files)/.test(l)) continue;
    let text = l;
    let j = i;
    while (!/\)\s*;?\s*$/.test(lines[j] ?? "") && j < Math.min(lines.length - 1, i + 12)) {
      j++;
      text += "\n" + (lines[j] ?? "");
    }
    if (/\b(grep|ls-files)\b/.test(text)) out.push({ start: i + 1, text });
  }
  return out;
}

const violations: Violation[] = [];
for (const file of [...sourceFiles("scripts/**/*.ts"), ...sourceFiles("scripts/**/*.mjs")]) {
  if (file === SELF) continue;
  const src = readFileSync(file, "utf8");
  for (const w of windows(src)) {
    // Every quoted or template argument in the window that carries ** is a
    // pathspec candidate; without :(glob) at its start, git reads ** as *.
    for (const m of w.text.matchAll(/["'`]([^"'`\n]*\*\*[^"'`\n]*)["'`]/g)) {
      const arg = m[1] ?? "";
      if (arg.startsWith(":(glob)")) continue;
      violations.push({ file, line: w.start, what: `git pathspec "${arg}" has ** without :(glob): a file directly in the root is never matched` });
    }
  }
}

if (violations.length) {
  console.error(`lint:git-pathspec-glob - ${violations.length} raw pathspec(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    `\n  A git pathspec is not a shell glob: ** needs a second slash, so api/src/**/*.ts never\n` +
      `  matches api/src/index.ts (#3097: the lint written to stop #3072 could not read the file\n` +
      `  that held it). Write :(glob)root/**/*.ts, or enumerate with sourceFiles() from\n` +
      `  ./lib/glob-exclude.mjs, whose ** already means any depth including none.`,
  );
  process.exit(1);
}
console.log("lint:git-pathspec-glob OK");
