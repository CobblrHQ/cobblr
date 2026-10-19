// core-scan:lookup-barcode: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "more",
  // UI-SCREEN: /records
  id: "core-scan:lookup-barcode",
  changes: "records",
  runBy: "member",
  examples: ["what is this barcode?", "look up this ISBN"],
  label: "Look up a barcode",
  description: "Look up a UPC, EAN, GTIN or ISBN without filing anything. Returns product fields and records already in this workspace. Args: { code }.",
  scope: "workspace",
  invokeHandler: "core-scan.lookup-barcode",
  userInvokable: true,
  argsSchema: { code: { label: "Barcode", type: "text", required: true } },
};

export default action;
