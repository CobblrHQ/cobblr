// A workspace that approved its own AI key and never had it switched on (#7679:
// restored, because 2026.8.1 already wrote those rows). A vacancy only: a live
// AI is never overridden.
import { bootPass } from "../boot-passes.js";
import { healApprovedButInactiveAi } from "../heal-approved-ai.js";

export default bootPass({
  name: "healApprovedButInactiveAi",
  phase: "after-migrations",
  after: ["backfillDefaultBindings"],
  run: () => healApprovedButInactiveAi(),
  report: (r) => (r.length ? `approved-but-idle AI switched on in ${r.length} workspace(s)` : null),
});
