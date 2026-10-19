// core-scan:identify: one action, one file (#7382). module.ts finds every file in this
// directory, in name order, so adding an action touches no shared file.
import type { ModuleActionInput } from "@cobblr/platform-contract";

const action: ModuleActionInput = {
  group: "more",
  id: "core-scan:identify",
  changes: "records",
  runBy: "member",
  examples: ["what is this thing", "identify this for me"],
  label: "Identify a thing",
  description:
    "PURE 'what is this?': from a photo and/or captured measurements + observations. Returns the suggestion ({ name, brand, category, confidence }); writes nothing. A capture app calls it and decides whether to use the suggestion or keep its own name. User-invokable. Args: { image_file_id?, measurements?, observations? }.",
  // Args-driven: a capture app supplies the photo/measurements, and the
  // handler reads no record at all. As an entity action it rendered on
  // every record and, pressed from a detail page with no args, answered
  // `{ identified: false, reason: "nothing to identify" }` - a button
  // that could only ever do nothing.
  scope: "workspace" as const,
  invokeHandler: "core-scan.identify",
  userInvokable: true,
};

export default action;
