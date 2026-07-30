// core-import — migrate an inventory from another system into Cobblr. A
// schemaless CAPABILITY (no tables, no nav noun, auto-on): it owns no data of
// its own, it just parses a foreign export and fans the records out to the
// modules that DO own them — locations, inventory, tags — through their public
// APIs (never a cross-module import). One source adapter per system; Homebox is
// the first (`services/homebox.ts`), Snipe-IT etc. slot in beside it.
//
// No `schema` block: like core-search, this is entirely a router.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-import",
  version: "0.1.0",
  displayName: "Import",
  description:
    "Migrate an inventory in from another system (Homebox today): items, the location hierarchy, and labels, mapped onto Cobblr's own modules.",
  icon: "download",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  api: () => import("./api/index.js"),

  intents: [
    { name: "import", description: "Bring records in from another inventory system" },
  ],

  dependencies: [],

  provides: { entityKinds: [] },

  exposes: {
    events: [],
    api: ["import"],
    actions: [],
  },

  subscribes: [],
});
