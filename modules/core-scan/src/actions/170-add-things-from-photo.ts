// core-scan:add-things-from-photo: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "stock",
  // UI-SCREEN: /scan (a photo's card in the inbox: "Split by names…")
  id: "core-scan:add-things-from-photo",
  changes: "records",
  runBy: "member",
  examples: ["this photo is two dehumidifiers, the Midea on the left and the Frigidaire on the right"],
  label: "Add several things from one photo",
  description: "Add several things shown in one photo, each from what you say about it: Cobblr finds where each sits, crops it, and puts each in the inbox with its crop as its picture, kept together as one group with Undo split. Pass the photo (image_file_id, uploaded first, or item_id of a photo already in the inbox) and items, a list with what add_thing takes for each (name, fields, quantity, identifier, goes_to, place, roles) plus optional where (\"left\", \"the black one\") or box (fractions x, y, w, h). When the photo shows a different number of things than listed, nothing is added and the answer says what it saw.",
  scope: "workspace",
  invokeHandler: "core-scan.add-things-from-photo",
  userInvokable: true,
  // Undo split on the group puts the photo back as one.
  undoable: true,
  argsSchema: {
    image_file_id: { label: "The photo, uploaded first (or item_id instead)", type: "text" },
    item_id: { label: "Or a photo already in the inbox, by its id", type: "text" },
    items: { label: "What is in it: a list of things, each with name and what add_thing takes, plus where or box", type: "json", required: true },
  },
};

export default action;
