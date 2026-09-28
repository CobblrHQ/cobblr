// Guard: the BEST-EFFORT half of a main commit's deploy never exits non-zero.
//
// Why this is a real trap: the deploy jobs are `continue-on-error: true`, which
// spares the workflow RUN but (in our Forgejo runner) does NOT keep the job's
// per-commit STATUS context green. So a step that exits 1 still reds
// `Docker Build / deploy-trigger` (or, from its step, main's `CI / test`), which reds the
// whole commit, even though the images already built and pushed and
// Watchtower's poll delivers them anyway. That exact false-red happened
// 2026-07-21: a momentary tailnet blip made the Watchtower poke return HTTP 000,
// the step `exit 1`'d, and main went red while staging deployed the very same
// sha two minutes later via the poll.
//
// The deploy is one script, scripts/deploy-when-ready.mjs, called from both
// halves (docker-build.yml's deploy-trigger after the push, and the last
// step of ci.yml's test job on main; whichever finishes second deploys). So
// the rule is held on the script:
//   - its `trigger()` (the cloud-overlay dispatch and the Watchtower poke) never
//     calls process.exit and never throws;
//   - the ONE non-zero exit that is a verdict is the block on a failed test,
//     `process.exit(1)` on the line that tests `d.action === "block"`; the only
//     other is the usage error (exit 2), a misconfigured workflow, which should
//     be loud;
//   - both workflows still call it, so neither half quietly stops deploying.
// Run: npx tsx scripts/lint-deploy-poke-nonfatal.ts
import { readFileSync, existsSync } from "node:fs";

const SCRIPT = process.env.DEPLOY_POKE_SCRIPT ?? "scripts/deploy-when-ready.mjs";
const CALLERS: Array<[string, string]> = [
  [process.env.DEPLOY_POKE_DOCKER_WF ?? ".forgejo/workflows/docker-build.yml", "deploy-when-ready.mjs --side images"],
  [process.env.DEPLOY_POKE_CI_WF ?? ".forgejo/workflows/ci.yml", "deploy-when-ready.mjs --side test"],
];

const problems: string[] = [];

if (!existsSync(SCRIPT)) {
  console.error(`deploy-poke-nonfatal lint: ${SCRIPT} is missing. If the deploy moved, update this lint rather than deleting it.`);
  process.exit(1);
}
const src = readFileSync(SCRIPT, "utf8");
const lines = src.split("\n");

/** The body of `async function trigger()`, to its closing brace at column 0. */
const start = lines.findIndex((l) => /^async function trigger\(\)/.test(l));
if (start === -1) {
  problems.push(`${SCRIPT}: no \`async function trigger()\`; the best-effort half is no longer where this lint looks. Update the lint in the same change.`);
} else {
  for (let i = start + 1; i < lines.length && !/^\}/.test(lines[i] ?? ""); i++) {
    const code = (lines[i] ?? "").replace(/^\s+/, "");
    if (code.startsWith("//")) continue;
    if (/\bprocess\.exit\s*\(/.test(code) || /\bthrow\b/.test(code)) {
      problems.push(`${SCRIPT}:${i + 1}: \`${code.slice(0, 90)}\`: the trigger is best-effort; log and carry on, never exit or throw.`);
    }
  }
}

lines.forEach((l, i) => {
  const m = /\bprocess\.exit\s*\(\s*([^)\s]+)\s*\)/.exec(l);
  if (!m || m[1] === "0") return;
  if (m[1] === "1" && /d\.action === "block"/.test(l)) return;
  if (m[1] === "2" && /usage|side !== /.test(lines.slice(Math.max(0, i - 3), i + 1).join("\n"))) return;
  problems.push(`${SCRIPT}:${i + 1}: \`${l.trim().slice(0, 90)}\`: a non-zero exit that is not the failed-test block reds the commit.`);
});

for (const [wf, call] of CALLERS) {
  if (!existsSync(wf) || !readFileSync(wf, "utf8").includes(call)) {
    problems.push(`${wf}: no longer runs \`${call}\`, so that half of the deploy never fires.`);
  }
}

if (problems.length) {
  console.error(`deploy-poke-nonfatal lint: the deploy can red a commit, or has lost a door.\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\n  A failed deploy nudge must not fail the build: the images are pushed and\n` +
      `  Watchtower's poll delivers them. Log a warning and carry on.`,
  );
  process.exit(1);
}

console.log(`deploy-poke-nonfatal lint: the deploy's trigger stays non-fatal, and both halves call it ✓`);
