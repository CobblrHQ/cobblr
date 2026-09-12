#!/usr/bin/env tsx
/**
 * lint:latest-monotonic — `:latest` may only ever ADVANCE to a newer commit.
 *
 * Main's CI and image builds run one group PER COMMIT, so two merges in quick
 * succession build at the same time on different machines and can finish in
 * either order. That is only safe because the push step refuses to move
 * `:latest` backwards: it reads the commit timestamp off the image `:latest`
 * currently points at and skips its own push when that one is newer.
 *
 * Take the guard away and nothing fails, nothing goes red, and the fleet
 * quietly starts deploying whichever build happened to finish last — which on
 * two boxes of different speeds is regularly the older one. Deploy-trigger
 * cannot save you either: it carries no version, it just tells Watchtower to
 * pull `:latest`, so a wrong `:latest` IS a wrong deploy.
 *
 * This checks the guard is still there and still compares before pushing.
 */
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = ".forgejo/workflows/docker-build.yml";
const src = readFileSync(`${ROOT}/${FILE}`, "utf8");

const problems: string[] = [];
const needs: Array<[RegExp, string]> = [
  [/cobblr\.commit-ts/, "reads the `cobblr.commit-ts` label off the current :latest"],
  [/MY_TS=\$\(git show -s --format=%ct HEAD\)/, "reads this commit's timestamp (MY_TS)"],
  [/\[\s*"\$CUR_TS"\s*-gt\s*"\$MY_TS"\s*\]/, "compares :latest's timestamp against this commit's"],
  [/not regressing it to/, "says plainly, in the log, when it declines to move :latest"],
];
for (const [re, what] of needs) {
  if (!re.test(src)) problems.push(`${FILE} no longer ${what}.`);
}
// The comparison must GUARD the push, not merely appear somewhere in the file.
const guardIdx = src.search(/\[\s*"\$CUR_TS"\s*-gt\s*"\$MY_TS"\s*\]/);
const pushIdx = src.search(/docker push "\$IMG:latest"/);
if (guardIdx < 0 || pushIdx < 0 || guardIdx > pushIdx) {
  problems.push(`${FILE}: the :latest push is not behind the timestamp comparison.`);
}
// Per-commit groups are the reason this matters; say so if they ever go away.
if (!/group: docker-build-\$\{\{ github\.ref \}\}-\$\{\{ github\.ref == 'refs\/heads\/main' && github\.sha/.test(src)) {
  problems.push(`${FILE}: main no longer builds one group per commit — if that was deliberate, this lint's premise changed; read its header before deleting it.`);
}

if (problems.length) {
  console.error("lint:latest-monotonic FAILED\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("\n  Two merges can build concurrently on two boxes and finish in either order.");
  console.error("  Without this guard the later-finishing OLDER build wins :latest, and Watchtower deploys it.");
  process.exit(1);
}
console.log("lint:latest-monotonic OK (:latest advances only, and the push is behind the check)");
