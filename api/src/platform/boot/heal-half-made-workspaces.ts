// Finish the workspaces an older signup left with no database (one-shot).
import { bootPass } from "../boot-passes.js";
import { healHalfMadeWorkspaces } from "../heal-half-made-workspaces.js";

export default bootPass({
  name: "healHalfMadeWorkspaces",
  phase: "background",
  run: () => healHalfMadeWorkspaces(),
});
