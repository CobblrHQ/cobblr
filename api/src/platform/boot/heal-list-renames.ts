// List renames the assistant wrote under the bare list name, which nothing
// read (#4495): folded into the row the app reads. One cobblr_meta read.
import { bootPass } from "../boot-passes.js";
import { healListRenames } from "../heal-list-renames.js";

export default bootPass({
  name: "healListRenames",
  phase: "workspaces",
  after: ["backfillBundleClaims"],
  run: () => healListRenames(),
  report: (r) => (r > 0 ? `list renames healed: ${r}` : null),
});
