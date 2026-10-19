import { bootPass } from "../boot-passes.js";
import { healStrayInstanceLookKeysAtBoot } from "../heal-stray-instance-look-keys.js";

export default bootPass({
  name: "healStrayInstanceLookKeys",
  phase: "workspaces",
  after: ["healCopiedCollectionLooks"],
  run: () => healStrayInstanceLookKeysAtBoot(),
});
