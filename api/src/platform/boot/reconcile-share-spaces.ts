import { bootPass } from "../boot-passes.js";
import { reconcileShareSpaces } from "../reconcile-share-spaces.js";

export default bootPass({
  name: "reconcileShareSpaces",
  phase: "workspaces",
  after: ["reconcileOrphanTenantRoles"],
  run: () => reconcileShareSpaces(),
});
