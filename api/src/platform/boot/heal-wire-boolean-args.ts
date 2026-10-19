// A wire saved with a boolean argument as "true" is saved as true (#6130).
import { bootPass } from "../boot-passes.js";
import { healWireBooleanArgs } from "../heal-wire-boolean-args.js";

export default bootPass({
  name: "healWireBooleanArgs",
  phase: "after-migrations",
  after: ["backfillDefaultBindings"],
  run: () => healWireBooleanArgs(),
});
