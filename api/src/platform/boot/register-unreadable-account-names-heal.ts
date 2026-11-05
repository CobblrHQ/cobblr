// People and workspaces named nothing readable before the doors refused it: a
// heal pass on the kernel's sweep, never a walk of its own here.
import { bootPass } from "../boot-passes.js";
import { registerUnreadableAccountNamesHeal } from "../heal-unreadable-account-names.js";

export default bootPass({
  name: "registerUnreadableAccountNamesHeal",
  phase: "before-migrations",
  run: () => registerUnreadableAccountNamesHeal(),
});
