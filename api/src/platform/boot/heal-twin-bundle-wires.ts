// A bundle wire installed at both scopes fired twice per event; 2026.8.1's
// Groceries, Spice Rack and Tea declared them that way (#7679: restored). One
// cobblr_meta query, no tenant pool.
import { bootPass } from "../boot-passes.js";
import { healTwinBundleWires } from "../heal-twin-bundle-wires.js";

export default bootPass({
  name: "healTwinBundleWires",
  phase: "after-migrations",
  run: () => healTwinBundleWires(),
  report: (r) => (r.rowsDropped > 0 ? `twin bundle wires dropped: ${r.rowsDropped} row(s) in ${r.orgsHealed} workspace(s)` : null),
});
