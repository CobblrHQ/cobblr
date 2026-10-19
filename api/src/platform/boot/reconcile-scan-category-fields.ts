// Give every workspace's scan FALLBACK table a category axis. Without one, the
// matchmaker's only way to say "this is electrical, that is plumbing" is to
// route them to different TABLES. Idempotent; a workspace that already has an
// axis costs one in-memory check and opens no tenant pool.
import { bootPass } from "../boot-passes.js";
import { reconcileScanCategoryFields } from "../reconcile-scan-category.js";

export default bootPass({
  name: "reconcileScanCategoryFields",
  phase: "workspaces",
  after: ["voidReadOnlyShareSuggestions"],
  run: () => reconcileScanCategoryFields(),
});
