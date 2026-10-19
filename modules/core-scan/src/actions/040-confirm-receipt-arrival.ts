// core-scan:confirm-receipt-arrival: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "more",
  // UI-SCREEN: /me/notifications (the parcel notification carries its receipt session)
  id: "core-scan:confirm-receipt-arrival",
  changes: "records",
  runBy: "member",
  examples: ["I have the parcel", "the package is here", "got the delivery in hand"],
  label: "Confirm a parcel is in hand",
  description:
    "Record that a tracked receipt's parcel physically arrived: stamps the receipt confirmed, which ends the carrier watch for it. The receipt itself still gets filed in the inbox. Idempotent. Args: { batch_id }.",
  invokeHandler: "core-scan.confirm-receipt-arrival",
  // It acts on a receipt SESSION, named by batch_id, and a receipt session
  // is not an entity kind. Declared with no appliesTo it defaulted to
  // universal and became a button on every record in every workspace,
  // where pressing it could only ever answer "no receipt in scope"
  // (audit, 2026-09-08). Workspace scope is the honest shape: reachable
  // by the assistant and by the notification button that carries the id,
  // never offered on a record.
  scope: "workspace" as const,
  argsSchema: {
    batch_id: { label: "Which receipt session", type: "text" },
  },
  userInvokable: true,
};

export default action;
