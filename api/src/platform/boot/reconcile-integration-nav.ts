import { bootPass } from "../boot-passes.js";
import { reconcileIntegrationNav } from "../integration-nav.js";

export default bootPass({
  name: "reconcileIntegrationNav",
  phase: "after-migrations",
  run: () => reconcileIntegrationNav(),
});
