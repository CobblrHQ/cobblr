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
  version: "0.2.8",
  displayName: "Placement",
  description:
    "Keeps track of what is inside what: a part in a machine, a jar on a shelf, a shelf in a room.",
  icon: "package",
  band: "foundational",

  schema: {
    tablePrefix: "core_placement_",
    migrationsDir: "./migrations",
  },

  // Thin HTTP surface over platform().placement (contents / of / place / remove).
  api: () => import("./api/index.js"),

  dependencies: [],
  exposes: {
    events: [
      // Something was put inside something else. The platform records this all
      // day and, until now, told nobody: a module that wants to react to a
      // record finding a home had nothing to subscribe to. Payload is the pair
      // plus kinds, so a subscriber can decide relevance without a lookup.
      "core-placement.placed",
    ],
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
        examples: ["put this in bin 4", "it lives in the Garage now"],
        undoable: true,
        label: "Place in container",
        description:
          "Put the targeted record inside a container (a location, a bin, a box: any container-trait record). Moves it if it's already somewhere else. Args: { container_kind, container_id, slot? }.",
        appliesTo: { traits: ["containable"] },
        invokeHandler: "core-placement.place",
        userInvokable: false,
        argsSchema: {
          container_kind: { label: "Container kind", type: "text", required: true },
          container_id: { label: "Container id", type: "text", required: true },
          slot: { label: "Slot (optional)", type: "text" },
        },
      },
      {
        id: "core-placement:remove",
        examples: ["take it out of the bin", "it is not in there any more"],
        undoable: true,
        label: "Remove from container",
        description:
          "Take the targeted record out of whatever container it's in. A no-op if it isn't placed anywhere. When two records share a name ('take the CubePro out of the Garage' with two CubePros), the one IN the place named is the one meant: list_related on the place, then run this on that record rather than asking which.",
        appliesTo: { traits: ["containable"] },
        invokeHandler: "core-placement.remove",
        userInvokable: false,
      },
    ],
  },
  subscribes: [],
  lifecycle: {
    // Rows stored under a collection's kind before the kernel keyed every
    // placement by the base kind (#3663): folded once, by the kernel's walk.
    onBoot: async () => {
      const { registerPlacementKindsHeal } = await import("./heal-instance-kinds.js");
      registerPlacementKindsHeal();
    },
  },
});
