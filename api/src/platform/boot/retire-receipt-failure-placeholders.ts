// A receipt whose read failed used to be a placeholder inbox row; it is a
// state on the session now. Move the rows already written so nobody cleans up
// by hand.
import { bootPass } from "../boot-passes.js";
import { retireReceiptFailurePlaceholders } from "../retire-receipt-failure-placeholders.js";

export default bootPass({
  name: "retireReceiptFailurePlaceholders",
  phase: "workspaces",
  after: ["repairReplayTruncatedNames"],
  run: () => retireReceiptFailurePlaceholders(),
  report: (r) => (r.rowsRetired > 0 ? `receipt-failure placeholders: ${r.rowsRetired} retired into session state across ${r.orgsTouched} workspace(s)` : null),
});
