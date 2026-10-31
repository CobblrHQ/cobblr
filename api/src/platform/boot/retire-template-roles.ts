import { bootPass } from "../boot-passes.js";
import { retireUnusedTemplateRoles } from "../retire-template-roles.js";

export default bootPass({
  name: "retireUnusedTemplateRoles",
  phase: "background",
  run: () => retireUnusedTemplateRoles(),
  report: (dropped) => (dropped.length ? `workspace template roles retired: ${dropped.join(", ")}` : null),
});
