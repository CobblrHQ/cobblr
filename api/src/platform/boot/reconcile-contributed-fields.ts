// A field a module contributes after a workspace enabled it reaches that
// workspace too (reconcile-contributed-fields.ts).
import { bootPass } from "../boot-passes.js";
import { reconcileContributedFields } from "../reconcile-contributed-fields.js";

export default bootPass({
  name: "reconcileContributedFields",
  phase: "after-migrations",
  run: () => reconcileContributedFields(),
  report: (r) => (r.added > 0 ? `contributed fields reconciled: ${r.added} added (${r.modules.join(", ")})` : null),
});
