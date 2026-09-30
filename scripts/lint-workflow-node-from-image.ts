#!/usr/bin/env tsx
// A workflow takes node from the runner's image, and downloads one only when the image has none or a step names why it pins.
//
// THE BUG THIS PREVENTS. 2026-10-01: seven housekeeping workflows ran
// actions/setup-node on every run, downloading Node 22 (ci-head-runs every
// fifteen minutes) though the runner image ships Node, and ci.yml had long
// since learned to skip the download when the image has it.
//
// THE RULE. A `setup-node` step in .forgejo/workflows is one of:
//   - guarded by `if: steps.bakednode.outputs.have != '1'` (the image has no
//     node of the version the job needs; ci.yml's pattern), or
//   - under a `# NODE PINNED: <why>` line within the three lines above it
//     (a job that runs the app or its tests on production's major version).
// Anything else downloads Node for nothing on every run.
//
// THE BOUNDARY. Only setup-node: pnpm/action-setup and checkout are cheap and
// cached, and are not what the incident was.
//
// PROVE IT RED: on main before this change it names the seven housekeeping
// workflows.
//
//   npx tsx scripts/lint-workflow-node-from-image.ts   (pnpm lint workflow-node-from-image)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = [".forgejo/workflows"];

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
    else if (/\.ya?ml$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/setup-node@/.test(lines[i] ?? "")) continue;
    const near = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
    if (/steps\.bakednode\.outputs\.have != '1'/.test(near) || /#\s*NODE PINNED:\s*\S/.test(near)) continue;
    out.push({ file, line: i + 1, what: "downloads Node on every run: the runner image has it" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:workflow-node-from-image - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("drop the setup-node step; or guard it with if: steps.bakednode.outputs.have != '1'; or say # NODE PINNED: <why> on the line above");
  process.exit(1);
}
console.log(`lint:workflow-node-from-image OK`);
