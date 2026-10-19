// Put back scan names a Replay truncated before 2026-08-12 (a cache miss
// degraded to the keyword heuristic, whose candidate name then overwrote the
// real one). The user did nothing to cause it, so the platform undoes it.
import { bootPass } from "../boot-passes.js";
import { repairReplayTruncatedNames } from "../repair-replay-truncated-names.js";

export default bootPass({
  name: "repairReplayTruncatedNames",
  phase: "workspaces",
  run: () => repairReplayTruncatedNames(),
  report: (r) => (r.rowsRepaired > 0 ? `replay-truncated scan names: ${r.rowsRepaired} restored across ${r.orgsTouched} workspace(s)` : null),
});
