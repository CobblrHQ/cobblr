// The reconciler's home is the shared contract, because BOTH sides need it: the
// server agrees a category across a scan session, and the scan inbox header
// offers "File all N into <it>". A second copy in web would be the same two-
// views-of-one-fact drift this codebase keeps relearning, so there is one
// implementation and this is a re-export of it.
export {
  normaliseCategory,
  displayCategory,
  unifyCategories,
  type CategoryConsensus,
} from "@cobblr/platform-contract/category-reconcile";
