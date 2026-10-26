#!/usr/bin/env tsx
// A workflow step that builds or commits a Docker image on a shared CI box holds the box's prunes for its duration (scripts/ci/prune-hold.sh).
//
// THE BUG THIS PREVENTS. 2026-10-25: the A6, under its disk floor, ran image prune and builder prune -a every minute and took the cloud overlay build's snapshots twice (runs 4365, 4377); only the pool bake held the prune
//
// THE RULE. A workflow step (.forgejo/workflows) or a shell script under scripts/ that RUNS `docker build`,
// `docker buildx build`, `buildx build` or `docker commit`, or uses docker/build-push-action, takes the hold:
// it sources scripts/ci/prune-hold.sh, or builds through a helper that does (scripts/ci/docker-build-heal.sh,
// scripts/ci/run-in-own-network.sh), or starts its own container labelled cobblr.prune-hold (bake-pool). A command runs when it starts the line or follows `;`, `&&`, `||`, `|`,
// `(`, `{`, `if`, `then`, `!` or `$(`. A step that builds where nothing prunes says why on the line before:
// `# prune-hold: <reason>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Every Preflight step prints "docker build cache likely bloated;
// 'docker builder prune -f'" inside an echo: text, not a build, so only a command position counts. Comments
// never count. The hold is per step, not per job: a hold in an earlier step ended with that step's shell.
//
//   npx tsx scripts/lint-image-build-holds-the-prune.ts   (pnpm lint image-build-holds-the-prune)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS: Array<[string, RegExp]> = [[".forgejo/workflows", /\.ya?ml$/], ["scripts", /\.sh$/]];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string, ext: RegExp): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || (name.startsWith(".") && name !== ".forgejo")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, ext);
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

const BUILD = /(?:^\s*|[;&|({!]\s*|\$\(\s*|\b(?:if|then)\s+)(?:docker\s+(?:build|image\s+build|buildx\s+build|commit)|buildx\s+build)\b|uses:\s*\S*docker\/build-push-action/;
// A container the step itself starts with a hold label holds too (bake-pool's pool-bake).
const HOLDS = /prune-hold\.sh|docker-build-heal\.sh|run-in-own-network\.sh|--label "cobblr\.prune-hold=\$\(date/;
const EXEMPT = /#\s*prune-hold:\s*\S/;
const HELPERS = new Set(["scripts/ci/prune-hold.sh"]);
const code = (l: string) => !/^\s*(#|\/\/|\*)/.test(l);

/** PURE. Each step of a workflow: its first line (0-based) and its lines. */
export function stepsOf(src: string): Array<{ at: number; lines: string[] }> {
  const L = src.split("\n");
  const starts: Array<[number, number]> = [];
  L.forEach((l, i) => {
    const m = /^(\s*)- [a-z-]+:/.exec(l);
    if (m) starts.push([i, m[1]!.length]);
  });
  return starts.map(([i, ind]) => {
    let j = i + 1;
    for (; j < L.length; j++) {
      const t = L[j]!;
      if (t.trim() && t.length - t.trimStart().length <= ind && !t.trimStart().startsWith("#")) break;
    }
    return { at: i, lines: L.slice(i, j) };
  });
}

/** PURE. The violations of one file: a workflow by its steps, a script as a whole. */
export function check(file: string, src: string): Violation[] {
  if (HELPERS.has(file)) return [];
  const units = /\.ya?ml$/.test(file) ? stepsOf(src) : [{ at: 0, lines: src.split("\n") }];
  const out: Violation[] = [];
  for (const u of units) {
    const k = u.lines.findIndex((l, i) => code(l) && BUILD.test(l) && !EXEMPT.test(u.lines[i - 1] ?? ""));
    if (k < 0 || u.lines.some((l) => code(l) && HOLDS.test(l))) continue;
    out.push({ file, line: u.at + k + 1, what: `builds an image without holding the box's prunes: ${u.lines[k]!.trim().slice(0, 80)}` });
  }
  return out;
}

if (process.argv[1]?.endsWith("lint-image-build-holds-the-prune.ts")) main();
function main() {
const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const [root, ext] of ROOTS) for (const file of walk(root, ext)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:image-build-holds-the-prune - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("start the step with: . scripts/ci/prune-hold.sh \"<what is built>\"");
  process.exit(1);
}
console.log(`lint:image-build-holds-the-prune OK`);
}
