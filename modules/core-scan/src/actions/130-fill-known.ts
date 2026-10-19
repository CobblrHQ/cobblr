// core-scan:fill-known: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  // NO-PHRASING: a table's own wire runs it when a record is made or changed; the person's door is the record's identifier box
  group: "more",
  id: "core-scan:fill-known",
  changes: "records",
  // ADMIN-ONLY: fills any kind's empty fields through its writer; no one page gate covers every kind it may write
  runBy: "admin",
  label: "Fill what the record already says",
  description:
    "Fill a record's EMPTY fields from what it already carries: its identifier (a VIN, read by the decoder) and its own name (\"Yamaha YZF-R3, Blue\" with Make Yamaha says the model). Never touches a field that holds a value. Wire-fired by a bundle on its table's created and updated events. Undoable.",
  // DELIBERATELY universal: a bundle's wire names the table; which fields
  // it can fill comes from the fields' declared decode roles, never a kind.
  appliesTo: { any: true },
  invokeHandler: "core-scan.fill-known",
  wireOnly: true,
  userInvokable: false,
  undoable: true,
};

export default action;
