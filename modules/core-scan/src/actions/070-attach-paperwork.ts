// core-scan:attach-paperwork: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // UI-SCREEN: /scan
  group: "more",
  id: "core-scan:attach-paperwork",
  changes: "records",
  runBy: "member",
  examples: ["attach this bill of sale to the Civic", "this receipt is for my mower, put it on it"],
  label: "Attach paperwork to a record",
  description:
    "Put a document (a bill of sale, a receipt, an invoice: a stored file) on a record the workspace already has. The file is kept on the record, the purchase it shows is recorded with every line and its line claimed for the record, and the record's EMPTY fields are filled from it by meaning: Paid, Purchased at, Bought from, and for a vehicle its VIN, make, model, year and mileage. A field that already holds a different value is never written; it comes back in `conflicts` to ask about. A document with several things on it, or none, is kept as a file only. Args: { file_id, kind, id } (the record's kind and id).",
  scope: "workspace" as const,
  argsSchema: {
    file_id: { label: "The document's stored file", type: "text", required: true },
    kind: { label: "The record's kind", type: "text", required: true },
    id: { label: "The record's id", type: "text", required: true },
  },
  invokeHandler: "core-scan.attach-paperwork",
  userInvokable: false,
};

export default action;
