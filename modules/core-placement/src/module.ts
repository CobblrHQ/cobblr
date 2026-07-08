// core-placement — owner of the containment primitive's tenant table.
//
// Placement answers "what is this thing INSIDE of?" generically: a part
// installed in a machine, a component in a server (asset), an item filed into a
// location. The relationship is exposed platform-wide via platform().placement
// (impl in api/src/index.ts, which reads/writes this module's tenant table).
//
// Why this module exists: placement REPLACES the tenant-local location_id, a
// hot per-row field, so its data must live tenant-local — beside the entities it
// links — for same-DB joins + atomic backfill, not in cobblr_meta. There's no
// platform-owned-tenant-table mechanism, so a foundational module owns the
// schema (the same reason core-locations owns core_locations_locations). A
// Location is just one KIND of container.
//
// Foundational: containment is universal infrastructure (like locations/tags).
// No api routes (the surface is platform().placement) and no entity-kinds (it's
// a relationship, not a thing).

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-placement",
  version: "0.1.0",
  displayName: "Placement",
  description:
    "The containment primitive: records which container each thing lives inside (a part in a machine, a component in a server, an item in a location). Exposed platform-wide via platform().placement; a Location is just one kind of container.",
  icon: "package",
  band: "foundational",

  schema: {
    tablePrefix: "core_placement_",
    migrationsDir: "./migrations",
  },

  intents: [],
  dependencies: [],
  exposes: { events: [], api: [], actions: [] },
  subscribes: [],
});
