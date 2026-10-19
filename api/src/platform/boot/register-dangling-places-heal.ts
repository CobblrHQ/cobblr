// Things still naming a place deleted before a delete emptied it: a heal pass
// on the kernel's sweep, never a walk of its own here.
import { bootPass } from "../boot-passes.js";
import { registerDanglingPlacesHeal } from "../heal-dangling-places.js";

export default bootPass({
  name: "registerDanglingPlacesHeal",
  phase: "before-migrations",
  run: () => registerDanglingPlacesHeal(),
});
