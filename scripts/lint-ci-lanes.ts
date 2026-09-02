#!/usr/bin/env tsx
/**
 * lint:ci-lanes — the `test` gate and the `test-full` tracker are one job in two places.
 *
 * ci.yml's tracker lane is a literal copy of the test job. It was written once
 * as a YAML anchor reused by both jobs; Forgejo's job parser splits jobs
 * before resolving the document, so the alias found nothing and the WHOLE
 * workflow was marked invalid ("unknown anchor 'test-env'", 2026-09-02): no
 * typecheck, no test, a red PR with nothing to read. Two copies it is, and two
 * copies drift: a step added to the gate and not the tracker means the full
 * suite runs in a different harness from the one the deploy trusted, and the
 * scorecard compares two different things.
 *
 * Text comparison on purpose (comments included, no YAML library needed): the
 * two blocks must be identical from `env:` to the end, except LANE.
 */
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const src = readFileSync(`${ROOT}/.forgejo/workflows/ci.yml`, "utf8");

function job(id: string): string | null {
  // Lazy up to the next top-level job, a top-level comment, or the end of the
  // file (`(?![\\s\\S])`, NOT `$`: with the m flag `$` is every line end).
  const m = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^  #|(?![\\s\\S]))`, "m").exec(src);
  return m ? m[1]! : null;
}
function body(text: string): string {
  // from the env block on: runs-on / if above it are allowed to differ
  const i = text.indexOf("    env:\n");
  return i >= 0 ? text.slice(i) : text;
}

const problems: string[] = [];
const gate = job("test");
const trk = job("test-full");
if (!gate || !trk) problems.push("ci.yml must have both a `test` job and a `test-full` job");
else {
  if (!/^    runs-on: ci-test\n/m.test(gate)) problems.push("`test` must run on ci-test");
  if (!/^    runs-on: ci-test-full\n/m.test(trk)) problems.push("`test-full` must run on ci-test-full");
  // The tracker must never run on a PR: there the gate is the whole answer, and
  // a second full suite per push would double the queue for nothing. It DOES
  // run on a dispatch and on the nightly heartbeat, where a full check is the
  // point. So the rule is "not on a pull_request", not "only on a push".
  if (!/^    if: github\.event_name != 'pull_request'\n/m.test(trk)) {
    problems.push("`test-full` must carry `if: github.event_name != 'pull_request'` (never on a PR; push, dispatch and schedule are all fine)");
  }
  const g = body(gate), t = body(trk);
  if (!/^      LANE: gate\n/m.test(g)) problems.push("`test` env must carry LANE: gate");
  if (!/^      LANE: full\n/m.test(t)) problems.push("`test-full` env must carry LANE: full");
  const gl = g.replace(/^      LANE: gate\n/m, "      LANE: <lane>\n").trimEnd().split("\n");
  const tl = t.replace(/^      LANE: full\n/m, "      LANE: <lane>\n").trimEnd().split("\n");
  const n = Math.max(gl.length, tl.length);
  for (let i = 0; i < n; i++) {
    if (gl[i] !== tl[i]) {
      problems.push(`the two lanes diverge at line ${i + 1} of their bodies:\n      test:      ${gl[i] ?? "(end)"}\n      test-full: ${tl[i] ?? "(end)"}\n      Edit the \`test\` job, then copy its env+steps block over \`test-full\` (only runs-on, if and LANE may differ).`);
      break;
    }
  }
}
if (problems.length) {
  console.error("lint:ci-lanes FAILED\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`lint:ci-lanes OK (test and test-full bodies identical but LANE, ${body(gate!).split("\n").length} lines)`);
