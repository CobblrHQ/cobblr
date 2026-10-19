// core-scan:unfill-known: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // NO-PHRASING: the undo step of fill-known, handed back on its card
  // DELIBERATELY universal: the undo of fill-known, which runs on whatever record that did.
  group: "more",
  id: "core-scan:unfill-known",
  // ADMIN-ONLY: fill-known's undo, as above
  runBy: "admin",
  label: "Empty what was filled",
  description:
    "Undo of fill-known: empty the fields it filled, only where each still holds the value it put there. Args: { filled }.",
  appliesTo: { any: true },
  changes: "records",
  invokeHandler: "core-scan.unfill-known",
  userInvokable: false,
  internal: true,
};

export default action;
