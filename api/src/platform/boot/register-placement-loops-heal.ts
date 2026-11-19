// Things saved inside each other before the placement lock: a heal pass on
// the kernel's sweep, never a walk of its own here.
import { bootPass } from "../boot-passes.js";
import { registerPlacementLoopsHeal } from "../heal-placement-loops.js";

export default bootPass({
  name: "registerPlacementLoopsHeal",
  phase: "before-migrations",
  run: () => registerPlacementLoopsHeal(),
});
