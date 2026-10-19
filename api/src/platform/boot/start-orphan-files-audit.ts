// Counts the files deleted workspaces left behind (dry run: erases nothing).
import { bootPass } from "../boot-passes.js";
import { startOrphanFilesAudit } from "../heal-orphan-files.js";

export default bootPass({
  name: "startOrphanFilesAudit",
  phase: "background",
  run: () => startOrphanFilesAudit(),
});
