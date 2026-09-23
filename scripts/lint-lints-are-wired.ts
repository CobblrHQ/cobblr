#!/usr/bin/env tsx
// Every lint:* script must actually be RUN by something.
//
// WHY THIS IS A LINT: a check nothing invokes is not a guardrail, it is a file.
// It costs the same to write, reads the same in a PR ("shipped the fix AND the
// lint"), and catches exactly nothing. Two were found orphaned on 2026-07-30 -
// including `lint:scan-row-title`, added that same day and described in its own
// PR as the thing that "forces every response through withTitle()". It had never
// executed once.
//
// The wiring used to be per-lint CI steps, then a `lint:*` line per lint in
// package.json. It is now each lint's own RECORD, scripts/lint-durations/
// <name>.json, whose "run" command scripts/run-lints.mjs executes (#3455). So:
//
//   1. every record's command names a script that exists (a record pointing
//      at a renamed or deleted file is a lint that runs nothing, or errors),
//   2. something actually invokes run-lints.mjs: ci.yml and the pre-push hook,
//   3. package.json carries no `lint:*` list again beside `lint:all`: a second
//      list is a second conflict surface and a second thing to disagree,
//   4. every lint FILE is run by some record (or says why not).
//
// A new lint is wired by its RECORD (scripts/new-lint.sh writes it); rule 4 is
// what makes "just write the file" fail loudly instead of silently doing
// nothing, which is the property that stops the orphan class coming back.
//
//   npx tsx scripts/lint-lints-are-wired.ts   (pnpm lint lints-are-wired)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MANUAL, discoverLints } from "./run-lints.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { all } = discoverLints();
const ci = readFileSync(join(ROOT, ".forgejo", "workflows", "ci.yml"), "utf8");
const hook = readFileSync(join(ROOT, "scripts", "git-hooks", "pre-push"), "utf8");

const problems: string[] = [];

// 1. A record whose command runs nothing. The path is read out of the command
//    (the first scripts/... or modules/... file it names).
const { scripts: commands } = discoverLints() as { scripts: Record<string, string> };
const broken = Object.entries(commands).filter(([, cmd]) => {
  const m = /\b((?:scripts|modules|api|web|packages)\/[^\s'"]+\.(?:ts|mjs|js|sh))\b/.exec(cmd);
  return m ? !existsSync(join(ROOT, m[1]!)) : false;
});
if (broken.length) {
  problems.push(
    `${broken.length} lint record(s) run a script that does not exist:\n` +
      broken.map(([n, c]) => `    - ${n}: ${c}`).join("\n") +
      "\n    Fix the \"run\" in scripts/lint-durations/<name>.json, or delete the record with the lint.",
  );
}

// 2. The runner itself must be invoked. Discovery is worthless if nothing calls it.
const runsTheRunner = (text: string) => /run-lints\.mjs|\blint:all\b/.test(text);
if (!runsTheRunner(ci)) {
  problems.push(
    "no CI job runs the lint suite — .forgejo/workflows/ci.yml must call `pnpm run lint:all`.\n" +
      "    Every lint is discovery-wired through that one step; without it, none of them run.",
  );
}
if (!runsTheRunner(hook)) {
  problems.push(
    "scripts/git-hooks/pre-push does not run `pnpm run lint:all`, so a push gets no local lint gate.",
  );
}

// 3. The second list must not come back. package.json keeps `lint:all` (the
//    runner) and `lint` (the one-lint dispatcher); a `lint:<name>` line beside
//    them is a registration in the wrong place, which the runner never reads.
const pkgScripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
const strays = Object.keys(pkgScripts).filter((k) => k.startsWith("lint:") && k !== "lint:all");
if (strays.length) {
  problems.push(
    `package.json registers ${strays.length} lint(s) again: ${strays.join(", ")}.\n` +
      "    A lint's registration is its record, scripts/lint-durations/<name>.json (\"run\"), which is\n" +
      "    what run-lints.mjs reads; a package.json line is never run. Move it into the record and\n" +
      "    call it as `pnpm lint <name>`.",
  );
}

// 4. A lint FILE that no record runs. Rules 1-3 all reason about records, so
//    a script that exists on disk with no record is invisible to every one of
//    them, and to the runner, whose discovery reads the records. The file then
//    sits in scripts/ looking exactly like a guardrail while guarding nothing.
//
//    That is not hypothetical: lint-module-purity.ts sat unrun (found
//    2026-08-17 while adding lint-hooks-served.ts, which had silently done the
//    same thing — the suite count simply did not move). A lint nobody runs is
//    worse than no lint, because the tree looks protected.
//
//    Opt out deliberately with a `LINT-NOT-IN-SUITE:` header comment naming the
//    reason (a helper, or one that needs arguments) — same shape as AI-REACH.
const OPT_OUT = "LINT-NOT-IN-SUITE:";
const scriptsDir = join(ROOT, "scripts");
const lintFiles = readdirSync(scriptsDir).filter(
  (f) => f.startsWith("lint-") && f.endsWith(".ts") && !f.endsWith(".test.ts"),
);
const referenced = new Set(
  Object.values(commands).flatMap((c) => [...c.matchAll(/scripts\/(lint-[a-z0-9-]+\.ts)/g)].map((m) => m[1]!)),
);
const unrun = lintFiles.filter(
  (f) => !referenced.has(f) && !readFileSync(join(scriptsDir, f), "utf8").includes(OPT_OUT),
);
if (unrun.length) {
  problems.push(
    `${unrun.length} lint script(s) exist but NOTHING runs them:\n` +
      unrun.map((f) => `    - scripts/${f}`).join("\n") +
      `\n    Discovery is by each lint's record, so a file alone never runs. Register it` +
      `\n    with scripts/new-lint.sh (which writes scripts/lint-durations/<name>.json), or,` +
      `\n    if it is deliberately out of the suite, put a ${OPT_OUT} <reason> comment in it.` +
      // A NEW lint needs more than this one thing, and finding that out one
      // failure at a time costs a push per requirement. Say the whole list
      // here, at the first red, so it can be finished in one pass.
      `\n` +
      `\n    A new lint needs all of these — \`pnpm run where "a new repo rule"\`` +
      `\n    prints them before you write it:` +
      `\n      1. the script                scripts/lint-<name>.ts` +
      `\n      2. its record                scripts/lint-durations/<name>.json: "run", "rows", a time` +
      `\n      3. a placement row in it     saying which work it governs (lint:placement)` +
      `\n      4. proof it goes RED         on the real violation, before you fix it`,
  );
}

if (problems.length === 0) {
  console.log(
    `[lint:lints-are-wired] ✓ all ${all.length} lint scripts are discovered by run-lints.mjs and run in ` +
      `CI + pre-push (${Object.keys(MANUAL).length} deliberately manual).`,
  );
  process.exit(0);
}

console.error("\n[lint:lints-are-wired] ✗\n");
for (const p of problems) console.error(`  - ${p}\n`);
process.exit(1);
