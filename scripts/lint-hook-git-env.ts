#!/usr/bin/env tsx
// A script run from a git hook never writes into core when it means another repo: the hook's repo-locating env is cleared where it enters.
//
// THE BUG THIS PREVENTS. A git hook runs with GIT_DIR (and the rest of `git
// rev-parse --local-env-vars`) set for the repository it fired in, and
// `git -C <another repo>` obeys GIT_DIR over -C. Under the pre-push hook a lint
// reading seventeen client repositories read core seventeen times (#3545), and
// a test that makes a fixture repository and commits in it commits into core
// (scripts/a-script-run-from-a-hook-never-writes-into-core.test.ts shows the
// reaper test's fixture commits landing in a scratch core).
//
// THE RULE. Whether a given `git -C <dir>` means core or another repository
// cannot be read off the call, so the environment is cleared where the hook's
// reaches a script, and this holds those places:
//   1. scripts/git-hooks/pre-push sources scripts/lib/git-env.sh and calls
//      clear_hook_git_env before it runs anything (pnpm, node, a script);
//   2. scripts/lib/vitest-setup.mjs calls clearRepoLocating, and the root
//      vitest.config.ts loads that setup file, so no test inherits it;
//   3. nobody else keeps a copy of the variable list: a second list goes stale
//      the day git adds a variable. The list is scripts/lib/git-env.mjs (and
//      git's own `--local-env-vars` in the shell twin).
// pre-commit and commit-msg keep the hook's environment on purpose: the one
// script they run reads the staged index, which a commit of named paths points
// at through GIT_INDEX_FILE.
//
// PROVE IT RED: remove clear_hook_git_env from pre-push, or the clearRepoLocating
// call from the vitest setup, or paste the list into another script.
//
//   npx tsx scripts/lint-hook-git-env.ts   (pnpm lint hook-git-env)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.COBBLR_LINT_ROOT ?? ".";
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const problems: string[] = [];

// 1. pre-push clears first.
const prePush = read("scripts/git-hooks/pre-push").split("\n");
const clearAt = prePush.findIndex((l) => /^\s*clear_hook_git_env\b/.test(l));
const sourceAt = prePush.findIndex((l) => /^\s*\.\s+.*scripts\/lib\/git-env\.sh/.test(l));
const firstRun = prePush.findIndex((l) => !l.trimStart().startsWith("#") && /\b(pnpm|node|npx|tsx)\b|scripts\/[\w-]+\.(sh|mjs|ts)/.test(l) && !/git-env\.sh/.test(l));
if (sourceAt < 0 || clearAt < 0) problems.push("scripts/git-hooks/pre-push: does not source scripts/lib/git-env.sh and call clear_hook_git_env");
else if (clearAt < sourceAt) problems.push(`scripts/git-hooks/pre-push:${clearAt + 1}: clear_hook_git_env runs before git-env.sh is sourced`);
else if (firstRun >= 0 && firstRun < clearAt) problems.push(`scripts/git-hooks/pre-push:${firstRun + 1}: runs a script before clear_hook_git_env (line ${clearAt + 1}), with the hook's GIT_DIR still set`);

// 2. every test starts without it.
const setup = read("scripts/lib/vitest-setup.mjs");
if (!/^\s*clearRepoLocating\(process\.env\)/m.test(setup)) problems.push("scripts/lib/vitest-setup.mjs: does not call clearRepoLocating(process.env)");
if (!/vitest-setup\.mjs/.test(read("vitest.config.ts"))) problems.push("vitest.config.ts: does not load scripts/lib/vitest-setup.mjs, so tests inherit a hook's GIT_DIR");

// 3. one list.
const OWNERS = new Set(["scripts/lib/git-env.mjs", "scripts/lint-hook-git-env.ts"]);
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = `${dir}/${name}`;
    if (statSync(join(ROOT, p)).isDirectory()) yield* walk(p);
    else if (/\.(ts|mjs|js|sh)$/.test(name)) yield p;
  }
}
for (const file of walk("scripts")) {
  if (OWNERS.has(file)) continue;
  const src = read(file);
  // A hand-kept list names several of these together; one mention in prose is not a list.
  const named = ["GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE"].filter((v) => src.includes(v));
  if (named.length >= 2) problems.push(`${file}: keeps its own copy of git's repo-locating variables (${named.join(", ")}); use envForOtherRepo / clearRepoLocating from scripts/lib/git-env.mjs`);
}

if (problems.length) {
  console.error(`lint:hook-git-env - ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("A git hook points git at core through GIT_DIR, and `git -C <another repo>` obeys it; see scripts/lib/git-env.mjs.");
  process.exit(1);
}
console.log("lint:hook-git-env OK (pre-push clears the hook's GIT_DIR first; every test starts without it; one list)");
