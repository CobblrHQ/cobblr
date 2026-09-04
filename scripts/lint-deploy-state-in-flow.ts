// The scripts an agent already runs must SAY where the code is.
//
// Everyone here works from stale assumptions about the channels, because
// nothing tells them and checking is a detour nobody takes mid-task. On
// 2026-09-04 one agent believed the nightly was the one it had cut the previous
// evening (the 04:00 run had moved it overnight) and another was working to a
// promote rule that stopped being true on 2026-09-01. Both were confidently
// wrong about whether a user's fix had reached them.
//
// Researching it per task is the wrong answer: it spends tokens re-deriving
// something the machine knows. So merge-pr.sh (you just shipped) and
// new-worktree.sh (you are starting) print it, and this keeps them doing it -
// a status line is exactly the kind of thing that gets dropped in a refactor
// and missed by everyone, because nothing fails when it disappears.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MUST_REPORT = ["scripts/merge-pr.sh", "scripts/new-worktree.sh"];

const missing = MUST_REPORT.filter((f) => {
  const src = readFileSync(join(ROOT, f), "utf8");
  return !src.includes("deploy_state_brief");
});

if (missing.length) {
  console.error("lint:deploy-state-in-flow - scripts an agent runs, that no longer say where the code is:\n");
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    "\nEach must source scripts/lib/deploy-state.sh and call deploy_state_brief.\n" +
      "Without it the next person assumes the nightly is whatever it was last time\n" +
      "they looked, and tells a self-hoster their fix is available when it is not.\n",
  );
  process.exit(1);
}
console.log("lint:deploy-state-in-flow - merge and worktree scripts report the channel state.");
