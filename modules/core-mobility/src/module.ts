// core-mobility — the "home vs current location" capability. Ambient plumbing
// (a capability, no nav noun): a physical-stuff kind opts in and its items gain
// a home, a per-item fixed/mobile flag, and an auto-stamped `away_since`. When a
// mobile item's current location drifts from home it's flagged "away", with a
// one-tap Return home. Fixtures (mobility=fixed, the default) are untouched.
//
// Built on the platform primitives it needed (see
// docs/design-decisions/relation-fields-and-transition-hooks.md): a `relation`
// field (home → a location), transition-aware wiring (the update delta feeds the
// drift rule), and a `server_managed` field (`away_since`, never client-written).
//
// The module is a THIN LAYER: all behaviour lives in two generic action
// handlers keyed on ctx.entity.kind. A kind qualifies by (a) emitting
// `<module>.<noun>.updated` with flat before/after bags and (b) registering a
// silent EntityWriter — adding one to MOBILITY_KINDS below is the whole
// integration. inventory:part and assets:asset ship enabled.

import { defineModule } from "@cobblr/platform-contract";

// The physical-stuff kinds mobility rides on. Each entry fans out to the same
// three contributed fields + one recompute wire. Bundle-manifest-declared
// bindings (a `mobility` block on any bundle) are the documented follow-on;
// until then this list is the opt-in surface.
const MOBILITY_KINDS = [
  { kind: "inventory:part", updatedEvent: "inventory.part.updated" },
  { kind: "assets:asset", updatedEvent: "assets.asset.updated" },
];

const fieldDefsFor = (kind: string) => [
  {
    entity_kind: kind,
    name: "home_location",
    display_label: "Home",
    type: "relation" as const,
    ref_kind: "core-locations:location",
  },
  {
    entity_kind: kind,
    name: "mobility",
    display_label: "Moves around",
    type: "text" as const,
    choices: ["fixed", "mobile"],
  },
  {
    entity_kind: kind,
    name: "away_since",
    display_label: "Away since",
    type: "date" as const,
    // Server-stamped from the drift rule; a client write is never accepted.
    server_managed: true,
  },
];

export default defineModule({
  name: "core-mobility",
  version: "0.1.0",
  displayName: "Mobility",
  description:
    "Home vs current location with drift detection. Give a tool or bin a home, mark it mobile, and it shows 'away · 3d' when it wanders, with one-tap Return home. Fixtures opt out.",
  icon: "map-pin",
  band: "stock",
  autoEnable: false, // opt-in — enabling it adds home/mobility/away to your items

  // No own table: mobility rides on the host kinds' fields (contributed below).

  api: () => import("./api/index.js"),

  intents: [],
  // Only the location substrate is a hard dependency. The per-kind
  // contributions below are INERT until their host module (inventory, assets)
  // is enabled — a workspace with either one can use mobility.
  dependencies: ["core-locations"],

  provides: {
    entityKinds: [],
  },

  contributes: {
    fieldDefs: MOBILITY_KINDS.flatMap((k) => fieldDefsFor(k.kind)),
    // Every entity update feeds the drift rule; the handler self-guards on the
    // before/after delta (a contributed wire carries no condition — and it
    // doesn't need one: an unrelated edit is a cheap no-op inside the handler).
    wires: MOBILITY_KINDS.map((k) => ({
      source_kind: k.kind,
      action_id: "core-mobility:recompute-away",
      trigger_type: "event" as const,
      trigger_event: k.updatedEvent,
    })),
  },

  exposes: {
    events: [],
    api: [],
    actions: [
      {
        id: "core-mobility:recompute-away",
        label: "Recompute away-from-home",
        description:
          "Re-evaluate a mobile item's away_since from the update delta: stamp on first drift from home, preserve the age across unrelated edits, clear on return / when set to fixed. Wire-driven; not user-invoked.",
        appliesTo: { kinds: MOBILITY_KINDS.map((k) => k.kind) },
        invokeHandler: "core-mobility.recompute-away",
        userInvokable: false,
      },
      {
        id: "core-mobility:return-home",
        label: "Return home",
        description:
          "Snap a mobile item's current location back to its home and clear the away flag. Errors if the item is fixed or has no home set.",
        appliesTo: { kinds: MOBILITY_KINDS.map((k) => k.kind) },
        invokeHandler: "core-mobility.return-home",
        userInvokable: true,
      },
    ],
  },
});
