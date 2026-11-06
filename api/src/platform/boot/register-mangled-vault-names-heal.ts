// Vault names an upload mangled before #9248: a heal pass on the kernel's sweep, never a walk of its own here.
import { bootPass } from "../boot-passes.js";
import { registerMangledVaultNamesHeal } from "../heal-mangled-vault-names.js";

export default bootPass({
  name: "registerMangledVaultNamesHeal",
  phase: "before-migrations",
  run: () => registerMangledVaultNamesHeal(),
});
