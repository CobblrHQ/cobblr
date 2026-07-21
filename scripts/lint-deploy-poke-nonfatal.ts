// Guard: the BEST-EFFORT steps of docker-build.yml's `deploy-trigger` job must
// never exit non-zero.
//
// Why this is a real trap: the job is `continue-on-error: true`, which spares the
// workflow RUN but (in our Forgejo runner) does NOT keep the job's per-commit
// STATUS context green. So a step here that `exit 1`s still reds
// `Docker Build / deploy-trigger`, which reds the whole commit — even though the
// images already built + pushed and Watchtower's 600s poll delivers them anyway.
// That exact false-red happened 2026-07-21: a momentary tailnet blip made the
// Watchtower poke return HTTP 000, the step `exit 1`'d, and main went red while
// staging deployed the very same sha two minutes later via the poll.
//
// Nothing else catches this: the YAML stays valid and every OTHER context is
// green, so the failure is one red context on an otherwise-shipped build. This
// lint keeps the "deploy NOW" nudge (and the cloud-overlay dispatch) strictly
// best-effort: they may log a warning, they may not fail the build.
//
// The GATE step is exempt — it SHOULD `exit 1` to block a deploy on a real test
// failure. Only the two side-effect steps below are covered.
// Run: npx tsx scripts/lint-deploy-poke-nonfatal.ts

import { readFileSync, existsSync } from "node:fs";

const WF = ".forgejo/workflows/docker-build.yml";

// The best-effort steps, by a stable substring of their `- name:`. If a step is
// renamed, this lint fails loudly (below) rather than silently covering nothing —
// update the substring here in the same change.
const BEST_EFFORT_STEPS = [
  "Rebuild the cloud-api overlay",
  "Trigger Watchtower deploy",
];

if (!existsSync(WF)) {
  console.error(`deploy-poke-nonfatal lint: ${WF} is missing. If the workflow was renamed, update this lint rather than deleting it.`);
  process.exit(1);
}

const lines = readFileSync(WF, "utf8").split("\n");

/** Lines of a step's body, from its `- name:` bullet (exclusive) to the next
 *  step bullet / job / top-level key. Steps here are bulleted at 6 spaces. */
function stepBody(nameSubstring: string): string[] | null {
  const startBullet = /^ {6}- /;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startBullet.test(lines[i]!) && lines[i]!.includes(nameSubstring)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const body: string[] = [];
  for (let j = start + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (startBullet.test(l)) break; // next step
    if (/^ {0,4}\S/.test(l)) break; // next job (2 sp) or top-level key (0 sp)
    body.push(l);
  }
  return body;
}

const problems: string[] = [];

for (const name of BEST_EFFORT_STEPS) {
  const body = stepBody(name);
  if (body === null) {
    console.error(
      `deploy-poke-nonfatal lint: could not find the "${name}" step in ${WF}.\n` +
        `  If it was renamed, update BEST_EFFORT_STEPS in this lint. A best-effort\n` +
        `  deploy step must never exit non-zero (it reds main on a transient blip).`,
    );
    process.exit(1);
  }
  body.forEach((l, k) => {
    const code = l.replace(/^\s+/, "");
    if (code.startsWith("#")) return; // skip bash/YAML comments
    // `exit 0` is fine; `exit 1`..`exit 9` (or `exit $?` after a failing cmd) is not.
    if (/\bexit\s+[1-9]/.test(code)) {
      problems.push(`  "${name}" -> ${l.trim()}`);
    }
  });
}

if (problems.length) {
  console.error(`deploy-poke-nonfatal lint: a best-effort deploy step exits non-zero.\n`);
  for (const p of problems) console.error(p);
  console.error(
    `\n  These steps are continue-on-error but STILL post a red commit-status context\n` +
      `  when a step fails, which reds main. The images are already pushed and\n` +
      `  Watchtower's ~10-min poll delivers them, so a flaky nudge must not fail the\n` +
      `  build. Log a warning and \`exit 0\` instead (see the 200/429/000 case block).`,
  );
  process.exit(1);
}

console.log(
  `deploy-poke-nonfatal lint: ${BEST_EFFORT_STEPS.length} best-effort deploy steps stay non-fatal ✓`,
);
