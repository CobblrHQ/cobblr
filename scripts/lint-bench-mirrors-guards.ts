#!/usr/bin/env tsx
// Every guard the chat turn applies is either applied by the bench too, or
// says in one line why it cannot be.
//
// THE BUG THIS PREVENTS. The corpus bench runs its own copy of the agent loop.
// When the app grew a guard the bench did not have, the bench measured a path
// the product no longer took and reported as a MODEL miss something the app
// would have corrected. That has now happened twice and cost two days:
// the 2026-09-04 nightly scored "right action, wrong module" against a call
// the app hands straight back, and before that the bench built its own weaker
// system prompt and invented six "described instead of acting" misses.
//
// A wrong number is worse than no number, because somebody spends a day on the
// model when the instrument was the problem.
//
// THE RULE. A guard module under modules/core-ai/src/api that the chat route
// imports must also be imported by scripts/bench-action-rail.ts, OR be listed
// in NOT_IN_THE_BENCH below with the reason. The exemption is deliberate and
// visible; forgetting is what this stops.
//
//   cd <repo> && npx tsx scripts/lint-bench-mirrors-guards.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAT = join(ROOT, "modules/core-ai/src/api/chat.ts");
const BENCH = join(ROOT, "scripts/bench-action-rail.ts");

/** The guards a turn applies, by the module that owns each. */
const GUARD_MODULES = [
  "action-args-guard",
  "act-dont-escort",
  "act-dont-describe",
  "groundless-answer",
  "move-not-create",
  "reported-truthfully",
];

/** Guards the bench genuinely cannot exercise, and why. Each reason has to say
 *  what about the bench makes it impossible, not that it was inconvenient. */
const NOT_IN_THE_BENCH: Record<string, string> = {
  "reported-truthfully":
    "the bench never APPLIES a write - it records the proposal and stops - so a turn there can never have a ledger to misdescribe",
  "move-not-create":
    "the bench's create path is terminal (a create IS the verdict), so there is no round after it for a bounce to change; no corpus case can reach it",
};

const chat = readFileSync(CHAT, "utf8");
const bench = readFileSync(BENCH, "utf8");
const imports = (src: string, mod: string): boolean =>
  new RegExp(`from\\s+["'][^"']*${mod}\\.js["']`).test(src);

const missing: string[] = [];
for (const mod of GUARD_MODULES) {
  if (!imports(chat, mod)) continue; // the app does not use it; nothing to mirror
  if (imports(bench, mod)) continue;
  if (NOT_IN_THE_BENCH[mod]) continue;
  missing.push(mod);
}

// An exemption that stops being true is worse than none: it says the bench is
// covered when it is not.
const stale = Object.keys(NOT_IN_THE_BENCH).filter((m) => imports(bench, m));

if (missing.length || stale.length) {
  if (missing.length) {
    console.error(
      `✗ bench-mirrors-guards: ${missing.length} guard(s) the chat turn applies that the bench does not:\n`,
    );
    for (const m of missing) console.error(`  modules/core-ai/src/api/${m}.ts`);
    console.error(
      `\nThe bench runs its own loop. A guard it lacks makes it measure a path the product\n` +
        `does not take, and report a model miss for a call the app corrects. Import the same\n` +
        `pure function in scripts/bench-action-rail.ts, or add it to NOT_IN_THE_BENCH in this\n` +
        `file with the reason it cannot fire there.\n`,
    );
  }
  for (const m of stale) {
    console.error(`✗ bench-mirrors-guards: ${m} is listed as impossible in the bench, but the bench imports it. Drop the exemption.`);
  }
  process.exit(1);
}
console.log(`lint:bench-mirrors-guards ✓ every chat guard is in the bench or says why not (${Object.keys(NOT_IN_THE_BENCH).length} exempt).`);
