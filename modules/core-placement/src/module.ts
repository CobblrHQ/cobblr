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
  version: "0.2.0",
  displayName: "Placement",
  description:
    "The containment primitive: records which container each thing lives inside (a part in a machine, a component in a server, an item in a location). Exposed platform-wide via platform().placement; a Location is just one kind of container.",
  icon: "package",
  band: "foundational",

  schema: {
    tablePrefix: "core_placement_",
    migrationsDir: "./migrations",
  },

  // Thin HTTP surface over platform().placement (contents / of / place / remove).
  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],
  exposes: {
    events: [],
    api: ["contents", "of", "place", "remove"],
    actions: [
      // Wire/AI-invokable placement — the same put-inside/take-out the /place
      // and /remove routes do, reachable through the actions surface (Ask Cobb
      // + MCP hit these via invoke_action; wires can move records on events).
      // appliesTo derives from the containment trait — only containable kinds
      // match — and the platform placement service still enforces the full
      // guards (self, cycle, ineligible container) at execute time. NOT
      // userInvokable: the person-facing surface is the Contents panel on the
      // record's detail page.
      {
        id: "core-placement:place",
        label: "Place in container",
        description:
          "Put the targeted record inside a container (a location, a bin, a box — any container-trait record). Moves it if it's already somewhere else. Args: { container_kind, container_id, slot? }.",
        appliesTo: { traits: ["containable"] },
        invokeHandler: "core-placement.place",
        userInvokable: false,
        argsSchema: {
          container_kind: { label: "Container kind", type: "text" },
          container_id: { label: "Container id", type: "text" },
          slot: { label: "Slot (optional)", type: "text" },
        },
      },
      {
        id: "core-placement:remove",
        label: "Remove from container",
        description:
          "Take the targeted record out of whatever container it's in. A no-op if it isn't placed anywhere.",
        appliesTo: { traits: ["containable"] },
        invokeHandler: "core-placement.remove",
        userInvokable: false,
      },
    ],
  },
  subscribes: [],
});
