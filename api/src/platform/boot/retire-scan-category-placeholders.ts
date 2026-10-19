// After the mount, not with the axis pass: the values it moves live in a
// module's own table and only that module's writer (registered by its api
// bundle, just mounted) may move them. See retireScanCategoryPlaceholders.
import { bootPass } from "../boot-passes.js";
import { retireScanCategoryPlaceholders } from "../reconcile-scan-category.js";

export default bootPass({
  name: "retireScanCategoryPlaceholders",
  phase: "after-mount",
  run: () => retireScanCategoryPlaceholders(),
});
