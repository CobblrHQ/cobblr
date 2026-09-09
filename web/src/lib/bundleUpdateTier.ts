// The classifier lives in the contract now: the api applies patch/minor
// updates on its own and must grade them exactly the way this page reports
// them. Kept as a re-export so nothing here had to move.
export {
  classifyBundleUpdate,
  isDowngradeOrSame,
  tierAutoApplies,
  manifestShipsCatalogs,
  updateMayTeardownCatalogs,
  type BundleUpdateTier,
} from "@cobblr/platform-contract/bundle-update-tier";
