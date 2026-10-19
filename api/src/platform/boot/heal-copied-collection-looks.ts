import { bootPass } from "../boot-passes.js";
import { healCopiedCollectionLooksAtBoot } from "../heal-copied-collection-looks.js";

export default bootPass({
  name: "healCopiedCollectionLooks",
  phase: "workspaces",
  after: ["reconcileShareSpaces"],
  run: () => healCopiedCollectionLooksAtBoot(),
});
