#!/usr/bin/env tsx
/**
 * lint:latest-monotonic — `:latest` may only ever ADVANCE to a newer commit.
 *
 * :latest is what staging, the canary's web and the cloud overlay's rebuild pull. Since 2026-10-20 it is a judged
 * commit's image: builds push only :<sha>, and the deploy (deploy-when-ready.mjs) moves :latest to the commit whose
 * test passed, forward only by commit time against what :latest points at now (lib/registry-latest.mjs). Before
 * that, :latest was pushed at build, and with main tested once for each set the merge queue lands it ran ahead of
 * the verdict: staging pulled d21deb10, which no test had judged.
 *
 * This checks no build pushes :latest, and the deploy's guard is still there and runs before it triggers.
 */
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = ".forgejo/workflows/docker-build.yml";
const src = readFileSync(`${ROOT}/${FILE}`, "utf8");

const problems: string[] = [];
// SINCE 2026-10-20 :latest is a judged commit's image. A build pushes only :<sha>; the deploy moves :latest to the
// commit whose test passed (scripts/deploy-when-ready.mjs), forward only, against what :latest points at now
// (scripts/lib/registry-latest.mjs latestMove). A build that pushed :latest again would put an unjudged commit on
// staging the moment it finished (d21deb10 on 2026-10-20).
if (/-t "[^"]*:latest"/.test(src) || /docker push "[^"]*:latest"/.test(src)) {
  problems.push(`${FILE} tags or pushes :latest at build again: only the deploy moves it, to a judged commit.`);
}
const LIB = "scripts/lib/registry-latest.mjs";
const lib = readFileSync(`${ROOT}/${LIB}`, "utf8");
if (!/export function latestMove\(judgedTs, currentTs\)/.test(lib) || !/currentTs > judgedTs/.test(lib)) {
  problems.push(`${LIB} no longer compares the judged commit's time against what :latest points at now.`);
}
const DEPLOY = "scripts/deploy-when-ready.mjs";
const deploy = readFileSync(`${ROOT}/${DEPLOY}`, "utf8");
const moveIdx = deploy.search(/await moveLatest\(/);
const triggerIdx = deploy.search(/\n {2}await trigger\(\);/);
if (moveIdx < 0 || triggerIdx < 0 || moveIdx > triggerIdx) {
  problems.push(`${DEPLOY}: the deploy does not move :latest to the judged commit before it triggers.`);
}
// One build at a time, the latest waiting (#3551). A per-commit group lets a
// burst of merges build concurrently for commits main has already passed. A judged commit's own pinned build
// (inputs.sha, 2026-10-20) has a group of its own, so the next push neither cancels it nor is cancelled by it;
// every push still shares the one per ref.
if (!/^\s*group: docker-build-\$\{\{ github\.ref \}\}(?:\$\{\{ inputs\.sha && format\('-\{0\}', inputs\.sha\) \|\| '' \}\})?\s*$/m.test(src)) {
  problems.push(`${FILE}: the build group is no longer one per ref, so a burst of merges builds every commit at once (#3551). If that is deliberate, it is the owner's call to reverse; read this lint's header.`);
}
if (!/context:"image \/ superseded"/.test(src)) {
  problems.push(`${FILE}: the gate no longer marks a superseded commit ("image / superseded"), so a commit with no image says nothing about why.`);
}

if (problems.length) {
  console.error("lint:latest-monotonic FAILED\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("\n  :latest is what staging, the canary's web and the cloud overlay pull: it must be a judged commit, moving forward.");
  process.exit(1);
}
console.log("lint:latest-monotonic OK (no build pushes :latest; the deploy moves it forward to a judged commit)");
