#!/usr/bin/env tsx
// A verify-cache stamp the pre-push hook trusts is written only by the script that runs that check, so a tree that passed tsc never skips the tsgo gate.
//
// THE BUG THIS PREVENTS. `pnpm typecheck` (tsc) and `pnpm typecheck:fast`
// (tsgo, the compiler CI gates on) both wrote the stamp `typecheck`, and the
// pre-push hook skips its tsgo run when that stamp matches the tree. So a tree
// that had passed only tsc was pushed as "already verified", and CI's tsgo
// went red on what tsc accepts (TS2869, an unreachable `??`, 2026-10-01). A
// stamp says "this exact check passed"; written by a different check, it says
// something false.
//
// THE RULE. For every `run_or_defer <kind> "<label>" <script>` in
// scripts/git-hooks/pre-push, the root package.json script <script> stamps
// <kind>, and no other root script stamps <kind>. A script that runs a
// different check stamps a kind of its own.
//
// THE BOUNDARY. Only stamps the hook reads. `lints` is stamped by
// scripts/run-lints.mjs, the program behind the hook's lint run, so it is
// held by the same rule through that file rather than a package.json script.
//
//   npx tsx scripts/lint-push-stamp-is-the-gates-compiler.ts   (pnpm lint push-stamp-is-the-gates-compiler)
import { readFileSync } from "node:fs";

const HOOK = "scripts/git-hooks/pre-push";
const PKG = "package.json";

const hook = readFileSync(HOOK, "utf8");
const scripts = (JSON.parse(readFileSync(PKG, "utf8")) as { scripts: Record<string, string> }).scripts;
const STAMP = /verify-cache\.mjs\s+stamp\s+([\w.-]+)/g;
const stampsOf = (cmd: string) => [...cmd.matchAll(STAMP)].map((m) => m[1]!);

const problems: string[] = [];
const gates = [...hook.matchAll(/^run_or_defer\s+([\w.-]+)\s+"[^"]*"\s+([\w:.-]+)/gm)];
if (!gates.length) problems.push(`${HOOK}: no run_or_defer line found; the hook changed shape, so this lint reads nothing`);

for (const [, kind, script] of gates) {
  const cmd = scripts[script!];
  if (cmd === undefined) {
    problems.push(`${HOOK}: runs "${script}", which ${PKG} does not define`);
    continue;
  }
  if (!stampsOf(cmd).includes(kind!)) {
    problems.push(`${PKG} "${script}" does not stamp "${kind}", the stamp ${HOOK} checks before skipping it`);
  }
  for (const [other, otherCmd] of Object.entries(scripts)) {
    if (other !== script && stampsOf(otherCmd).includes(kind!)) {
      problems.push(
        `${PKG} "${other}" stamps "${kind}", so a tree it passed skips "${script}" at push. Give it a stamp of its own.`,
      );
    }
  }
}

if (problems.length) {
  console.error(`lint:push-stamp-is-the-gates-compiler - ${problems.length} violation(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`lint:push-stamp-is-the-gates-compiler OK (${gates.length} stamp(s) the hook trusts, each written by its own check)`);
