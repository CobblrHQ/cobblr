import { bootPass } from "../boot-passes.js";
import { voidReadOnlyShareSuggestionsAtBoot } from "../heal-void-share-suggestions.js";

export default bootPass({
  name: "voidReadOnlyShareSuggestions",
  phase: "workspaces",
  after: ["healStrayInstanceLookKeys"],
  run: () => voidReadOnlyShareSuggestionsAtBoot(),
});
