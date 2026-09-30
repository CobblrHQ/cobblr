#!/usr/bin/env tsx
// A job reaches a machine only through sendAndWatch (the page's Send and the
// digifab:send action) or the pool worker, never a direct sendJob call, so the
// physical effect's consent guard has one door.
//
// THE BUG THIS PREVENTS. Starting a machine is the one effect Cobblr treats as
// physical: a person's yes stands in front of it from every door, an assistant,
// a wire, module code (Services §9, #4034). That guard reads the action's
// declared effect, so it only holds if the action is the door. Before digifab:send
// existed, five places called sendJob directly (the jobs route, retry, clone,
// the library's Send, the bed-clear resume), and a sixth added the same way
// would start a machine that no consent rule could see.
//
// THE RULE. In modules/digifab/src, `sendJob(` is called only in:
//   - api/jobs.ts, inside sendAndWatch (the one send the page and the action share);
//   - assign-worker.ts, the pool drip, which only sends jobs a person already
//     queued onto a pool (the yes was given when it was queued).
// Anything else calls sendAndWatch. A genuinely new internal door opts out by
// adding its file here, with the reason, in the same change.
//
// THE BOUNDARY. The definition (`export async function sendJob`) and tests are
// not calls. A call site is `sendJob(` not preceded by `function `.
//
//   npx tsx scripts/lint-machine-starts-through-send.ts   (pnpm lint machine-starts-through-send)
import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

const ALLOWED: Record<string, string> = {
  "modules/digifab/src/api/jobs.ts": "sendAndWatch, the one send the page and digifab:send share",
  "modules/digifab/src/assign-worker.ts": "the pool drip: sends only what a person queued onto a pool",
};

const files = sourceFiles("modules/digifab/src/**/*.{ts,tsx}").filter((p) => !/\.test\.tsx?$/.test(p));

const errors: string[] = [];
let jobsCalls = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/\bsendJob\(/.test(line) || /function\s+sendJob\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
    if (file === "modules/digifab/src/api/jobs.ts") {
      jobsCalls++;
      return;
    }
    if (ALLOWED[file]) return;
    errors.push(`${file}:${i + 1}: calls sendJob directly; go through sendAndWatch (api/jobs.ts) so digifab:send's physical effect covers it`);
  });
}
// Inside jobs.ts the call belongs to sendAndWatch alone.
if (jobsCalls !== 1) errors.push(`modules/digifab/src/api/jobs.ts: sendJob is called ${jobsCalls} times; only sendAndWatch may call it`);

if (errors.length) {
  console.error(`lint:machine-starts-through-send - ${errors.length} violation(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log("lint:machine-starts-through-send OK - every send goes through sendAndWatch or the pool worker");
