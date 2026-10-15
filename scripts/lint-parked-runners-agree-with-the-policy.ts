#!/usr/bin/env tsx
// The runners the A6 health tick keeps parked (PARKED_RUNNERS in scripts/ci-runner-health.sh) are exactly the pools the fleet policy parks (server-setup forge-ci/fleet-policy.json), so the tick and the controller never disagree about a runner
//
// THE BUG THIS PREVENTS. 2026-10-15: the fleet controller flipped cobblr-a6-2 between parked and base every
// few minutes, each time a would-be runner-down alert, because only the A6 health tick knew it was parked
// (the owner's "stop a6-2", 2026-10-08); the controller learned it from a health push it trusted for three
// minutes and got every five. The policy now parks it too (server-setup #281). Two lists of one fact drift
// unless something holds them equal.
//
// THE RULE. The default of PARKED_RUNNERS in scripts/ci-runner-health.sh, as a set, equals the runners of
// the pools whose host is "a6" and that carry "parked" in the sibling checkout's forge-ci/fleet-policy.json.
// A checkout without the sibling (CI, a machine without server-setup) skips, as lint:alert-lib-sync does;
// PARKED_POLICY_SIBLING points it elsewhere.
//
// THE BOUNDARY. Only the A6: PARKED_RUNNERS is the A6 tick's list, and other boxes park through their own
// STOPPED.md records, which the policy's sticky park reading covers. Nothing has tested the boundary yet.
//
//   npx tsx scripts/lint-parked-runners-agree-with-the-policy.ts   (pnpm lint parked-runners-agree-with-the-policy)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEALTH = process.env.PARKED_HEALTH_SCRIPT ?? join(ROOT, "scripts/ci-runner-health.sh");
const POLICY = process.env.PARKED_POLICY_SIBLING ?? resolve(ROOT, "../../server-setup/forge-ci/fleet-policy.json");

if (!existsSync(POLICY)) {
  console.log(`lint:parked-runners-agree-with-the-policy skipped (no sibling policy at ${POLICY})`);
  process.exit(0);
}
// A sibling checkout behind its own origin/main says nothing about what is merged: on 2026-10-15 the
// server-setup checkout beside core was two commits behind, and a lint reading it would have gone red on
// every push from this machine for a policy change already merged. Only a checkout at its origin/main is
// read (PARKED_POLICY_SIBLING, a test's fixture, is always read).
if (!process.env.PARKED_POLICY_SIBLING) {
  const git = (...a: string[]) => spawnSync("git", ["-C", dirname(POLICY), ...a], { encoding: "utf8", timeout: 20_000 }).stdout.trim();
  const head = git("rev-parse", "HEAD");
  const main = git("rev-parse", "origin/main");
  if (!head || !main || head !== main) {
    console.log(`lint:parked-runners-agree-with-the-policy skipped (the sibling server-setup checkout is not at its origin/main: pull it to check)`);
    process.exit(0);
  }
}
const m = /^PARKED_RUNNERS="\$\{CI_PARKED_RUNNERS:-([^}]*)\}"/m.exec(readFileSync(HEALTH, "utf8"));
if (!m) {
  console.error(`lint:parked-runners-agree-with-the-policy - ${HEALTH} has no PARKED_RUNNERS="\${CI_PARKED_RUNNERS:-...}" line to read`);
  process.exit(1);
}
const tick = new Set((m[1] ?? "").split(/\s+/).filter(Boolean));
const pools = (JSON.parse(readFileSync(POLICY, "utf8")) as { pools: Record<string, { runner: string; host: string; parked?: string }> }).pools;
const policy = new Set(Object.values(pools).filter((p) => p.host === "a6" && p.parked).map((p) => p.runner));
const onlyTick = [...tick].filter((r) => !policy.has(r));
const onlyPolicy = [...policy].filter((r) => !tick.has(r));
if (onlyTick.length || onlyPolicy.length) {
  console.error("lint:parked-runners-agree-with-the-policy - the A6 health tick and the fleet policy disagree about which runners are parked:");
  for (const r of onlyTick) console.error(`  ${r}: parked in PARKED_RUNNERS (scripts/ci-runner-health.sh) but not in ${POLICY}: park its pool there ("parked": "<why>")`);
  for (const r of onlyPolicy) console.error(`  ${r}: parked in ${POLICY} but not in PARKED_RUNNERS: add it, or un-park its pool`);
  process.exit(1);
}
console.log(`lint:parked-runners-agree-with-the-policy OK (${[...tick].join(", ") || "none"} parked in both)`);
