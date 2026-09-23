#!/usr/bin/env tsx
// Every declared record kind's create door writes a <noun>_created activity
// row, or the kind states in the reasoned baseline why it should not.
//
// THE BUG THIS PREVENTS. The trial ledger (api/src/platform/trial-ledger.ts,
// the "What you built here" list at the end of a sandbox) counts a person's
// records from the activity log's `<noun>_created` rows, net of a later
// `<noun>_deleted`. On 2026-09-22 ten of twenty-four declared kinds logged
// their create and fifteen did not, among them the list item, and the lists
// module is on in every seeded sandbox: a visitor who added to the grocery
// list, the most obvious thing to do there, met a page that named everything
// they built except that. A confident list that is short costs trust rather
// than time. The ten had been remembered one module at a time; this makes
// the set closed.
//
// THE RULE. For every module manifest (modules/<m>/src/module.ts), every kind
// in `provides.entityKinds` with id `<m>:<noun>` must have, somewhere under
// modules/<m>/src, the literal `"<noun>_created"` (the action the module
// logs when one is made). A kind that genuinely should not log (a line inside
// a parent record, bulk reference data the parent carries) is listed in
// scripts/kind-create-logs-baseline.json as `{ "key": "<kind id>", "why":
// "<a sentence somebody can disagree with>" }`; the lint refuses to run when
// an entry has no reason and fails an entry whose kind is gone
// (scripts/lib/reasoned-baseline.ts). The action's noun is the kind's tail:
// `lists:item` logs `item_created`. Nothing here checks that EVERY create
// door logs; a module that logs one door and not another is the next lint,
// and today's shape is the one that was missing entirely.
//
// PROVE IT RED: on the tree at 713dc0f08 it names the fifteen.
//
//   npx tsx scripts/lint-kind-create-logs.ts   (pnpm run lint kind-create-logs)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { entryToAdd, readReasonedBaseline, staleKeys } from "./lib/reasoned-baseline.js";

const ROOT = process.env.COBBLR_LINT_ROOT ?? ".";
const MODULES = join(ROOT, "modules");
const BASELINE = join(ROOT, "scripts", "kind-create-logs-baseline.json");
const BASELINE_SHOWN = "scripts/kind-create-logs-baseline.json";

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
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield p;
  }
}

/** The kind ids a manifest declares: the `id: "<m>:<noun>"` literals inside
 *  its `entityKinds: [ ... ]`, bracket-matched so an action's id (which
 *  looks the same) is never read as a kind. */
export function declaredKinds(manifest: string): string[] {
  const at = manifest.indexOf("entityKinds:");
  if (at < 0) return [];
  const open = manifest.indexOf("[", at);
  if (open < 0) return [];
  let depth = 0;
  let end = open;
  for (let i = open; i < manifest.length; i++) {
    const c = manifest[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = manifest.slice(open, end + 1);
  return [...block.matchAll(/\bid:\s*"([a-z0-9-]+:[a-z0-9_-]+)"/g)].map((m) => m[1]!);
}

const baseline = readReasonedBaseline(BASELINE, BASELINE_SHOWN);
if (!baseline.ok) {
  console.error(`✗ lint:kind-create-logs: ${BASELINE_SHOWN} does not state its case, so the lint will not run:\n`);
  for (const p of baseline.problems) console.error(`  ${p}`);
  process.exit(1);
}

interface Violation {
  file: string;
  kind: string;
  noun: string;
}
const violations: Violation[] = [];
const seen = new Set<string>();
let modules: string[];
try {
  modules = readdirSync(MODULES).filter((m) => !m.startsWith("."));
} catch {
  modules = [];
}
for (const m of modules.sort()) {
  let manifest: string;
  try {
    manifest = readFileSync(join(MODULES, m, "src", "module.ts"), "utf8");
  } catch {
    continue;
  }
  const kinds = declaredKinds(manifest);
  if (kinds.length === 0) continue;
  const src = [...walk(join(MODULES, m, "src"))].map((f) => readFileSync(f, "utf8")).join("\n");
  for (const kind of kinds) {
    seen.add(kind);
    const noun = kind.split(":")[1]!;
    if (src.includes(`"${noun}_created"`)) continue;
    if (baseline.entries.has(kind)) continue;
    violations.push({ file: `modules/${m}/src/module.ts`, kind, noun });
  }
}

// An allowance for a kind nobody declares any more is deleted, not kept.
const stale = staleKeys(baseline.entries, seen);

if (stale.length) {
  console.error(`✗ lint:kind-create-logs: ${stale.length} entr${stale.length === 1 ? "y" : "ies"} in ${BASELINE_SHOWN} name${stale.length === 1 ? "s" : ""} a kind that is gone. Delete ${stale.length === 1 ? "it" : "them"}:`);
  for (const k of stale) console.error(`  ${k}`);
}
if (violations.length) {
  console.error(`✗ lint:kind-create-logs: ${violations.length} declared record kind(s) whose create writes no activity row, so the trial ledger cannot count them:`);
  for (const v of violations) console.error(`  ${v.file}  ${v.kind}  (log action "${v.noun}_created" where one is made, and "${v.noun}_deleted" where one is removed)`);
  console.error(`\nA kind that genuinely should not log (a line inside its parent record, bulk reference data the parent carries) states its case in ${BASELINE_SHOWN}:`);
  for (const v of violations) console.error(`${entryToAdd(v.kind, "why this kind is not a record of the person's own")},`);
}
if (stale.length || violations.length) process.exit(1);
console.log(`lint:kind-create-logs OK (${seen.size} kinds, ${baseline.entries.size} say why not)`);
