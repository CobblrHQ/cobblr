// Arrivals of offers an ended share called off before #9133: a heal pass on
// the kernel's sweep, never a walk of its own here.
import { bootPass } from "../boot-passes.js";
import { registerCalledOffArrivalsHeal } from "../heal-called-off-arrivals.js";

export default bootPass({
  name: "registerCalledOffArrivalsHeal",
  phase: "before-migrations",
  run: () => registerCalledOffArrivalsHeal(),
});
