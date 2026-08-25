// Featured bundle catalog — manifests embedded in the web app so
// users can one-click install without copy-pasting JSON. Until we
// have a hosted registry, this is the curated list.
//
// ⚠️ THIS FILE IS THE SINGLE SOURCE OF TRUTH for bundle manifests.
// `bundles/*.json` at the repo root are GENERATED from here by
// `scripts/sync-bundles.ts` (the server's capture-first menu + quickstart
// install read those). Do NOT hand-edit `bundles/*.json` — edit the entry
// here, then run `npx tsx scripts/sync-bundles.ts` and commit both. CI's
// `lint:bundles-synced` fails the build if they drift.
//
// VOCAB-ENUMERATION OK: these are bundle MANIFESTS, so naming a field_role is
// declaring what one particular field means, not branching on the vocabulary.
// A bundle that ships an expiry date has to say `expiry`; that is the point.
// Each entry is the raw manifest we'd send to /bundles/install.
// Adding a bundle: add a FeaturedBundle entry here, then run the sync.

import type { PlatformBundleManifest, PlatformBundleFeature } from "./api";
import { OUTFIT_PLANNER_HTML } from "./outfit-planner-app";
import { CATALOGING_BENCH_HTML } from "./bench-app";

/** A post-install guided step — the "you can now add some yarn" prompt
 *  that shows after a bundle installs, so the user isn't left staring at
 *  a closed modal wondering what changed. */
export interface BundleNextStep {
  /** Button label, e.g. "Add your first yarn". */
  label: string;
  /** Module to navigate to (route segment under /w/<handle>), e.g. "inventory". */
  module: string;
  /** Explicit destination route (wins over `module`) — for landing in a module
   *  INSTANCE rather than the bare module, e.g. "/instances/yarn/items". */
  path?: string;
  /** One-line hint under the label. */
  hint?: string;
}

/** An opt-in capability of a bundle, toggled by a checkbox in the install
 *  modal. Phase 2: features live IN the manifest (manifest.features) so the
 *  backend stores them and they can be toggled later. The manifest's own
 *  arrays are the always-on BASE (the "thing"); features add the "what can
 *  I do with it". Naming rule: the bundle title is the noun; capabilities
 *  live here. */
export type BundleFeature = PlatformBundleFeature;

export interface FeaturedBundle {
  /** Includes the optional `features` array (opt-in capabilities). */
  manifest: PlatformBundleManifest;
  /** Short blurb shown on the catalog card. */
  blurb: string;
  /** Emoji or single-char glyph for the card. */
  glyph: string;
  /** Post-install guided next steps. When omitted, a generic "go to the
   *  modules this set up" list is derived from the manifest's requires. */
  next_steps?: BundleNextStep[];
  /** Onboarding example for the "add your first item" prompt when this recipe is
   *  picked on the homepage funnel — e.g. "a spool of PLA". When omitted it's
   *  derived as "your first <item_noun>" from the bundle's first provided
   *  instance. Set this when the noun alone is weak (a multi-instance bundle
   *  whose first noun is a sub-type). See docs/design-decisions/what-to-do-funnel.md. */
  item_example?: string;
}

/** Merge a manifest's BASE arrays with its selected features into one
 *  resolved manifest — used by the modal's live preview. The install sends
 *  the FULL manifest + the enabled feature keys and the backend resolves;
 *  this is display-only. requires are dedup-unioned by module. */
export function resolveBundleManifest(
  manifest: PlatformBundleManifest,
  selected: ReadonlySet<string>,
): PlatformBundleManifest {
  const on = (manifest.features ?? []).filter((f) => selected.has(f.key));
  if (on.length === 0) return manifest;
  const seen = new Set<string>();
  const requires = [...(manifest.requires ?? []), ...on.flatMap((f) => f.requires ?? [])].filter((r) =>
    seen.has(r.module) ? false : (seen.add(r.module), true),
  );
  return {
    ...manifest,
    requires,
    field_defs: [...(manifest.field_defs ?? []), ...on.flatMap((f) => f.field_defs ?? [])],
    wires: [...(manifest.wires ?? []), ...on.flatMap((f) => f.wires ?? [])],
    field_overrides: [...(manifest.field_overrides ?? []), ...on.flatMap((f) => f.field_overrides ?? [])],
    saved_views: [...(manifest.saved_views ?? []), ...on.flatMap((f) => f.saved_views ?? [])],
    provides_instances: [...(manifest.provides_instances ?? []), ...on.flatMap((f) => f.provides_instances ?? [])],
    catalogs: [...(manifest.catalogs ?? []), ...on.flatMap((f) => f.catalogs ?? [])],
  };
}

/** Base next-steps plus the next-steps of any selected features. */
export function resolveNextSteps(
  base: BundleNextStep[] | undefined,
  features: BundleFeature[] | undefined,
  selected: ReadonlySet<string>,
): BundleNextStep[] {
  const on = (features ?? []).filter((f) => selected.has(f.key));
  return [...(base ?? []), ...on.flatMap((f) => f.next_steps ?? [])];
}

/** The post-install "where to start" steps for a bundle: the bundle's declared
 *  next_steps (base + selected features), else a fallback of one "go to" link
 *  per required DOMAIN module (`core-*` plumbing is filtered out — never a
 *  place a user "goes"). Shared by the install modal's landing panel and the
 *  persisted dashboard setup card so they always agree. */
export function deriveNextSteps(
  manifest: PlatformBundleManifest,
  baseNextSteps: BundleNextStep[] | undefined,
  selected: ReadonlySet<string>,
): BundleNextStep[] {
  const declared = resolveNextSteps(baseNextSteps, manifest.features, selected);
  if (declared.length) return declared;
  const resolved = resolveBundleManifest(manifest, selected);
  // A bundle that PROVISIONS instances (e.g. "3D Printers" of machines) lands the
  // user in the INSTANCE it just created — the thing they made — not the bare
  // host module. ("Go to 3D Printers" → /3d-printers, never "Go to Machines".)
  const instances = resolved.provides_instances ?? [];
  if (instances.length) {
    return instances.map((i) => ({
      label: `Go to ${i.display_name}`,
      module: i.module,
      path: `/${i.instance_name}`,
      ...(i.item_noun ? { hint: `Add your first ${i.item_noun}` } : {}),
    }));
  }
  return [...new Set((resolved.requires ?? []).map((r) => r.module))]
    .filter((m) => !m.startsWith("core-"))
    .map((m) => ({ label: `Go to ${m.charAt(0).toUpperCase() + m.slice(1)}`, module: m }));
}

/** The "send files to your machines" capability, shared by every machine-type
 *  bundle (3D Printers / Laser Cutters / CNC Machines) so it's DRY + identical.
 *  Checked by DEFAULT — most people setting up a printer want to send jobs to
 *  it — but a plain checkbox the user can uncheck if they only want to catalog
 *  the machine. Enabling it brings the digifab (Print Manager) module under the
 *  bundle's roof; the machine's detail page then links straight to its manager.
 *  Bundle title stays the noun (3D Printers); the capability lives here. */
function connectMachinesFeature(noun: string): BundleFeature {
  return {
    key: "digifab",
    name: `Connect to your ${noun}s`,
    question: `Want to send files to your ${noun}s and track the job?`,
    description:
      "Adds the Print Manager: map each machine to the software that runs it (FDM Monster, OctoPrint, …), send a file to be made, and track the job to completion. Talks to the manager's API; it never drives the hardware. You can link a machine to its manager right from the machine's page.",
    default: true,
    requires: [{ module: "digifab" }],
  };
}

/** The v0.3.0 "what's new" line shown in the bundle modal after an update — so a
 *  one-click inline update still lets you review what changed. DRY across the
 *  three machine bundles; varies only by noun, tab name, and field examples. */
function machineBundleChangelog(noun: string, tab: string, fields: string): string {
  return `Your ${noun}s now open the full machine page — set every field (${fields}), edit in place, attach files, and link the machine straight to its print manager (FDM Monster / OctoPrint) right from its own page, instead of a name-only stub. Installing now offers a checked-by-default “Connect to your ${noun}s” option that brings the Print Manager along — send a file to be made and track the job — which you can uncheck for catalog-only use. Existing installs auto-upgrade: your ${noun}s move into the ${tab} tab automatically, no reinstall.`;
}

export const FEATURED_BUNDLES: FeaturedBundle[] = [
  {
    glyph: "🧂",
    blurb:
      "Your spice cabinet as its own table. Which jar is open, which are still sealed, and how often you actually re-buy each one.",
    manifest: {
          "id": "cobblr.flagship.spice-rack",
          "version": "0.2.0",
          "released_at": "2026-08-20",
          "name": "Spice Rack",
          "author": "Cobblr",
          "description": "Your spices and seasonings as their own table: what is on the rack, which jar is open, and how often you actually re-buy each one.",
          "changelog": "First release. Spices get their own table rather than rows in generic Inventory, with the fields a spice cabinet needs and none it does not. Each jar can be tracked open versus sealed, so \"four jars of paprika, one of them open\" is something the app can say. Two columns learn from ordinary shopping: how often you re-buy something, and how long the current stock will last.",
          "requires": [
                {
                      "module": "inventory"
                },
                {
                      "module": "lists"
                },
                {
                      "module": "core-cadence"
                }
          ],
          "wires": [
                {
                      "source_kind": "inventory:part",
                      "action_id": "lists:add-item",
                      "trigger_type": "event",
                      "trigger_event": "inventory.stock.low",
                      "args": {
                            "listTitle": "Shopping list"
                      }
                },
                {
                      "source_kind": "inventory:part",
                      "action_id": "lists:add-item",
                      "trigger_type": "event",
                      "trigger_event": "inventory.stock.predicted-low",
                      "args": {
                            "listTitle": "Shopping list"
                      }
                },
                {
                      "source_kind": "inventory:part",
                      "action_id": "lists:add-item",
                      "trigger_type": "event",
                      "trigger_event": "core-cadence.reorder.due",
                      "args": {
                            "listTitle": "Shopping list"
                      }
                },
                {
                      "source_kind": "inventory:part",
                      "action_id": "inventory:adjust-stock",
                      "trigger_type": "event",
                      "trigger_event": "lists.item.checked",
                      "args": {
                            "delta": 1,
                            "reason": "Restocked, checked off the shopping list"
                      }
                },
                {
                      "source_kind": "inventory:part",
                      "action_id": "core-cadence:record-event",
                      "trigger_type": "event",
                      "trigger_event": "lists.item.checked",
                      "args": {
                            "event_type": "purchase",
                            "qty_delta": 1,
                            "source": "list"
                      }
                }
          ],
          "field_defs": [],
          "provides_instances": [
                {
                      "module": "inventory",
                      "instance_name": "spices",
                      "nav_group": {
                            "key": "kitchen",
                            "label": "Kitchen"
                      },
                      "wires": [
                            {
                                  "source_kind": "spices:item",
                                  "action_id": "lists:add-item",
                                  "trigger_type": "event",
                                  "trigger_event": "inventory.stock.low",
                                  "args": {
                                        "listTitle": "Shopping list"
                                  }
                            },
                            {
                                  "source_kind": "spices:item",
                                  "action_id": "inventory:adjust-stock",
                                  "trigger_type": "event",
                                  "trigger_event": "lists.item.checked",
                                  "args": {
                                        "delta": 1,
                                        "reason": "Restocked, checked off the shopping list"
                                  }
                            },
                            {
                                  "source_kind": "spices:item",
                                  "action_id": "core-cadence:record-event",
                                  "trigger_type": "event",
                                  "trigger_event": "lists.item.checked",
                                  "args": {
                                        "event_type": "purchase",
                                        "qty_delta": 1,
                                        "source": "list"
                                  }
                            }
                      ],
                      "display_name": "Spices",
                      "item_noun": "spice",
                      "glyph": "🧂",
                      "qty_unit": "jar",
                      "scan_keywords": [
                            "spice",
                            "seasoning",
                            "herb",
                            "peppercorn",
                            "paprika",
                            "cumin",
                            "oregano",
                            "cinnamon",
                            "turmeric",
                            "chili powder",
                            "garlic powder",
                            "onion powder",
                            "curry",
                            "basil",
                            "thyme",
                            "rosemary",
                            "bay leaf",
                            "nutmeg",
                            "cardamom",
                            "coriander",
                            "vanilla extract",
                            "baking powder",
                            "baking soda",
                            "cocoa"
                      ],
                      "field_defs": [
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "form",
                                  "display_label": "Form",
                                  "type": "text",
                                  "position": 1,
                                  "choices": [
                                        "Ground",
                                        "Whole",
                                        "Blend",
                                        "Flake",
                                        "Salt",
                                        "Extract",
                                        "Leaf"
                                  ]
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "net_weight_g",
                                  "display_label": "Net weight (g)",
                                  "type": "number",
                                  "unit": "g",
                                  "position": 2,
                                  "help": "Grams in a full jar, off the label. Used to gauge how much is left in the open one, so you never type a capacity."
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "capacity",
                                  "display_label": "Full jar",
                                  "type": "computed",
                                  "template": "{{ net_weight_g }}",
                                  "position": 3,
                                  "help": "Grams in one full jar, from the weight above. Each opened jar's gauge is measured against this."
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "opened_on",
                                  "display_label": "Opened",
                                  "type": "date",
                                  "position": 5
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "expires_on",
                                  "display_label": "Best before",
                                  "type": "date",
                                  "position": 6,
                                  "field_role": "expiry"
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "replenish_every",
                                  "display_label": "You re-buy every (days)",
                                  "type": "computed",
                                  "template": "{{ cadence.replenish_every_days }}",
                                  "position": 7,
                                  "help": "Learned from how often you actually buy it. Blank until it has seen two shops."
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "runs_out_in",
                                  "display_label": "Runs out in (days)",
                                  "type": "computed",
                                  "template": "{{ cadence.days_until_runout }}",
                                  "position": 8,
                                  "help": "At the rate you have been going through it. Blank while it is still learning."
                            }
                      ],
                      "field_overrides": [
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "manufacturer",
                                  "display_label": "Brand"
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "consumable"
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "min_qty",
                                  "display_label": "Re-buy when down to"
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "warranty",
                                  "hidden": true
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "serial_number",
                                  "hidden": true
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "model_number",
                                  "hidden": true
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "maintenance",
                                  "hidden": true
                            }
                      ],
                      "saved_views": [
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "Where they live",
                                  "view_type": "table",
                                  "pinned": true,
                                  "config": {
                                        "group_by": "location",
                                        "visible_fields": [
                                              "title",
                                              "manufacturer",
                                              "form",
                                              "qty",
                                              "replenish_every",
                                              "runs_out_in"
                                        ]
                                  }
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "Re-buy soonest",
                                  "view_type": "table",
                                  "config": {
                                        "sort_by": "runs_out_in",
                                        "sort_dir": "asc",
                                        "visible_fields": [
                                              "title",
                                              "qty",
                                              "runs_out_in",
                                              "replenish_every",
                                              "min_qty"
                                        ]
                                  }
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "How often you re-buy",
                                  "view_type": "table",
                                  "config": {
                                        "sort_by": "replenish_every",
                                        "sort_dir": "asc",
                                        "visible_fields": [
                                              "title",
                                              "replenish_every",
                                              "runs_out_in",
                                              "qty"
                                        ]
                                  }
                            }
                      ]
                }
          ]
    } as unknown as PlatformBundleManifest,
  },
  {
    glyph: "🍵",
    blurb:
      "Your tea cupboard as its own table. Which box is open, which are still sealed, and how often you actually re-buy each one.",
    manifest: {
          "id": "cobblr.flagship.tea",
          "version": "0.2.0",
          "released_at": "2026-08-20",
          "name": "Tea",
          "author": "Cobblr",
          "description": "Your teas as their own table: what is in the cupboard, which box is open, and how often you actually re-buy each one.",
          "changelog": "First release. Tea gets its own table rather than rows in generic Inventory, counted in boxes with the fields a tea cupboard needs. A box can be tracked open versus sealed, so \"three boxes of Earl Grey, one open\" is something the app can say. Two columns learn from ordinary shopping: how often you re-buy a tea, and how long the current stock will last.",
          "requires": [
                {
                      "module": "inventory"
                },
                {
                      "module": "lists"
                },
                {
                      "module": "core-cadence"
                }
          ],
          "wires": [
                {
                      "source_kind": "inventory:part",
                      "action_id": "lists:add-item",
                      "trigger_type": "event",
                      "trigger_event": "inventory.stock.low",
                      "args": {
                            "listTitle": "Shopping list"
                      }
                },
                {
                      "source_kind": "inventory:part",
                      "action_id": "lists:add-item",
                      "trigger_type": "event",
                      "trigger_event": "inventory.stock.predicted-low",
                      "args": {
                            "listTitle": "Shopping list"
                      }
                },
                {
                      "source_kind": "inventory:part",
                      "action_id": "lists:add-item",
                      "trigger_type": "event",
                      "trigger_event": "core-cadence.reorder.due",
                      "args": {
                            "listTitle": "Shopping list"
                      }
                },
                {
                      "source_kind": "inventory:part",
                      "action_id": "inventory:adjust-stock",
                      "trigger_type": "event",
                      "trigger_event": "lists.item.checked",
                      "args": {
                            "delta": 1,
                            "reason": "Restocked, checked off the shopping list"
                      }
                },
                {
                      "source_kind": "inventory:part",
                      "action_id": "core-cadence:record-event",
                      "trigger_type": "event",
                      "trigger_event": "lists.item.checked",
                      "args": {
                            "event_type": "purchase",
                            "qty_delta": 1,
                            "source": "list"
                      }
                }
          ],
          "field_defs": [],
          "provides_instances": [
                {
                      "module": "inventory",
                      "instance_name": "tea",
                      "nav_group": {
                            "key": "kitchen",
                            "label": "Kitchen"
                      },
                      "wires": [
                            {
                                  "source_kind": "tea:item",
                                  "action_id": "lists:add-item",
                                  "trigger_type": "event",
                                  "trigger_event": "inventory.stock.low",
                                  "args": {
                                        "listTitle": "Shopping list"
                                  }
                            },
                            {
                                  "source_kind": "tea:item",
                                  "action_id": "inventory:adjust-stock",
                                  "trigger_type": "event",
                                  "trigger_event": "lists.item.checked",
                                  "args": {
                                        "delta": 1,
                                        "reason": "Restocked, checked off the shopping list"
                                  }
                            },
                            {
                                  "source_kind": "tea:item",
                                  "action_id": "core-cadence:record-event",
                                  "trigger_type": "event",
                                  "trigger_event": "lists.item.checked",
                                  "args": {
                                        "event_type": "purchase",
                                        "qty_delta": 1,
                                        "source": "list"
                                  }
                            }
                      ],
                      "display_name": "Tea",
                      "item_noun": "tea",
                      "glyph": "🍵",
                      "qty_unit": "box",
                      "scan_keywords": [
                            "tea",
                            "tea bags",
                            "teabag",
                            "herbal tea",
                            "infusion",
                            "chamomile",
                            "peppermint",
                            "earl grey",
                            "english breakfast",
                            "green tea",
                            "black tea",
                            "white tea",
                            "oolong",
                            "pekoe",
                            "rooibos",
                            "chai",
                            "matcha",
                            "jasmine",
                            "hibiscus",
                            "zinger",
                            "loose leaf"
                      ],
                      "field_defs": [
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "tea_type",
                                  "display_label": "Type",
                                  "type": "text",
                                  "position": 1,
                                  "choices": [
                                        "Black",
                                        "Green",
                                        "White",
                                        "Oolong",
                                        "Herbal",
                                        "Rooibos",
                                        "Chai",
                                        "Matcha",
                                        "Fruit"
                                  ]
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "bags_per_box",
                                  "display_label": "Bags per box",
                                  "type": "number",
                                  "unit": "bags",
                                  "position": 2,
                                  "help": "Off the label. Used to gauge how much is left in the open box, so you never type a capacity."
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "capacity",
                                  "display_label": "Full box",
                                  "type": "computed",
                                  "template": "{{ bags_per_box }}",
                                  "position": 3,
                                  "help": "Bags in one full box, from the count above. The open box's gauge is measured against this."
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "caffeine",
                                  "display_label": "Caffeine",
                                  "type": "text",
                                  "position": 4,
                                  "choices": [
                                        "Caffeinated",
                                        "Decaf",
                                        "Naturally caffeine free"
                                  ]
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "opened_on",
                                  "display_label": "Opened",
                                  "type": "date",
                                  "position": 5
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "expires_on",
                                  "display_label": "Best before",
                                  "type": "date",
                                  "position": 6,
                                  "field_role": "expiry"
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "replenish_every",
                                  "display_label": "You re-buy every (days)",
                                  "type": "computed",
                                  "template": "{{ cadence.replenish_every_days }}",
                                  "position": 7,
                                  "help": "Learned from how often you actually buy it. Blank until it has seen two shops."
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "runs_out_in",
                                  "display_label": "Runs out in (days)",
                                  "type": "computed",
                                  "template": "{{ cadence.days_until_runout }}",
                                  "position": 8,
                                  "help": "At the rate you have been going through it. Blank while it is still learning."
                            }
                      ],
                      "field_overrides": [
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "manufacturer",
                                  "display_label": "Brand"
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "consumable"
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "min_qty",
                                  "display_label": "Re-buy when down to"
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "warranty",
                                  "hidden": true
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "serial_number",
                                  "hidden": true
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "model_number",
                                  "hidden": true
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "maintenance",
                                  "hidden": true
                            }
                      ],
                      "saved_views": [
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "The cupboard",
                                  "view_type": "table",
                                  "pinned": true,
                                  "config": {
                                        "group_by": "tea_type",
                                        "visible_fields": [
                                              "title",
                                              "manufacturer",
                                              "tea_type",
                                              "qty",
                                              "replenish_every",
                                              "runs_out_in"
                                        ]
                                  }
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "Re-buy soonest",
                                  "view_type": "table",
                                  "config": {
                                        "sort_by": "runs_out_in",
                                        "sort_dir": "asc",
                                        "visible_fields": [
                                              "title",
                                              "qty",
                                              "runs_out_in",
                                              "replenish_every",
                                              "min_qty"
                                        ]
                                  }
                            },
                            {
                                  "entity_kind": "inventory:part",
                                  "name": "How often you re-buy",
                                  "view_type": "table",
                                  "config": {
                                        "sort_by": "replenish_every",
                                        "sort_dir": "asc",
                                        "visible_fields": [
                                              "title",
                                              "replenish_every",
                                              "runs_out_in",
                                              "qty"
                                        ]
                                  }
                            }
                      ]
                }
          ]
    } as unknown as PlatformBundleManifest,
  },
  {
    glyph: "🥬",
    blurb:
      "Track the fridge/pantry with expiry + storage, and auto-build a shopping list when something runs low or is about to expire. Check an item off → it restocks.",
    manifest: {
      id: "cobblr.flagship.groceries",
      version: "0.10.0",
      // What its items are actually CALLED. A bundle's suggestion has to be
      // corroborated by the capture's own text before it is trusted, and a
      // category whose members never share its name can never corroborate:
      // nothing called Tomatoes Roma or Croissant contains the word "grocery",
      // so every one of them was demoted to plain Inventory (reported
      // 2026-08-19). Head nouns a till or a package actually prints.
      //
      // Words with a strong non-food sense are deliberately absent — oil
      // (motor), cream (shaving), chip (silicon), bar, roll, paper, towel,
      // soap, water, salt, stock, mix, spread, wrap. A keyword scores as
      // routing evidence, so a false hit files a non-grocery in here.
      scan_keywords: [
        "tomato",
        "tomatoes",
        "carrot",
        "carrots",
        "cucumber",
        "cucumbers",
        "lettuce",
        "spinach",
        "broccoli",
        "cauliflower",
        "potato",
        "potatoes",
        "onion",
        "onions",
        "garlic",
        "mushroom",
        "courgette",
        "zucchini",
        "aubergine",
        "celery",
        "cabbage",
        "kale",
        "avocado",
        "apple",
        "apples",
        "banana",
        "bananas",
        "orange",
        "oranges",
        "lemon",
        "lime",
        "grape",
        "grapes",
        "strawberry",
        "strawberries",
        "blueberry",
        "blueberries",
        "raspberry",
        "melon",
        "peach",
        "pear",
        "plum",
        "mango",
        "pineapple",
        "bread",
        "loaf",
        "baguette",
        "croissant",
        "bagel",
        "brioche",
        "tortilla",
        "pitta",
        "pita",
        "muffin",
        "scone",
        "pastry",
        "doughnut",
        "donut",
        "milk",
        "yogurt",
        "yoghurt",
        "cheese",
        "cheddar",
        "mozzarella",
        "parmesan",
        "feta",
        "butter",
        "margarine",
        "egg",
        "eggs",
        "hummus",
        "tofu",
        "chicken",
        "beef",
        "pork",
        "lamb",
        "bacon",
        "sausage",
        "sausages",
        "ham",
        "turkey",
        "mince",
        "steak",
        "salmon",
        "tuna",
        "prawn",
        "prawns",
        "shrimp",
        "pasta",
        "spaghetti",
        "penne",
        "noodle",
        "noodles",
        "rice",
        "cereal",
        "porridge",
        "oats",
        "flour",
        "sugar",
        "honey",
        "jam",
        "marmalade",
        "ketchup",
        "mustard",
        "mayonnaise",
        "vinegar",
        "soup",
        "sauce",
        "salsa",
        "pesto",
        "beans",
        "lentils",
        "chickpeas",
        "couscous",
        "quinoa",
        "biscuit",
        "biscuits",
        "cookie",
        "cookies",
        "cracker",
        "crackers",
        "crisps",
        "popcorn",
        "chocolate",
        "candy",
        "sweets",
        "coffee",
        "tea",
        "juice",
        "lemonade",
        "cola",
        "soda",
        "beer",
        "wine",
        "cider",
        "pizza",
        "ice cream",
        "frozen peas",
        "ready meal",
      ],
      released_at: "2026-08-09",
      changelog:
        "Scanning a grocery now suggests this bundle. The scanner would pick it and then quietly file the item under plain Inventory instead, because a bundle's suggestion has to be corroborated by the item's own text and nothing called Tomatoes Roma or Croissant contains the word grocery. The bundle now says what its items are called. Marks the expiry date as an expiry field, so re-buying something that already went off is recorded as waste rather than as something you used up. Fixes the status dots on the What's on hand view, which never showed anything about expiry. Adds a What's on hand app: a vending-machine view of the kitchen with a quantity badge and a status dot per item, plus a use-it-or-lose-it list sorted by expiry. Answers what do we actually have without opening the fridge. Learns your cadence from ordinary shopping. Checking an item off the shopping list now also records a purchase in the consumption ledger (when the Cadence capability is on), so the system can start predicting when you will run out instead of only reacting to a low-stock threshold. Same fields, same restock behaviour.",
      name: "Groceries",
      description:
        "Turn inventory + lists into a kitchen system: track food with expiry + storage fields, an auto grocery list on low-stock/expiry, restock on check-off.",
      author: "Cobblr",
      // core-cadence is opt-in platform-wide (autoEnable: false), but the two
      // cadence wires below are part of THIS bundle's promise, so installing
      // Groceries brings the capability with it. A workspace that never installs
      // Groceries still carries no ledger.
      features: [
        {
          key: "kitchen-places",
          name: "Set up your kitchen",
          question: "Shall we set up a Fridge and a Freezer you can file things into?",
          description:
            "Adds Kitchen with a Fridge, Freezer and Pantry inside it, so you can put a label on each and scan things straight in. If you already have a Kitchen these go inside the one you have, and nothing already in it is moved. Decline and grocery tracking works exactly the same.",
          default: true,
          provides_locations: [
            {
              name: "Kitchen",
              kind: "area",
              children: [
                { name: "Fridge", kind: "container" },
                { name: "Freezer", kind: "container" },
                { name: "Pantry", kind: "container" },
              ],
            },
          ],
        },
      ],
      requires: [{ module: "inventory" }, { module: "lists" }, { module: "core-cadence" }],
      wires: [
        { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "inventory.stock.low", args: { listTitle: "Shopping list" } },
        { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "lists.item.expiring", args: { listTitle: "Shopping list" } },
        { source_kind: "inventory:part", action_id: "inventory:adjust-stock", trigger_type: "event", trigger_event: "lists.item.checked", args: { delta: 1, reason: "Restocked, checked off the shopping list" } },
        // Closes the learning loop: the same check-off that restocks also files a
        // purchase in the cadence ledger, so "how fast do I go through this"
        // learns from ordinary shopping with nobody logging anything. Needs
        // core-cadence enabled; the wire is inert (unknown action) without it.
        { source_kind: "inventory:part", action_id: "core-cadence:record-event", trigger_type: "event", trigger_event: "lists.item.checked", args: { event_type: "purchase", qty_delta: 1, source: "list" } },
        // Expiry is WASTE, not consumption. Without this the expiring wire above
        // would quietly add it to the list as if it had been used, and the
        // learned rate would climb on food nobody ate. Recording it as a discard
        // is what makes "3 of your last 4 went bad, buy fewer" possible.
        // The predictive half of the reorder signal, beside the shipped
        // threshold one above: stock.low fires when you CROSS the reorder level,
        // this fires when the learned rate says you are about to. Same list, same
        // action, so the two unify at the destination instead of competing.
        { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "core-cadence.reorder.due", args: { listTitle: "Shopping list" } },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "shelf_life_days", display_label: "Good for (days)", type: "number", position: 1, help: "How long this keeps from the day it arrives. Used to date a new one when you add it, so you never type a use-by. Leave blank and nothing is dated for you." },
        { entity_kind: "inventory:part", name: "shelf_life_opened_days", display_label: "Once opened, good for (days)", type: "number", position: 2, help: "A lemon lasts weeks whole and days once cut. Opening one starts this shorter clock on that one only; the unopened ones keep their own dates." },
        { entity_kind: "inventory:part", name: "grace_days", display_label: "Still fine for (days past)", type: "number", position: 3, help: "Food does not go off at midnight. Inside this window past the use-by it is mentioned rather than alarming; beyond it you are asked whether you threw it out." },
        { entity_kind: "inventory:part", name: "storage_requirement", display_label: "Must be kept", type: "text", position: 0, choices: ["frozen", "refrigerated", "ambient"], help: "How this has to be kept, which is not the same as where it currently is. Filled in from what the item is when you scan it, and left blank when that is not clear enough to say. Anything you choose here is used instead." },
        { entity_kind: "inventory:part", name: "expires_on", display_label: "Expires", type: "date", position: 1, field_role: "expiry" },
        // Shelf life counts from the day you BOUGHT it, and a receipt is often
        // scanned days later - so this cannot be the scan date. The receipt
        // parser fills it by its role.
        //
        // Deliberately the SAME NAME as the Provenance preset's field: a
        // per-kind def shadows a trait-scoped one of the same name
        // (resolveFieldDefsForKind), so a workspace with both gets ONE field
        // rather than two dates meaning the same thing, and a workspace with
        // neither the preset nor this bundle is unaffected.
        { entity_kind: "inventory:part", name: "acquired_on", display_label: "Bought on", type: "date", position: 2, field_role: "acquired-on" },
        { entity_kind: "inventory:part", name: "opened_on", display_label: "Opened", type: "date", position: 2 },
        { entity_kind: "inventory:part", name: "storage", display_label: "Storage", type: "text", position: 3, choices: ["Fridge", "Freezer", "Pantry", "Counter", "Spice rack"] },
        { entity_kind: "inventory:part", name: "food_category", display_label: "Food category", type: "text", position: 4, choices: ["Produce", "Dairy", "Meat", "Bakery", "Frozen", "Canned", "Dry goods", "Condiments", "Beverages", "Snacks"] },
      ],
      saved_views: [
        // The vending-machine renderer: slots, a qty badge, one status dot. It
        // answers "what do we actually have" at a glance, which is the question
        // people open the fridge to ask.
        {
          entity_kind: "inventory:part",
          name: "What's on hand",
          view_type: "vending",
          // UNPINNED since the Groceries table shipped: the pinned pair lives
          // on groceries:item now, and pinning this one too put two cards named
          // "What's on hand" on every fresh dashboard - one of them empty
          // forever. This copy stays (findable under /views) for workspaces
          // whose food still lives in plain Inventory; the dashboard card
          // offering to move that food is how they converge.
          pinned: false,
          // No group_by: the vending renderer draws one flat wall of slots. Declaring a
          // key it ignores reads as a feature and behaves as nothing.
          config: { qty_field: "qty", expiry_field: "expires_on", min_qty_field: "min_qty" },
        },
        {
          entity_kind: "inventory:part",
          name: "Use it or lose it",
          view_type: "table",
          config: { sort_by: "expires_on", sort_dir: "asc", visible_fields: ["title", "expires_on", "storage", "qty"] },
        },
      ],
      // Groceries is its own TABLE, not a set of extra columns on Inventory.
      //
      // It began as a lens: nine field defs bolted onto inventory:part. That is
      // why a scanned cucumber and a scanned bolt landed in the same list, and
      // why a workspace with Spices and Tea set up still had no Groceries to put
      // groceries in.
      //
      // It stays an INSTANCE OF INVENTORY rather than a record type, because
      // groceries are stock: you have three cucumbers, you use one, it runs low,
      // it goes on the shopping list, it gets re-bought on a cadence. Quantity,
      // the consumption ledger, use-one/restock-one, expiry batches and the
      // low-stock wire are all inventory's, and a records-based table would have
      // to reimplement every one of them.
      //
      // THE inventory:part FIELD DEFS BELOW STAY, deliberately. Removing them
      // would strip the columns off groceries somebody has ALREADY filed into
      // plain Inventory - the two-phase rule: add the new home now, move at
      // leisure, drop the old only once nothing reads it.
      provides_instances: [
              {
                      "module": "inventory",
                      "instance_name": "groceries",
        "scan_keywords": [
                "tomato",
                "cucumber",
                "carrot",
                "lettuce",
                "spinach",
                "potato",
                "onion",
                "garlic",
                "mushroom",
                "pepper",
                "avocado",
                "apple",
                "banana",
                "orange",
                "lemon",
                "grape",
                "berry",
                "melon",
                "bread",
                "baguette",
                "croissant",
                "bagel",
                "tortilla",
                "pastry",
                "milk",
                "yogurt",
                "cheese",
                "butter",
                "egg",
                "chicken",
                "beef",
                "pork",
                "salmon",
                "tuna",
                "pasta",
                "rice",
                "cereal",
                "yoghurt",
                "pizza",
                "juice"
        ],
                      "display_name": "Groceries",
                      "item_noun": "item",
                      "glyph": "\ud83e\udd6c",
                      "qty_unit": "unit",
                      "nav_group": {
                              "key": "kitchen",
                              "label": "Kitchen"
                      },
                      "field_defs": [
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "shelf_life_days",
                                      "display_label": "Good for (days)",
                                      "type": "number",
                                      "position": 1,
                                      "help": "How long this keeps from the day it arrives. Used to date a new one when you add it, so you never type a use-by. Leave blank and nothing is dated for you."
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "shelf_life_opened_days",
                                      "display_label": "Once opened, good for (days)",
                                      "type": "number",
                                      "position": 2,
                                      "help": "A lemon lasts weeks whole and days once cut. Opening one starts this shorter clock on that one only; the unopened ones keep their own dates."
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "grace_days",
                                      "display_label": "Still fine for (days past)",
                                      "type": "number",
                                      "position": 3,
                                      "help": "Food does not go off at midnight. Inside this window past the use-by it is mentioned rather than alarming; beyond it you are asked whether you threw it out."
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "storage_requirement",
                                      "display_label": "Must be kept",
                                      "type": "text",
                                      "position": 0,
                                      "choices": [
                                              "frozen",
                                              "refrigerated",
                                              "ambient"
                                      ],
                                      "help": "How this has to be kept, which is not the same as where it currently is. Filled in from what the item is when you scan it, and left blank when that is not clear enough to say. Anything you choose here is used instead."
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "expires_on",
                                      "display_label": "Expires",
                                      "type": "date",
                                      "position": 1,
                                      "field_role": "expiry"
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "acquired_on",
                                      "display_label": "Bought on",
                                      "type": "date",
                                      "position": 2,
                                      "field_role": "acquired-on"
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "opened_on",
                                      "display_label": "Opened",
                                      "type": "date",
                                      "position": 2
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "storage",
                                      "display_label": "Storage",
                                      "type": "text",
                                      "position": 3,
                                      "choices": [
                                              "Fridge",
                                              "Freezer",
                                              "Pantry",
                                              "Counter",
                                              "Spice rack"
                                      ]
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "food_category",
                                      "display_label": "Category",
                                      "type": "text",
                                      "position": 4,
                                      "choices": [
                                              "Produce",
                                              "Dairy",
                                              "Meat",
                                              "Bakery",
                                              "Frozen",
                                              "Canned",
                                              "Dry goods",
                                              "Condiments",
                                              "Beverages",
                                              "Snacks"
                                      ]
                              }
                      ],
                      "saved_views": [
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "Re-buy soonest",
                                      "view_type": "table",
                                      "config": {
                                              "sort_by": "runs_out_in",
                                              "sort_dir": "asc",
                                              "visible_fields": ["title", "qty", "runs_out_in", "replenish_every", "min_qty"]
                                      }
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "How often you re-buy",
                                      "view_type": "table",
                                      "config": {
                                              "sort_by": "replenish_every",
                                              "sort_dir": "asc",
                                              "visible_fields": ["title", "replenish_every", "runs_out_in", "qty"]
                                      }
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "What's on hand",
                                      "view_type": "vending",
                                      "pinned": true,
                                      "config": {
                                              "qty_field": "qty",
                                              "expiry_field": "expires_on",
                                              "min_qty_field": "min_qty"
                                      }
                              },
                              {
                                      "entity_kind": "groceries:item",
                                      "name": "Use it or lose it",
                                      "view_type": "table",
                                      "config": {
                                              "sort_by": "expires_on",
                                              "sort_dir": "asc",
                                              "visible_fields": [
                                                      "title",
                                                      "expires_on",
                                                      "storage",
                                                      "qty"
                                              ]
                                      }
                              }
                      ],
                      "wires": [
                              {
                                      "source_kind": "groceries:item",
                                      "action_id": "lists:add-item",
                                      "trigger_type": "event",
                                      "trigger_event": "inventory.stock.low",
                                      "args": {
                                              "listTitle": "Shopping list"
                                      }
                              },
                              {
                                      "source_kind": "groceries:item",
                                      "action_id": "lists:add-item",
                                      "trigger_type": "event",
                                      "trigger_event": "lists.item.expiring",
                                      "args": {
                                              "listTitle": "Shopping list"
                                      }
                              },
                              {
                                      "source_kind": "groceries:item",
                                      "action_id": "inventory:adjust-stock",
                                      "trigger_type": "event",
                                      "trigger_event": "lists.item.checked",
                                      "args": {
                                              "delta": 1,
                                              "reason": "Restocked, checked off the shopping list"
                                      }
                              },
                              {
                                      "source_kind": "groceries:item",
                                      "action_id": "core-cadence:record-event",
                                      "trigger_type": "event",
                                      "trigger_event": "lists.item.checked",
                                      "args": {
                                              "event_type": "purchase",
                                              "qty_delta": 1,
                                              "source": "list"
                                      }
                              },
                              {
                                      "source_kind": "groceries:item",
                                      "action_id": "lists:add-item",
                                      "trigger_type": "event",
                                      "trigger_event": "core-cadence.reorder.due",
                                      "args": {
                                              "listTitle": "Shopping list"
                                      }
                              }
                      ],
                      "field_overrides": [
        {
                "entity_kind": "inventory:part",
                "name": "category",
                "hidden": true
        },
                              {
                                      "entity_kind": "inventory:part",
                                      "name": "manufacturer",
                                      "display_label": "Brand"
                              },
                              {
                                      "entity_kind": "inventory:part",
                                      "name": "min_qty",
                                      "display_label": "Re-buy when down to"
                              },
                              {
                                      "entity_kind": "inventory:part",
                                      "name": "warranty",
                                      "hidden": true
                              },
                              {
                                      "entity_kind": "inventory:part",
                                      "name": "serial_number",
                                      "hidden": true
                              },
                              {
                                      "entity_kind": "inventory:part",
                                      "name": "model_number",
                                      "hidden": true
                              },
                              {
                                      "entity_kind": "inventory:part",
                                      "name": "maintenance",
                                      "hidden": true
                              }
                      ]
              }
      ],
      provides_apps: [
        {
          slug: "whats-on-hand",
          name: "What's on hand",
          icon: "🥕",
          pages: [
            {
              slug: "on-hand",
              title: "On hand",
              blocks: [
                { type: "stat", view_name: "What's on hand", view_kind: "groceries:item", agg: "count", label: "Things in the kitchen" },
                { type: "view", view_name: "What's on hand", view_kind: "groceries:item", title: "Everything you have" },
                { type: "markdown", body: "### Eat these first\n\nClosest to its expiry date at the top. Anything that runs out or goes off lands on the shopping list by itself." },
                { type: "view", view_name: "Use it or lose it", view_kind: "groceries:item" },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    glyph: "🔧",
    blurb:
      "Run a workshop: keep parts in inventory, define Builds (bills of materials) of those parts, see how many you can build right now, and auto-add anything that runs low to a parts shopping list you check off to restock.",
    manifest: {
      id: "cobblr.flagship.maker-workshop",
      catalog: "disabled",
      version: "0.1.1",
      name: "Maker Workshop",
      description:
        "Inventory + Builds + a parts shopping list, pre-wired into the maker loop: define builds as recipes of tracked parts, build them (which consumes stock), and auto-restock low parts through a shopping list you check off. Showcases the Builds (light BOM) module.",
      author: "Cobblr",
      requires: [{ module: "inventory" }, { module: "builds" }, { module: "lists" }],
      wires: [
        // A part runs low (e.g. consumed by building something) → add it to the
        // parts shopping list. Same proven plumbing as the kitchen bundle.
        { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "inventory.stock.low", args: { listTitle: "Parts to buy" } },
        // Check the part off the shopping list → restock it by one.
        { source_kind: "inventory:part", action_id: "inventory:adjust-stock", trigger_type: "event", trigger_event: "lists.item.checked", args: { delta: 1, reason: "Restocked, checked off the parts list" } },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "part_type", display_label: "Part type", type: "text", position: 1, choices: ["Mechanical", "Electronic", "Fastener", "Printed", "Raw material", "Consumable"] },
        { entity_kind: "inventory:part", name: "package", display_label: "Package / footprint", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "value", display_label: "Value / spec", type: "text", position: 3 },
        { entity_kind: "inventory:part", name: "datasheet_url", display_label: "Datasheet / source URL", type: "url", position: 4 },
      ],
    },
  },
  {
    glyph: "🥬➜📈",
    blurb:
      "Bridge: every grocery order you receive logs its cost as a 'Grocery spend' measurement: your spending trends like any metric. Set a monthly budget as the goal.",
    manifest: {
      id: "cobblr.flagship.grocery-spend",
      catalog: "disabled",
      version: "0.1.2",
      name: "Grocery Spend",
      description:
        "Connects the grocery flow to the Tracking module: order received → log spend into a metric. Neither module knows about the other.",
      author: "Cobblr",
      changelog:
        "Named for the thing it produces. The old title was a use-case sentence (and carried an em dash into user-facing copy); the bundle tracks one noun, so it is “Grocery Spend”.",
      requires: [{ module: "purchases" }, { module: "tracking" }],
      wires: [
        {
          source_kind: "purchases:order_item",
          action_id: "tracking:log-measurement",
          trigger_type: "event",
          trigger_event: "purchases.order_item.received",
          args: { metricName: "Grocery spend", unit: "$", goalDirection: "down", valueKey: "lineCost", note: "auto-logged on order arrival" },
        },
      ],
    },
  },
  {
    glyph: "🧱",
    blurb:
      "Lego as its own tables. Sets you own (sealed / built / disassembled), optional Bricks bins, a Rebrickable catalog link, and one-tap Disassemble that spawns the parts and opens the sorting planner.",
    next_steps: [
      { label: "Add your first set", module: "inventory", path: "/instances/sets", hint: "Sealed, built, or already taken apart." },
    ],
    manifest: {
      id: "cobblr.community.lego",
      version: "0.5.1",
      name: "Lego",
      description:
        "Lego as its own tables. Sets you own (sealed / built / disassembled) with optional Bricks bins, a Rebrickable catalog link, and a one-tap Disassemble that spawns the parts and opens the sorting planner.",
      author: "Cobblr community",
      released_at: "2026-07-11",
      changelog:
        "Lego is now its OWN tables, not a skin over generic inventory. Installing it gives you a Sets table (each set sealed, built, or disassembled) with set number, theme, year, piece count and minifig count: the generic warranty/serial/supplier clutter is hidden. Turn on the checkboxes you want: track individual Bricks in bins, link to the Rebrickable catalog so sets and parts match real data, disassemble a built set into its parts and sort them into bins, print QR labels, or add by scanning.",
      requires: [{ module: "inventory" }],
      // The always-on BASE: a Sets table (the noun everyone with Lego has). The
      // Bricks/bins world, the Rebrickable link, and Disassemble are opt-in
      // features (default on) — the Yarn model, one base + checkboxes.
      provides_instances: [
        {
          module: "inventory",
          instance_name: "sets",
          display_name: "Sets",
          glyph: "🧱",
          item_noun: "set",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "lifecycle", display_label: "State", type: "text", position: 1, choices: ["sealed", "built", "disassembled"], help: "Where this set is: still sealed in the box, built, or taken apart into bricks." },
            { entity_kind: "inventory:part", name: "set_number", display_label: "Set number", type: "text", position: 2, help: "The number printed on the box (e.g. 75192)." },
            { entity_kind: "inventory:part", name: "theme", display_label: "Theme", type: "text", position: 3, help: "Star Wars, City, Technic, Botanicals…" },
            { entity_kind: "inventory:part", name: "year", display_label: "Release year", type: "number", position: 4, help: "The year the set was released." },
            { entity_kind: "inventory:part", name: "piece_count", display_label: "Pieces", type: "number", position: 5, help: "How many pieces the set has, from the box." },
            { entity_kind: "inventory:part", name: "minifig_count", display_label: "Minifigs", type: "number", position: 6, help: "How many minifigures come with the set." },
            { entity_kind: "inventory:part", name: "instructions_url", display_label: "Instructions", type: "url", position: 7, renderer: "url-link", help: "Link to the build instructions (a PDF or Rebrickable page)." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By theme", view_type: "table", pinned: true, config: { group_by: "theme", visible_fields: ["title", "set_number", "theme", "year", "piece_count", "lifecycle"] } },
          ],
        },
      ],
      features: [
        {
          key: "bricks",
          name: "Bricks & bins",
          question: "Track individual bricks in bins too?",
          description: "A separate 'Bricks' table for loose parts: each brick by shape (part category) and colour, filed into a bin. This is where a disassembled set's parts land.",
          default: true,
          next_steps: [
            { label: "Open your Bricks table", module: "inventory", path: "/instances/bricks", hint: "Loose parts by shape + colour, filed into bins." },
          ],
          provides_instances: [
            {
              module: "inventory",
              instance_name: "bricks",
              display_name: "Bricks",
              glyph: "🧱",
              item_noun: "brick",
              qty_unit: "each",
              field_defs: [
                { entity_kind: "inventory:part", name: "part_num", display_label: "Part number", type: "text", position: 2, help: "The Rebrickable/Lego element id (e.g. 3005 for a 1x1 brick)." },
                { entity_kind: "inventory:part", name: "color", display_label: "Colour", type: "text", position: 3, renderer: "color-hex", help: "The brick's colour. Pick a hex/colour for the swatch." },
                { entity_kind: "inventory:part", name: "color_id", display_label: "Colour id", type: "text", position: 4, help: "The Rebrickable colour id (set automatically when parts come from a disassemble)." },
                { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", position: 5, choices: ["new", "used", "damaged"], help: "The state of the brick." },
              ],
              field_overrides: [
                { entity_kind: "inventory:part", name: "category", display_label: "Part category" },
                { entity_kind: "inventory:part", name: "warranty", hidden: true },
                { entity_kind: "inventory:part", name: "min_qty", hidden: true },
                { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
                { entity_kind: "inventory:part", name: "serial_number", hidden: true },
                { entity_kind: "inventory:part", name: "model_number", hidden: true },
              ],
              saved_views: [
                { entity_kind: "inventory:part", name: "By part category", view_type: "table", pinned: true, config: { group_by: "category", visible_fields: ["title", "category", "color", "location", "qty"] } },
              ],
            },
          ],
        },
        {
          key: "rebrickable",
          name: "Rebrickable catalog",
          question: "Link to the Rebrickable catalog?",
          description: "Installs the Rebrickable reference catalogs (themes, part categories, colours, parts, sets, minifigs) so your sets and bricks match real data, and a set's bill of materials powers Disassemble. Import the rows in one tap from the catalog page.",
          default: true,
          requires: [{ module: "core-catalogs" }],
          next_steps: [
            { label: "Import Rebrickable data", module: "core-catalogs", path: "/configuration/catalogs", hint: "One tap pulls the catalog rows from Rebrickable." },
          ],
          catalogs: [
            { external_id: "rebrickable-themes", name: "Rebrickable themes", description: "Lego themes. Star Wars, City, Technic, etc.", source_url: "https://cdn.rebrickable.com/media/downloads/themes.csv.gz", puller_id: "rebrickable", schema: { id_column: "id", title_column: "name", bindable_to_kinds: [], semantic_type: "lego.theme" } },
            { external_id: "rebrickable-part-categories", name: "Rebrickable part categories", description: "Part categories: bricks, plates, slopes, tiles, wedges, etc. The bin taxonomy.", source_url: "https://cdn.rebrickable.com/media/downloads/part_categories.csv.gz", puller_id: "rebrickable", schema: { id_column: "id", title_column: "name", bindable_to_kinds: [], semantic_type: "lego.part-category" } },
            { external_id: "rebrickable-colors", name: "Rebrickable colors", description: "Every Lego colour, with a swatch.", source_url: "https://cdn.rebrickable.com/media/downloads/colors.csv.gz", puller_id: "rebrickable", schema: { id_column: "id", title_column: "name", hero_field: "rgb", hero_renderer: "color-hex", field_renderers: { is_trans: "boolean" }, field_labels: { is_trans: "Transparent" }, bindable_to_kinds: [], semantic_type: "lego.color" } },
            { external_id: "rebrickable-parts", name: "Rebrickable parts", description: "Individual Lego parts. Match a brick to identify it.", source_url: "https://cdn.rebrickable.com/media/downloads/parts.csv.gz", puller_id: "rebrickable", schema: { id_column: "part_num", title_column: "name", image_column: "img_url", field_labels: { part_num: "Part number", part_cat_id: "Category" }, field_map: { external_id: "part_num" }, bindable_to_kinds: ["inventory:part"], semantic_type: "lego.part" } },
            { external_id: "rebrickable-sets", name: "Rebrickable sets", description: "Lego sets. Match a set to pull its number, theme, year and pieces.", source_url: "https://cdn.rebrickable.com/media/downloads/sets.csv.gz", puller_id: "rebrickable", schema: { id_column: "set_num", title_column: "name", image_column: "img_url", field_renderers: { year: "year" }, field_labels: { set_num: "Set number", theme_id: "Theme", num_parts: "Pieces", year: "Year" }, field_map: { external_id: "set_number", category: "theme", year: "year", num_parts: "piece_count" }, bindable_to_kinds: ["inventory:part"], semantic_type: "lego.set" } },
            { external_id: "rebrickable-minifigs", name: "Rebrickable minifigs", description: "Minifigure catalog.", source_url: "https://cdn.rebrickable.com/media/downloads/minifigs.csv.gz", puller_id: "rebrickable", schema: { id_column: "fig_num", title_column: "name", image_column: "img_url", field_labels: { fig_num: "Figure number", num_parts: "Pieces" }, bindable_to_kinds: ["inventory:part"], semantic_type: "lego.minifig" } },
            { external_id: "rebrickable-inventory-parts", name: "Rebrickable set inventories", description: "The set bill of materials, which parts each set contains. Powers Disassemble. Large (~5M rows); import when you need it.", source_url: "https://cdn.rebrickable.com/media/downloads/inventory_parts.csv.gz", puller_id: "rebrickable", schema: { id_column: "row_id", title_column: "part_num", image_column: "img_url", field_renderers: { is_spare: "boolean" }, field_labels: { set_num: "Set number", part_num: "Part number", color_id: "Colour" }, exclude_from_global_search: true, bindable_to_kinds: [], semantic_type: "lego.bom" } },
          ],
        },
        {
          key: "disassemble",
          name: "Disassemble into bricks",
          question: "Disassemble a set into its bricks and sort them?",
          description: "Adds a one-tap Disassemble on a set: it spawns the set's parts (from the Rebrickable bill of materials) into your Bricks table and opens the sorting planner to file them into bins. Needs the Bricks table and the Rebrickable catalog.",
          default: true,
          requires: [{ module: "bricklink-connector" }],
          next_steps: [
            { label: "Open a built set to disassemble it", module: "inventory", path: "/instances/sets", hint: "Open a set, then use Disassemble: its parts land in Bricks and the planner opens." },
          ],
        },
        {
          key: "labels",
          name: "Label printing",
          question: "Print QR labels for these?",
          description: "Adds the Labels module + a one-tap print action on each set or brick.",
          default: false,
          requires: [{ module: "labels" }],
          wires: [
            {
              source_kind: "inventory:part",
              action_id: "labels:print",
              trigger_type: "user-invoked",
              template:
                'LEGO {{theme | default: "misc"}} #{{set_number | default: "---"}} • {{name}} ({{year | default: "???"}})',
            },
          ],
        },
        {
          key: "scan",
          name: "Scan to add",
          question: "Add sets or bricks by scanning a barcode or box?",
          description: "Snap a set box barcode or a parts bag to stock Lego fast.",
          default: false,
          requires: [{ module: "core-scan" }],
        },
      ],
    },
  },
  {
    glyph: "🛠️",
    blurb:
      "Vintage hand tool collection: model, era, finish, condition. Prints labels with model + era so you can find them across a workshop.",
    manifest: {
      id: "cobblr.community.vintage-tools",
      catalog: "disabled",
      version: "0.1.0",
      name: "Vintage Tools",
      description: "Custom fields + label wires for vintage hand tools.",
      author: "Cobblr community",
      requires: [{ module: "inventory" }],
      features: [
        {
          key: "labels",
          name: "Label printing",
          question: "Print QR labels for these?",
          description: "Adds the Labels module + a one-tap print action on each item.",
          requires: [{ module: "labels" }],
          wires: [
        {
          source_kind: "inventory:part",
          action_id: "labels:print",
          trigger_type: "user-invoked",
          template: '{{maker | default: "—"}} {{model | default: "?"}} · {{era | default: "??"}} · {{name}}',
        },
          ],
        },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "maker", display_label: "Maker", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "model", display_label: "Model", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "era", display_label: "Era", type: "text", position: 3 },
        { entity_kind: "inventory:part", name: "finish", display_label: "Finish", type: "text", position: 4 },
        { entity_kind: "inventory:part", name: "provenance", display_label: "Provenance", type: "text", position: 5 },
      ],
    },
  },
  {
    glyph: "🎛️",
    blurb:
      "3D printer parts: track voltage, datasheet URL, footprint, and a print-label template tuned for narrow bin labels. Uses the native `manufacturer` field.",
    manifest: {
      id: "cobblr.community.printer-parts",
      released_at: "2026-06-20",
      changelog: "First catalogued release: the printer-parts drawer skin on inventory.",
      catalog: "extended",
      version: "0.2.0",
      name: "3D Printer Parts",
      description:
        "Datasheet-aware part fields + a narrow-bin label template. Manufacturer is a native inventory:part field; this bundle adds the electronics-specific extras.",
      author: "Cobblr community",
      requires: [{ module: "inventory" }],
      features: [
        {
          key: "labels",
          name: "Label printing",
          question: "Print QR labels for these?",
          description: "Adds the Labels module + a one-tap print action on each item.",
          requires: [{ module: "labels" }],
          wires: [
        {
          source_kind: "inventory:part",
          action_id: "labels:print",
          trigger_type: "user-invoked",
          template: '{{name}}\n{{manufacturer | default: ""}} {{voltage | default: ""}}',
        },
          ],
        },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "voltage", display_label: "Voltage", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "datasheet_url", display_label: "Datasheet URL", type: "url", position: 2 },
        { entity_kind: "inventory:part", name: "footprint", display_label: "Footprint / mount", type: "text", position: 3 },
      ],
    },
  },
  {
    glyph: "🌱",
    blurb:
      "Garden tracker: plants as assets with species, sun exposure, planted date, and a repeating watering schedule that the recurrence scanner picks up automatically.",
    manifest: {
      id: "cobblr.community.garden",
      released_at: "2026-07-02",
      changelog: "First catalogued release: plants as assets with species, sun exposure, and a repeating watering schedule.",
      catalog: "extended",
      version: "0.1.1",
      name: "Garden",
      description:
        "Custom assets:asset fields for tracking plants: species, planted date, watering schedule, sun exposure.",
      author: "Cobblr community",
      requires: [{ module: "assets" }],
      wires: [],
      field_defs: [
        { entity_kind: "assets:asset", name: "species", display_label: "Species", type: "text", position: 1 },
        { entity_kind: "assets:asset", name: "planted_at", display_label: "Planted", type: "date", position: 2 },
        { entity_kind: "assets:asset", name: "water_rrule", display_label: "Watering schedule", type: "text", position: 3 },
        { entity_kind: "assets:asset", name: "sun", display_label: "Sun exposure", type: "text", position: 4 },
      ],
    },
  },
  {
    glyph: "📚",
    blurb:
      "Personal library: author, ISBN, year, read-status, on its own shelf that opens as a cover wall. Print spine labels with one wire.",
    manifest: {
      id: "cobblr.community.bookshelf",
      released_at: "2026-06-28",
      changelog: "First catalogued release: books as their own shelf with author, ISBN scan-in, and read status.",
      version: "0.2.0",
      name: "Bookshelf",
      description:
        "Your books as their own shelf: author + ISBN + year + read status, on a lean catalog that opens as a cover wall. Spine-label wire bundled.",
      author: "Cobblr community",
      requires: [{ module: "inventory" }],
      features: [
        {
          key: "labels",
          name: "Label printing",
          question: "Print QR labels for these?",
          description: "Adds the Labels module + a one-tap print action on each item.",
          requires: [{ module: "labels" }],
          wires: [
            {
              source_kind: "bookshelf:item",
              action_id: "labels:print",
              trigger_type: "user-invoked",
              template:
                '{{author | default: "Unknown"}}\n{{name}}\n{{year | default: "?"}}',
            },
          ],
        },
      ],
      // Books live on their OWN shelf, not in the workspace's inventory. The
      // default inventory instance is always stock (it IS your inventory), so a
      // bookshelf built on it could never show the lean catalog face — it wore
      // qty/cost/warranty. Its own instance discloses lean (qty_unit "each", no
      // stock signal) and opens on the cover wall. See one-record-substrate.md.
      provides_instances: [
        {
          module: "inventory",
          instance_name: "bookshelf",
          display_name: "Bookshelf",
          glyph: "📚",
          item_noun: "book",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "bookshelf:item", name: "author", display_label: "Author", type: "text", position: 1 },
            { entity_kind: "bookshelf:item", name: "isbn", display_label: "ISBN", type: "text", position: 2 },
            { entity_kind: "bookshelf:item", name: "year", display_label: "Year", type: "number", position: 3 },
            { entity_kind: "bookshelf:item", name: "read_status", display_label: "Status", type: "text", choices: ["To read", "Reading", "Read", "Abandoned"], position: 4 },
            { entity_kind: "bookshelf:item", name: "rating", display_label: "Rating (1-5)", type: "number", position: 5 },
          ],
          saved_views: [
            {
              entity_kind: "bookshelf:item",
              name: "Covers",
              view_type: "gallery",
              pinned: true,
              config: { image_field: "image_path", caption_field: "author" },
            },
            {
              entity_kind: "bookshelf:item",
              name: "By status",
              view_type: "table",
              config: { visible_fields: ["title", "author", "year", "read_status", "rating"], group_by: "read_status" },
            },
          ],
        },
      ],
    },
  },
  {
    glyph: "📖",
    blurb:
      "Lending library: the shelf you lend FROM: count copies, see who has one and when it's due back.",
    manifest: {
      id: "cobblr.community.lending-library",
      released_at: "2026-06-28",
      changelog: "First catalogued release: track who borrowed what, with due-back dates.",
      catalog: "extended",
      version: "0.1.0",
      name: "Lending Library",
      description:
        "A shelf you lend from: each title carries its copies, and lending one out reserves it against a borrower until it comes back.",
      author: "Cobblr community",
      requires: [{ module: "inventory" }],
      features: [
        {
          key: "labels",
          name: "Label printing",
          question: "Print QR labels for these?",
          description: "Adds the Labels module + a one-tap print action, so a copy can be scanned in and out.",
          requires: [{ module: "labels" }],
          wires: [
            {
              source_kind: "lending-library:item",
              action_id: "labels:print",
              trigger_type: "user-invoked",
              template: '{{author | default: "Unknown"}}\n{{name}}',
            },
          ],
        },
      ],
      // The deplete-and-lend twin of Bookshelf. Bookshelf is a CATALOG — one row
      // per title, no quantities — so it discloses lean. A lending library is the
      // same shelf with stock character: you hold COPIES and they go out and come
      // back. It says so the generic way, by declaring a measured unit ("copy",
      // not "each"), which is the signal that opens the stock face — quantities,
      // and the allocations panel that IS the lending. Nothing here is bespoke
      // lending code; it's inventory's own reserve/return seen through a library's
      // words. See one-record-substrate.md.
      provides_instances: [
        {
          module: "inventory",
          instance_name: "lending-library",
          display_name: "Lending Library",
          glyph: "📖",
          item_noun: "book",
          qty_unit: "copy",
          field_defs: [
            { entity_kind: "lending-library:item", name: "author", display_label: "Author", type: "text", position: 1 },
            { entity_kind: "lending-library:item", name: "isbn", display_label: "ISBN", type: "text", position: 2 },
            { entity_kind: "lending-library:item", name: "year", display_label: "Year", type: "number", position: 3 },
            // Choices are not decoration: they are the fingerprint the HEURISTIC
            // (no-AI) scan router matches a capture against, so this shelf is
            // reachable on a workspace with AI off. lint:bundle-quality enforces
            // that every instance carries choices or scan_keywords for exactly
            // that reason. Format also happens to be what you want to know
            // before you lend one out.
            { entity_kind: "lending-library:item", name: "format", display_label: "Format", type: "text", choices: ["Hardback", "Paperback", "Large print", "Audiobook"], position: 4 },
          ],
          saved_views: [
            { entity_kind: "lending-library:item", name: "Shelf", view_type: "gallery", pinned: true, config: { image_field: "image_path", caption_field: "author" } },
            { entity_kind: "lending-library:item", name: "Out on loan", view_type: "table", config: { visible_fields: ["title", "author", "qty", "available_qty"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🔧",
    blurb:
      "Tool library: checkout/checkin tracking. Marks machines with borrower, due_date, condition. Pair with the labels module to print barcoded check-out tags.",
    manifest: {
      id: "cobblr.community.tool-library",
      catalog: "disabled",
      version: "0.1.0",
      name: "Tool Library",
      description:
        "Track who's borrowed a tool, when it's due back, and its condition. Custom machine:machine fields.",
      author: "Cobblr community",
      requires: [{ module: "machines" }],
      wires: [],
      field_defs: [
        { entity_kind: "machines:machine", name: "borrower", display_label: "Borrower", type: "text", position: 1 },
        { entity_kind: "machines:machine", name: "due_date", display_label: "Due back", type: "date", position: 2 },
        { entity_kind: "machines:machine", name: "condition", display_label: "Condition (1-5)", type: "number", position: 3 },
        { entity_kind: "machines:machine", name: "deposit_paid", display_label: "Deposit paid?", type: "text", position: 4 },
        { entity_kind: "machines:machine", name: "tool_category", display_label: "Category", type: "text", position: 5 },
      ],
    },
  },
  // ── Lens specialisations ──────────────────────────────────────────
  //
  // These were Pillar-E specialisation MODULES before — pure field-
  // def packages with `dependencies: ["machines"]` that drove the
  // lens-popover nav. They had no schema, no api, no resolvers, no
  // events. The principle "every feature is a user-enableable module
  // — nothing hardcoded" reads better when even these very domain-
  // specific things are bundles a builder turns on.
  //
  // Machine specialisations are `provides_instances` of the multi-instance
  // `machines` module — a named top-level collection (3D Printers) whose items
  // are still `machines:machine` rows, so digifab / fleet / maintenance keep
  // working. (Was a `provides_lens` — a filtered view of the shared table —
  // which couldn't cleanly be its own top-level thing.)
  {
    glyph: "🖨️",
    blurb:
      "Track your 3D printers: hotend, extruder, board, firmware, bed size, local IP. Its own tab; still part of your machines (prints, fleet, maintenance).",
    manifest: {
      id: "cobblr.community.3d-printers",
      version: "0.3.1",
      name: "3D Printers",
      description:
        "A 3D Printers tracker: your printers with hotend, extruder, board, firmware, bed size, and local IP. It's a named view of your machines, so each printer still drives prints, fleet status, and maintenance.",
      author: "Cobblr community",
      released_at: "2026-06-19",
      changelog: machineBundleChangelog("3D printer", "3D Printers", "hotend, extruder, mainboard, firmware, bed size, local IP"),
      requires: [{ module: "machines" }],
      features: [connectMachinesFeature("3D printer")],
      provides_instances: [
        {
          module: "machines",
          instance_name: "3d-printers",
          display_name: "3D Printers",
          item_noun: "3D printer",
          glyph: "🖨️",
          field_defs: [
            {
              entity_kind: "machines:machine",
              name: "hotend",
              display_label: "Hotend",
              type: "text",
              position: 10,
              choices: [
                "Stock",
                "E3D V6",
                "E3D Volcano",
                "E3D Revo",
                "Phaetus Dragonfly",
                "Phaetus Rapido",
                "Mosquito",
                "Bondtech CHT",
              ],
            },
            {
              entity_kind: "machines:machine",
              name: "extruder",
              display_label: "Extruder",
              type: "text",
              position: 11,
              choices: [
                "Stock",
                "Bondtech LGX",
                "Bondtech LGX Lite",
                "Bondtech DDX",
                "BMG (clone)",
                "Titan",
                "Orbiter v2",
                "Sherpa Mini",
              ],
            },
            {
              entity_kind: "machines:machine",
              name: "board",
              display_label: "Mainboard",
              type: "text",
              position: 12,
              choices: [
                "Stock",
                "BTT SKR Mini E3",
                "BTT SKR 1.4 Turbo",
                "BTT Octopus",
                "Duet 3 6HC",
                "Duet 3 6XD",
                "MKS Robin Nano",
              ],
            },
            {
              entity_kind: "machines:machine",
              name: "firmware",
              display_label: "Firmware",
              type: "text",
              position: 13,
              choices: ["Stock", "Marlin", "Klipper", "RepRapFirmware", "Prusa Buddy"],
            },
            {
              entity_kind: "machines:machine",
              name: "bed_size",
              display_label: "Bed size (mm)",
              type: "text",
              position: 14,
              choices: ["180×180", "200×200", "220×220", "235×235", "250×250", "300×300", "350×350", "400×400"],
            },
            {
              entity_kind: "machines:machine",
              name: "local_ip",
              display_label: "Local IP / hostname",
              type: "text",
              position: 15,
            },
          ],
          saved_views: [
            {
              entity_kind: "machines:machine",
              name: "Printer fleet by state",
              view_type: "kanban",
              config: { group_by: "state" },
              pinned: true,
            },
          ],
        },
      ],
    },
  },
  {
    glyph: "🔥",
    blurb:
      "Track your laser cutters: tube type, wattage, bed size, cooling, focal length. Its own tab; still part of your machines (jobs, fleet, maintenance).",
    manifest: {
      id: "cobblr.community.laser-cutters",
      catalog: "extended",
      version: "0.3.1",
      name: "Laser Cutters",
      description:
        "A Laser Cutters tracker: tube type, wattage, bed size, cooling, focal length. A named view of your machines, so each cutter still drives jobs, fleet status, and maintenance.",
      author: "Cobblr community",
      released_at: "2026-06-19",
      changelog: machineBundleChangelog("laser cutter", "Laser Cutters", "tube type, wattage, bed size, cooling, focal length"),
      requires: [{ module: "machines" }],
      features: [connectMachinesFeature("laser cutter")],
      provides_instances: [
        {
          module: "machines",
          instance_name: "laser-cutters",
          display_name: "Laser Cutters",
          item_noun: "laser cutter",
          glyph: "🔥",
          field_defs: [
        {
          entity_kind: "machines:machine",
          name: "tube_type",
          display_label: "Tube type",
          type: "text",
          position: 20,
          choices: ["CO2 (sealed)", "CO2 (DC-excited)", "CO2 (RF)", "Diode", "Fiber", "Nd:YAG"],
        },
        {
          entity_kind: "machines:machine",
          name: "wattage",
          display_label: "Wattage (W)",
          type: "number", unit: "W",
          position: 21,
        },
        {
          entity_kind: "machines:machine",
          name: "bed_size_laser",
          display_label: "Bed size (mm)",
          type: "text",
          position: 22,
          choices: ["200×300", "300×400", "400×600", "500×700", "600×900", "900×1200", "1200×1600"],
        },
        {
          entity_kind: "machines:machine",
          name: "cooling_type",
          display_label: "Cooling",
          type: "text",
          position: 23,
          choices: ["Passive", "Water (open loop)", "Water (chiller)", "Air-cooled"],
        },
        {
          entity_kind: "machines:machine",
          name: "focal_length_mm",
          display_label: "Focal length (mm)",
          type: "number", unit: "mm",
          position: 24,
            },
          ],
          saved_views: [
            {
              entity_kind: "machines:machine",
              name: "Laser fleet by state",
              view_type: "kanban",
              config: { group_by: "state" },
              pinned: true,
            },
          ],
        },
      ],
    },
  },
  {
    glyph: "⚙️",
    blurb:
      "Track your CNC machines: spindle, axes, work area, controller, coolant. Its own tab; still part of your machines (jobs, fleet, maintenance).",
    manifest: {
      id: "cobblr.community.cnc-machines",
      catalog: "extended",
      version: "0.3.1",
      name: "CNC Machines",
      description:
        "A CNC Machines tracker: spindle, axes, work area, controller, coolant. A named view of your machines, so each mill still drives jobs, fleet status, and maintenance.",
      author: "Cobblr community",
      released_at: "2026-06-19",
      changelog: machineBundleChangelog("CNC machine", "CNC Machines", "spindle, axes, work area, controller, coolant"),
      requires: [{ module: "machines" }],
      features: [connectMachinesFeature("CNC machine")],
      provides_instances: [
        {
          module: "machines",
          instance_name: "cnc-machines",
          display_name: "CNC Machines",
          item_noun: "CNC machine",
          glyph: "⚙️",
          field_defs: [
        {
          entity_kind: "machines:machine",
          name: "spindle",
          display_label: "Spindle",
          type: "text",
          position: 30,
          choices: [
            "Stock",
            "Makita RT0701C router",
            "DeWalt 611 router",
            "0.8kW VFD water-cooled",
            "1.5kW VFD water-cooled",
            "2.2kW VFD water-cooled",
            "ER11 air-cooled",
            "ER20 air-cooled",
          ],
        },
        {
          entity_kind: "machines:machine",
          name: "axis_count",
          display_label: "Axes",
          type: "number",
          position: 31,
        },
        {
          entity_kind: "machines:machine",
          name: "work_area",
          display_label: "Work area (mm)",
          type: "text",
          position: 32,
          choices: ["200×200×80", "300×300×100", "400×400×120", "600×900×150", "1200×1200×200", "1200×2400×200"],
        },
        {
          entity_kind: "machines:machine",
          name: "controller",
          display_label: "Controller",
          type: "text",
          position: 33,
          choices: ["GRBL", "Mach3", "Mach4", "LinuxCNC", "Buildbotics", "Acorn", "Centroid", "Fanuc"],
        },
        {
          entity_kind: "machines:machine",
          name: "coolant_type",
          display_label: "Coolant",
          type: "text",
          position: 34,
          choices: ["None", "Air blast", "Mist", "Flood", "MQL"],
            },
          ],
          saved_views: [
            {
              entity_kind: "machines:machine",
              name: "CNC fleet by controller",
              view_type: "kanban",
              config: { group_by: "controller" },
              pinned: true,
            },
          ],
        },
      ],
    },
  },
  {
    // "Yarn" ships as module INSTANCES, not a skin over generic inventory:
    // a "Yarn" instance of inventory (own nav entry, only yarn fields, "New
    // yarn" button), plus opt-in Hooks (inventory instance) and Designs
    // (projects instance). The studio capabilities are the opt-in features.
    glyph: "🧶",
    blurb:
      "Your yarn as its own thing: brand, colorway, fibre, weight, tracked by the skein, with only yarn fields and a grouped 'My yarn stash' view. Turn on extras: a Hooks table, a Designs table with patterns, an auto shopping list, and scan-to-add.",
    // Land in the Yarn TABLE (the inventory instance), not bare /inventory —
    // so "where to start" points at the thing the bundle just made.
    next_steps: [
      { label: "Add your yarn", module: "inventory", path: "/instances/yarn", hint: "Brand, colorway, fibre, weight, tracked by the skein." },
    ],
    manifest: {
      id: "cobblr.flagship.yarn",
      version: "0.6.2",
      name: "Yarn",
      description:
        "Yarn as its own inventory instance: skein-tracked, yarn-only fields, grouped by weight. Optional Hooks + Designs tables.",
      author: "Cobblr",
      released_at: "2026-07-15",
      changelog:
        "Fixed: the Yarn update now installs: a bad field in the previous release made the update fail validation. New: track your yarn skein-by-skein. On a yarn's page, under Consumption, tap “Track each skein separately” and you get a plain count by state. “3 skeins · 2 new · 1 open”, with the metres left in the skein you're actually knitting from shown quietly (never a confusing total across skeins). Open a skein when you crack a new one, and log metres as you go; each open skein keeps its own running balance. It reads the “Length / skein” you already entered to know a full skein, so there's no capacity to type. It's opt-in per yarn and fully reversible, existing yarn is untouched until you turn it on. Earlier changes below.: Your Yarn table now reads “yarn” everywhere: the “New”, search box, and empty-state labels say “yarn” instead of “part”. (Earlier installs picked up the generic “part” wording; upgrading applies the fix.) Real yarn-user polish: the Color field is a swatch picker (type a hex or pick one), Brand + Price now show right on the “New yarn” modal, and a “Suggested needle size” field was added. Dropdowns (vendor, fibre…) let you add a new option on the fly that sticks for next time. Dropped the confusing “Summary” computed field.. Yarn is its OWN table (a Yarn instance), not a skin over generic inventory: only yarn fields show, the button reads “New yarn”, quantities are in skeins. Hooks and Designs become their own tables too. The generic inventory cruft (warranty, insured, lifecycle…) is hidden, and the pinned view is named for its lens (“By weight”). Opening a yarn now hides the Maintenance log (that section is for machines) and turns on skein-by-skein consumption tracking by default, so you can see at a glance how much of a skein is left. Existing yarn tables pick this up on upgrade.",
      requires: [{ module: "inventory" }],
      // The always-on base: a "Yarn" instance of inventory.
      provides_instances: [
        {
          module: "inventory",
          instance_name: "yarn",
          display_name: "Yarn",
          glyph: "🧶",
          item_noun: "yarn",
          qty_unit: "skein",
          field_defs: [
            { entity_kind: "inventory:part", name: "color", display_label: "Color", type: "text", position: 1, renderer: "color-hex", help: "The basic shade. Pick a hex/colour for the swatch." },
            { entity_kind: "inventory:part", name: "colorway", display_label: "Colorway", type: "text", position: 2, help: "The maker's named shade, e.g. “Peacock Heather” (printed on the yarn label)." },
            { entity_kind: "inventory:part", name: "fiber", display_label: "Fibre", type: "text", position: 3, choices: ["Wool", "Merino", "Cotton", "Acrylic", "Nylon", "Chenille", "Alpaca", "Silk", "Linen", "Bamboo", "Cashmere", "Blend"], help: "What the yarn is made of." },
            { entity_kind: "inventory:part", name: "weight_class", display_label: "Weight", type: "text", position: 4, choices: ["0 – Lace", "1 – Fingering", "2 – Sport", "3 – DK", "4 – Worsted", "4 – Aran", "5 – Bulky", "6 – Super Bulky"], help: "Craft Yarn Council standard weight. 0 (Lace, thinnest) to 6 (Super Bulky, thickest)." },
            { entity_kind: "inventory:part", name: "vendor", display_label: "Vendor", type: "text", position: 5, choices: ["Michaels", "Hobby Lobby", "Walmart", "Joann", "Amazon", "Etsy", "Local yarn shop"], help: "Where you bought it." },
            { entity_kind: "inventory:part", name: "length_per_skein", display_label: "Length / skein (m)", type: "number", unit: "m", position: 6, help: "Metres per skein, from the label, used to estimate if you have enough for a project." },
            { entity_kind: "inventory:part", name: "capacity", display_label: "Full skein", type: "computed", template: "{{ length_per_skein }}", position: 7, help: "Metres in one full skein, from the length above. When you track skein-by-skein, each opened skein's gauge is measured against this: you never type it." },
            { entity_kind: "inventory:part", name: "dye_lot", display_label: "Dye lot", type: "text", position: 8, help: "The batch code on the label, buy the same lot so colours match across skeins." },
            { entity_kind: "inventory:part", name: "needle_size", display_label: "Suggested needle size", type: "text", position: 9, choices: ["2.0 mm", "2.5 mm", "3.0 mm", "3.5 mm", "4.0 mm", "4.5 mm", "5.0 mm", "5.5 mm", "6.0 mm", "6.5 mm", "7.0 mm", "8.0 mm", "9.0 mm", "10.0 mm", "12.0 mm"], help: "The needle/hook size the label recommends for this yarn (in mm)." },
          ],
          field_overrides: [
            // Relabel the few natives that matter for yarn…
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "cost", display_label: "Price / skein" },
            // …and hide all the generic inventory cruft a yarn user doesn't want.
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
            // Yarn is a consumable, not serviceable equipment. Which optional
            // detail sections show is declared here, per instance, so the part
            // render code stays generic (no yarn-special-case):
            //   • maintenance hidden — a maintenance log is for machines/assets.
            //   • consumable present (not hidden) — turns the "how much is left"
            //     tracker ON by default instead of burying it behind an opt-in.
            { entity_kind: "inventory:part", name: "maintenance", hidden: true },
            { entity_kind: "inventory:part", name: "consumable" },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By weight", view_type: "table", pinned: true, config: { group_by: "weight_class", visible_fields: ["title", "color", "colorway", "fiber", "vendor", "qty", "unit", "length_per_skein"] } },
          ],
        },
      ],
      features: [
      {
        key: "designs",
        name: "Designs",
        question: "Want to track your designs & patterns too?",
        description:
          "A 'Designs' table (a projects instance): each design with its pattern (file/link) + category, and the yarn it needs allocated to it.",
        default: false,
        requires: [{ module: "projects" }],
        next_steps: [
          { label: "Open your Designs table", module: "projects", path: "/instances/designs", hint: "Each design with its pattern link + the yarn it needs." },
        ],
        provides_instances: [
          {
            module: "projects",
            instance_name: "designs",
            display_name: "Designs",
            glyph: "🧵",
            item_noun: "design",
            field_defs: [
              { entity_kind: "projects:project", name: "pattern_url", display_label: "Pattern link", type: "url", position: 1, renderer: "url-link", help: "Link to the pattern (Ravelry, a PDF, a blog post…)." },
              { entity_kind: "projects:project", name: "pattern_category", display_label: "Category", type: "text", position: 2, choices: ["Wearables", "Toys", "Home-wear", "Blankets"], help: "What kind of make this is." },
            ],
            saved_views: [
              { entity_kind: "projects:project", name: "By category", view_type: "table", pinned: true, config: { group_by: "pattern_category", visible_fields: ["title", "pattern_category", "status", "pattern_url"] } },
            ],
          },
        ],
      },
      {
        key: "hooks",
        name: "Hooks & needles",
        question: "Keep track of your hooks & needles?",
        description: "A separate 'Hooks' table (an inventory instance): your crochet hooks / knitting needles by gauge + material.",
        default: false,
        next_steps: [
          { label: "Open your Hooks table", module: "inventory", path: "/instances/hooks", hint: "Crochet hooks / knitting needles by gauge + material." },
        ],
        provides_instances: [
          {
            module: "inventory",
            instance_name: "hooks",
            display_name: "Hooks",
            glyph: "🪡",
            item_noun: "hook",
            qty_unit: "each",
            field_defs: [
              { entity_kind: "inventory:part", name: "hook_gauge", display_label: "Hook gauge", type: "text", position: 1, choices: ["1.0 mm", "1.5 mm", "2.0 mm", "2.5 mm", "3.0 mm", "3.5 mm", "4.0 mm", "4.5 mm", "5.0 mm", "5.5 mm", "6.0 mm", "6.5 mm", "7.0 mm", "8.0 mm", "9.0 mm", "10.0 mm"], help: "Hook/needle size in mm (the number stamped on it)." },
              { entity_kind: "inventory:part", name: "hook_material", display_label: "Hook material", type: "text", position: 2, choices: ["All-metal", "Metal + silicone grip", "Wood", "Bamboo", "Plastic"], help: "What the hook is made of, affects grip + glide." },
            ],
            field_overrides: [
              { entity_kind: "inventory:part", name: "category", hidden: true },
              { entity_kind: "inventory:part", name: "location", hidden: true },
              { entity_kind: "inventory:part", name: "warranty", hidden: true },
              { entity_kind: "inventory:part", name: "min_qty", hidden: true },
              { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
              { entity_kind: "inventory:part", name: "serial_number", hidden: true },
              { entity_kind: "inventory:part", name: "model_number", hidden: true },
            ],
            saved_views: [
              { entity_kind: "inventory:part", name: "By material", view_type: "table", pinned: true, config: { group_by: "hook_material", visible_fields: ["title", "hook_gauge", "hook_material", "qty"] } },
            ],
          },
        ],
      },
      {
        key: "shopping-list",
        name: "Shopping list",
        question: "Auto-build a shopping list when yarn runs low?",
        description: "When yarn runs low it auto-lands on a 'Shopping list' so you know what to restock.",
        default: false,
        requires: [{ module: "lists" }],
        // Merge a wire into the existing Yarn instance (same instance_name →
        // install skips create + applies the wire scoped to yarn:item).
        provides_instances: [
          {
            module: "inventory",
            instance_name: "yarn",
            display_name: "Yarn",
            wires: [
              { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "inventory.stock.low", args: { listTitle: "Shopping list" } },
            ],
          },
        ],
      },
      {
        key: "scan",
        name: "Scan to add",
        question: "Add yarn by scanning a barcode or receipt?",
        description: "Snap a barcode, skein label, or receipt to stock yarn fast (and log the purchase).",
        default: false,
        requires: [{ module: "core-scan" }, { module: "purchases" }],
      },
      ],
    },
  },
  {
    glyph: "🖨️🧵",
    blurb:
      "Two tables that work together. A filament TYPE (Royal Blue PLA) defines everything about the filament once: material, colour, diameter, the nozzle/bed temps, whether it needs drying. Then your SPOOLS just pick a type and add what's unique to the physical spool: its size, the maker's batch code, and how much is left. Each type rolls up how many spools + total kg you have.",
    item_example: "a spool of Royal Blue PLA", // first instance noun is "type"; a spool reads better
    // A type first (defines the filament), then spools of it.
    next_steps: [
      { label: "Add a filament type", module: "inventory", path: "/instances/filament-types", hint: "Define the filament once: brand, material, colour, diameter, temps." },
      { label: "Add a spool", module: "inventory", path: "/instances/filament", hint: "Pick its type, then just the spool size, batch code, and how much is left." },
    ],
    manifest: {
      id: "cobblr.flagship.filament",
      version: "0.5.5",
      name: "Filament",
      description: "A filament TYPE (Royal Blue PLA) defines the filament once: material, colour, diameter, nozzle/bed temps, needs-drying. SPOOLS pick a type + add only what's per-spool: size, batch code, remaining, state. Each type rolls up its spool count + total kg.",
      author: "Cobblr",
      released_at: "2026-06-17",
      changelog:
        "Types and Spools now sit together in the navbar as one element, a quiet \"Filament\" stem with \"Types │ Spools\" links, so the two related tables read as one thing. (0.5.1: scanning a spool's QR find-or-creates its filament TYPE and links the spool automatically, a scan lands in the type→spool model instead of a flat row. 0.5.0: the TYPE defines the whole filament: colour, diameter, nozzle/bed temps and needs-drying live on the type, not re-entered per spool; a SPOOL just picks its type and carries the per-spool facts: size, batch code, remaining, state. Upgrading carries your existing temps + colour up onto the type automatically.)",
      requires: [{ module: "inventory" }],
      // The bundle OWNS its data migration: on upgrade from any earlier install,
      // lift the flat `filament` spools into `filament-types` (deduped by the type
      // key), COPY the defining fields (temps + needs-drying) up onto the type,
      // link them, and convert grams → kg. Idempotent + automatic — runs through
      // the generic inventory:lift-to-type action, no script.
      migrations: [
        {
          to_version: "0.4.1",
          action: "inventory:lift-to-type",
          args: {
            source_instance: "filament",
            type_instance: "filament-types",
            key_fields: ["manufacturer", "material", "color", "diameter"],
            copy_fields: ["nozzle_temp", "bed_temp", "needs_drying"],
            relationship_kind: "instance-of",
            convert_qty: { from_unit: "g", to_unit: "kg", factor: 0.001 },
          },
        },
      ],
      provides_instances: [
        {
          // The TYPE — one row per kind of filament. Defines EVERYTHING about the
          // filament; every spool of it inherits these. The dedup key.
          module: "inventory",
          instance_name: "filament-types",
          display_name: "Filament Types",
          glyph: "🧵",
          item_noun: "type",
          // Group Types + Spools as one connected navbar element under a quiet
          // "Filament" stem (renders "Filament  Types │ Spools").
          nav_group: { key: "filament", label: "Filament" },
          field_defs: [
            { entity_kind: "inventory:part", name: "material", display_label: "Material", type: "text", position: 1, choices: ["PLA", "PLA+", "PETG", "ABS", "ASA", "TPU", "Nylon", "PC", "PVA", "Other"], help: "The plastic type. PLA is the easy default; PETG/ABS for tougher parts." },
            { entity_kind: "inventory:part", name: "color", display_label: "Colour", type: "text", position: 2, renderer: "color-hex", help: "Pick a swatch so the table shows the colour at a glance." },
            { entity_kind: "inventory:part", name: "diameter", display_label: "Diameter", type: "text", position: 3, choices: ["1.75 mm", "2.85 mm"], help: "Filament thickness. 1.75 mm is by far the most common; 2.85 mm for some older/large printers." },
            { entity_kind: "inventory:part", name: "nozzle_temp", display_label: "Nozzle °C", type: "number", position: 4, help: "The hot-end temperature that prints this filament cleanly, same for every spool of it." },
            { entity_kind: "inventory:part", name: "bed_temp", display_label: "Bed °C", type: "number", position: 5, help: "The bed temperature that makes the first layer stick." },
            { entity_kind: "inventory:part", name: "needs_drying", display_label: "Needs drying", type: "boolean", position: 6, choices: ["Stable", "Hygroscopic"], help: "Whether this filament tends to absorb moisture and should be kept dry / dried before use." },
            // Live rollups over the spools linked to this type (instance-of).
            { entity_kind: "inventory:part", name: "spool_count", display_label: "Spools", type: "computed", position: 7, template: "{{instances.count}}", help: "How many physical spools of this type you own." },
            { entity_kind: "inventory:part", name: "total_remaining", display_label: "In stock", type: "computed", position: 8, template: "{{instances.total_qty}} kg", help: "Total filament remaining across all your spools of this type." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "qty", hidden: true },
            { entity_kind: "inventory:part", name: "unit", hidden: true },
            { entity_kind: "inventory:part", name: "cost", hidden: true },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By material", view_type: "table", pinned: true, config: { group_by: "material", visible_fields: ["title", "color", "diameter", "spool_count", "total_remaining"] } },
          ],
        },
        {
          // The SPOOL — one row per physical spool. Picks a TYPE (inherits its
          // colour/temps/etc.) and carries ONLY what's unique to the spool.
          module: "inventory",
          instance_name: "filament",
          // Short within the group — the "Filament" stem supplies the context,
          // so the segment just reads "Spools". The full "Filament Spools" name
          // is reconstructed for page titles from stem + this where needed.
          display_name: "Spools",
          glyph: "🧵",
          item_noun: "spool",
          qty_unit: "kg",
          nav_group: { key: "filament", label: "Filament" },
          // The parent picker on manual creates — AND the scan auto-lift: a
          // scanned spool that carries material/colour/diameter find-or-creates
          // its "Royal Blue PLA" type (deduped by these keys, temps copied up)
          // and links to it, instead of landing as a flat row.
          parent: {
            instance: "filament-types",
            label: "Type",
            key_fields: ["manufacturer", "material", "color", "diameter"],
            copy_fields: ["nozzle_temp", "bed_temp", "needs_drying"],
          },
          field_defs: [
            { entity_kind: "inventory:part", name: "size", display_label: "Spool size", type: "text", position: 1, choices: ["0.5 kg", "1 kg", "2 kg", "3 kg", "4 kg", "5 kg", "25 kg"], help: "The full-spool size you bought (the label weight), the remaining amount is tracked separately." },
            { entity_kind: "inventory:part", name: "batch_code", display_label: "Batch / lot code", type: "text", position: 2, help: "The batch or lot code from the maker's label (e.g. Polar's spool code), for traceability of this exact spool." },
            { entity_kind: "inventory:part", name: "state", display_label: "State", type: "text", position: 3, choices: ["sealed", "open", "empty"], help: "Sealed = unopened; open = in use; empty = used up (keep it for the record or delete it)." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "qty", display_label: "Remaining (kg)" },
            { entity_kind: "inventory:part", name: "manufacturer", hidden: true },
            { entity_kind: "inventory:part", name: "cost", display_label: "Price / spool" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By state", view_type: "table", pinned: true, config: { group_by: "state", visible_fields: ["title", "size", "batch_code", "qty", "unit", "state"] } },
          ],
        },
      ],
    },
  },
  {
    // Title is the noun ("Home Inventory"); the insurance angle is an opt-in
    // feature, not the headline. Base = catalog what you own, room by room.
    glyph: "🏠",
    blurb:
      "Catalog what you own, room by room (make/model, condition, photos) in a grouped 'By room' view. Turn on insurance valuation to add replacement value + purchase details for a claim.",
    // Land in the Home Inventory TABLE (its own instance), not bare /inventory.
    next_steps: [
      { label: "Add your first item", module: "inventory", path: "/instances/home-inventory", hint: "What it is, which room, make/model, condition." },
    ],
    manifest: {
      id: "cobblr.flagship.home-inventory",
      version: "0.4.1",
      name: "Home Inventory",
      description: "Your belongings as their own room-by-room catalog: make/model + condition, filed by room. Optional insurance valuation.",
      author: "Cobblr",
      released_at: "2026-07-15",
      changelog:
        "Rooms are now real Locations. The separate “Room” field is gone: items file into the workspace’s Location tree (rooms, and bins inside them) like everything else, so a thing has one place, not two. Your existing room values move over automatically on this update: each becomes a Location and its items are filed into it, nothing lost. The pinned “By room” view still groups your catalog by room (now off the real Location), and the claim-ready Insurance view too. Earlier: Home Inventory became its OWN table (an inventory instance) with only the fields a home catalog needs, plain-language hints, and optional Insurance valuation.",
      requires: [{ module: "inventory" }],
      // Always-on base: a "Home Inventory" instance of inventory.
      provides_instances: [
        {
          module: "inventory",
          instance_name: "home-inventory",
          display_name: "Home Inventory",
          glyph: "🏠",
          item_noun: "item",
          scan_keywords: ["bedsheet", "bed sheet", "bedding", "linen", "towel", "pillow", "blanket", "comforter", "duvet", "curtain", "rug", "mattress", "furniture", "dresser", "sofa", "couch", "recliner", "desk", "lamp", "mirror", "shelf", "appliance", "vacuum", "fan", "heater", "cookware", "skillet", "utensil", "dishes", "monitor", "router", "cabinet"],
          qty_unit: "each",
          field_defs: [
            // "Room" is deliberately NOT a field here — a home item's room is its
            // Location (an area in the workspace tree), the platform's canonical
            // "where". The migration below moves any pre-0.4 room values into real
            // Locations, and the "By room" view groups on Location.
            { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", position: 2, choices: ["New", "Excellent", "Good", "Fair", "Poor"], help: "Rough state, for resale or an insurance claim. New down to Poor." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "cost", display_label: "Paid" },
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Make / brand" },
            { entity_kind: "inventory:part", name: "model_number", display_label: "Model" },
            // Hide the generic inventory cruft a home catalog doesn't want.
            // NB: `location` is NOT hidden — it's the room now (was hidden while a
            // bespoke "Room" field stood in for it).
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By room", view_type: "table", pinned: true, config: { group_by: "location", visible_fields: ["title", "manufacturer", "model_number", "condition", "qty"] } },
          ],
        },
      ],
      features: [
      {
        key: "insurance",
        name: "Insurance valuation",
        question: "Add insurance valuation (for a claim)?",
        description:
          "Add replacement value + where/when you bought each item, plus an 'Insurance valuation' view to hand an insurer after a fire/theft/move.",
        default: false,
        next_steps: [
          { label: "Value your items for insurance", module: "inventory", path: "/instances/home-inventory", hint: "Replacement value + where/when you bought each item." },
        ],
        // Add the insurance fields to the SAME Home Inventory instance.
        provides_instances: [
          {
            module: "inventory",
            instance_name: "home-inventory",
            display_name: "Home Inventory",
            field_defs: [
              { entity_kind: "inventory:part", name: "replacement_value", display_label: "Replacement value", type: "number", position: 3, help: "What it'd cost to buy new today, what an insurer pays out (not what you paid)." },
              { entity_kind: "inventory:part", name: "purchased_from", display_label: "Bought from", type: "text", position: 4, help: "Store or site, proof-of-purchase for a claim." },
              { entity_kind: "inventory:part", name: "purchase_date", display_label: "Purchased", type: "date", position: 5 },
            ],
            saved_views: [
              { entity_kind: "inventory:part", name: "Insurance valuation", view_type: "table", config: { group_by: "location", visible_fields: ["title", "replacement_value", "purchase_date", "condition"] } },
            ],
          },
        ],
      },
      ],
      // On upgrade from any pre-0.4 version, move each item's old "Room" text
      // value into a real Location (find-or-create the area, file the item in),
      // then drop the field. Runs once per workspace on update; idempotent.
      migrations: [
        { to_version: "0.4.0", action: "inventory:field-to-location", args: { field: "room", instance: "home-inventory" } },
      ],
    },
  },
  {
    glyph: "🧾",
    blurb:
      "Snap a receipt at purchase and never miss a warranty or return window. Tracks where/when you bought it, warranty + return-by dates, serial.",
    next_steps: [
      { label: "Add your first item", module: "inventory", path: "/instances/warranties", hint: "Make/model, where + when you bought it, the return-by date." },
    ],
    manifest: {
      id: "cobblr.flagship.warranties",
      catalog: "extended",
      version: "0.2.2",
      name: "Warranties",
      description: "Your appliances/electronics as their own table: where/when you bought it + warranty and return-by dates, grouped by category.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an inventory instance), not generic Inventory with extra columns: its own nav entry, a “New item” button, only the fields a receipt/warranty tracker needs (the parts/stock cruft is hidden). Plain-language hints + a pinned “By category” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "warranties",
          display_name: "Warranties",
          glyph: "🧾",
          item_noun: "item",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "purchased_from", display_label: "Bought from", type: "text", position: 1, help: "Store or site, proof-of-purchase for a warranty/return." },
            { entity_kind: "inventory:part", name: "purchase_date", display_label: "Purchased", type: "date", position: 2 },
            { entity_kind: "inventory:part", name: "return_by", display_label: "Return by", type: "date", position: 3, help: "The last day you can return it for a refund." },
            { entity_kind: "inventory:part", name: "category", display_label: "Category", type: "text", position: 4, choices: ["Appliance", "Electronics", "Tools", "Furniture", "Vehicle", "Other"] },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Make / brand" },
            { entity_kind: "inventory:part", name: "model_number", display_label: "Model" },
            { entity_kind: "inventory:part", name: "cost", display_label: "Paid" },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By category", view_type: "table", pinned: true, config: { group_by: "category", visible_fields: ["title", "purchase_date", "return_by"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "💊",
    blurb:
      "What to take, the dose and schedule, and how many refills are left before you call the pharmacy. Caregiver-friendly; a 'Current meds' view.",
    next_steps: [
      { label: "Add your first medication", module: "inventory", path: "/instances/medications", hint: "Dose, schedule, refills left, refill-by date." },
    ],
    manifest: {
      id: "cobblr.flagship.medications",
      catalog: "extended",
      version: "0.3.1",
      name: "Medications",
      description: "Your medications as their own table: dose, schedule, instructions, prescriber/pharmacy, refills left + a refill-by date. Caregiver-friendly.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Richer prescription fields: Instructions + Important information (how to take it, warnings), a Time of day field (Morning/Midday/Evening/Bedtime), interval schedules (Every 4/6/8/12 hours) with a First-dose-at time, and a unit picker on the quantity.: Its OWN table (an inventory instance), not generic Inventory with extra columns: its own nav entry, a “New medication” button, only med fields (parts/warranty/supplier cruft hidden), plain-language hints + a pinned “Current meds” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "medications",
          display_name: "Medications",
          glyph: "💊",
          item_noun: "medication",
          scan_keywords: ["vitamin", "supplement", "ibuprofen", "acetaminophen", "aspirin", "bandage", "first aid", "ointment", "antacid", "allergy relief"],
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "dose", display_label: "Dose", type: "text", position: 1, help: "How much per take, e.g. “10 mg”, “1 tablet”, “5 mL”." },
            { entity_kind: "inventory:part", name: "schedule", display_label: "Schedule", type: "text", position: 2, choices: ["Once daily", "Twice daily", "Three times daily", "Every morning", "Every night", "As needed", "Weekly", "Every 4 hours", "Every 6 hours", "Every 8 hours", "Every 12 hours"] },
            { entity_kind: "inventory:part", name: "time_of_day", display_label: "Time of day", type: "text", position: 3, choices: ["Morning", "Midday", "Evening", "Bedtime", "Other / see directions"], help: "When in the day to take it. Pick the closest, or type your own (e.g. “Morning, Evening”)." },
            { entity_kind: "inventory:part", name: "first_dose_at", display_label: "First dose at", type: "text", position: 4, help: "For interval schedules (e.g. every 8 hours), the time of the first dose, e.g. “8:00 AM”." },
            { entity_kind: "inventory:part", name: "instructions", display_label: "Instructions", type: "text", position: 5, help: "How to take it, e.g. “Take 1 capsule by mouth every 8 hours.”" },
            { entity_kind: "inventory:part", name: "important_information", display_label: "Important information", type: "text", position: 6, help: "Warnings or must-knows, e.g. “Take with food”, “Finish all of this medication.”" },
            { entity_kind: "inventory:part", name: "form", display_label: "Form", type: "text", position: 7, choices: ["Tablet", "Capsule", "Liquid", "Injection", "Inhaler", "Topical", "Drops"] },
            { entity_kind: "inventory:part", name: "prescriber", display_label: "Prescriber", type: "text", position: 8 },
            { entity_kind: "inventory:part", name: "pharmacy", display_label: "Pharmacy", type: "text", position: 9 },
            { entity_kind: "inventory:part", name: "rx_number", display_label: "Rx number", type: "text", position: 10, help: "The prescription number on the label, quote it to the pharmacy for a refill." },
            { entity_kind: "inventory:part", name: "refills_left", display_label: "Refills left", type: "number", position: 11, help: "Refills remaining before you need a new prescription." },
            { entity_kind: "inventory:part", name: "refill_by", display_label: "Refill by", type: "date", position: 12, help: "Order a refill by this date so you don't run out." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Maker" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "Current meds", view_type: "table", pinned: true, config: { visible_fields: ["title", "dose", "schedule", "refills_left", "refill_by"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🪴",
    blurb:
      "Stop killing your houseplants: light and watering needs per plant, grouped by light so the windowsill crowd sits apart from the shady corner.",
    next_steps: [
      { label: "Add your first plant", module: "assets", path: "/instances/plants", hint: "Species, light, how often to water." },
    ],
    manifest: {
      id: "cobblr.flagship.plants",
      version: "0.3.2",
      name: "Plants",
      description: "Your houseplants as their own table: species, light, watering interval + pot size, grouped by light.",
      author: "Cobblr",
      released_at: "2026-06-10",
      changelog:
        "Turn on Smart irrigation to let each plant water itself: its watering interval fires a Home Assistant service (or any controller) for that plant's zone + seconds, hands-free.. Now its OWN table (an assets instance), not generic Assets with extra columns: its own nav entry, a “New plant” button, only plant fields (the make/model/serial cruft is hidden). Plain-language hints + a pinned “By light” view.",
      requires: [{ module: "assets" }],
      provides_instances: [
        {
          module: "assets",
          instance_name: "plants",
          display_name: "Plants",
          glyph: "🪴",
          item_noun: "plant",
          scan_keywords: ["fertilizer", "potting soil", "planter", "seeds", "watering can"],
          field_defs: [
            { entity_kind: "assets:asset", name: "species", display_label: "Species", type: "text", position: 1, help: "The plant's name/type, e.g. “Monstera”, “Snake plant”." },
            { entity_kind: "assets:asset", name: "light", display_label: "Light", type: "text", position: 2, choices: ["Low", "Medium", "Bright indirect", "Direct sun"], help: "How much light its spot gets, the table groups by this so similar plants sit together." },
            { entity_kind: "assets:asset", name: "water_every_days", display_label: "Water every (days)", type: "number", unit: "d", position: 3, help: "Days between waterings, e.g. 7 for weekly." },
            { entity_kind: "assets:asset", name: "last_watered", display_label: "Last watered", type: "date", position: 4 },
            { entity_kind: "assets:asset", name: "pot_size", display_label: "Pot size", type: "text", position: 5, help: "Pot diameter, e.g. “6 in”, “15 cm”." },
          ],
          field_overrides: [
            { entity_kind: "assets:asset", name: "manufacturer", hidden: true },
            { entity_kind: "assets:asset", name: "model", hidden: true },
            { entity_kind: "assets:asset", name: "serial_number", hidden: true },
            { entity_kind: "assets:asset", name: "short_name", hidden: true },
            { entity_kind: "assets:asset", name: "excitement", hidden: true },
          ],
          saved_views: [
            { entity_kind: "assets:asset", name: "By light", view_type: "table", pinned: true, config: { group_by: "light", visible_fields: ["title", "species", "water_every_days", "last_watered", "pot_size"] } },
          ],
        },
      ],
      features: [
        {
          // Opt-in: turning a passive log into an actuator. Off by default so the
          // base bundle stays a simple plant table; enabling it pulls in digifab
          // (the device-command path) and wires each plant's watering interval to
          // a controller. Coordinate-not-control: Cobblr calls a Home Assistant
          // service over HTTP, it never drives a valve directly.
          key: "irrigation",
          name: "Smart irrigation",
          question: "Let plants water themselves?",
          description:
            "Each plant's watering interval fires a command at your irrigation controller for THAT plant's zone + duration, hands-free. Ships pointed at a Home Assistant `script.water_zone` service; connect Home Assistant (label it “Irrigation”) and it just works. Works with any HTTP controller via a driver manifest.",
          default: false,
          requires: [{ module: "digifab" }],
          next_steps: [
            { label: "Connect your controller", module: "digifab", path: "/configuration/farm", hint: "Install the Home Assistant driver, add a connection labelled “Irrigation”, paste a long-lived token." },
            { label: "Set each plant's zone + seconds", module: "assets", path: "/instances/plants", hint: "Which valve/zone waters it, and for how long." },
          ],
          // Add the two actuator fields to the SAME plants instance.
          provides_instances: [
            {
              module: "assets",
              instance_name: "plants",
              display_name: "Plants",
              field_defs: [
                { entity_kind: "assets:asset", name: "zone", display_label: "Irrigation zone", type: "text", position: 7, help: "Which valve/zone waters this plant, passed to the controller (e.g. “3”)." },
                { entity_kind: "assets:asset", name: "water_seconds", display_label: "Water (seconds)", type: "number", position: 8, help: "How long to run the zone each watering, in seconds." },
              ],
            },
          ],
          // The actuator wire: each plant's watering interval (water_every_days,
          // synthesised into a recurrence by the assets scanner) fires
          // assets.asset.recurred → run-command at the “Irrigation” connection
          // with THIS plant's own zone + seconds.
          wires: [
            {
              source_kind: "assets:asset",
              action_id: "digifab:run-command",
              trigger_type: "event",
              trigger_event: "assets.asset.recurred",
              args: {
                connection: "Irrigation",
                command: "run-zone",
                zone: "{{metadata.zone}}",
                seconds: "{{metadata.water_seconds}}",
              },
            },
          ],
        },
      ],
    },
  },
  {
    glyph: "🔁",
    blurb:
      "Every streaming service, membership, and recurring bill in one place: a computed per-cycle line + renewal dates, grouped by category.",
    next_steps: [
      { label: "Add your first subscription", module: "inventory", path: "/instances/subscriptions", hint: "Cost per cycle, billing cycle, renewal date." },
    ],
    manifest: {
      id: "cobblr.flagship.subscriptions",
      catalog: "extended",
      version: "0.2.2",
      name: "Subscriptions",
      description: "Every recurring charge as its own table: cost/cycle, renewal date, payment method, grouped by category.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Dropped the computed “Plan” summary line (clutter on the form). (Now its OWN table (an inventory instance), not generic Inventory with extra columns) its own nav entry, a “New subscription” button, only the fields a bills tracker needs (stock/parts cruft hidden). Plain-language hints + a pinned “Renews next” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "subscriptions",
          display_name: "Subscriptions",
          glyph: "🔁",
          item_noun: "subscription",
          field_defs: [
            { entity_kind: "inventory:part", name: "cost_per_cycle", display_label: "Cost / cycle", type: "number", position: 1, help: "What you're charged each billing cycle." },
            { entity_kind: "inventory:part", name: "billing_cycle", display_label: "Billing cycle", type: "text", position: 2, choices: ["Weekly", "Monthly", "Quarterly", "Yearly"] },
            { entity_kind: "inventory:part", name: "renewal_date", display_label: "Renews", type: "date", position: 3, help: "Next charge / renewal date, when to cancel by if you don't want it." },
            { entity_kind: "inventory:part", name: "category", display_label: "Category", type: "text", position: 4, choices: ["Streaming", "Software", "Membership", "Utility", "Insurance", "Phone / internet", "Other"] },
            { entity_kind: "inventory:part", name: "payment_method", display_label: "Paid with", type: "text", position: 5, help: "Which card/account it bills to." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "supplier_url", display_label: "Manage URL" },
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Provider" },
            { entity_kind: "inventory:part", name: "qty", hidden: true },
            { entity_kind: "inventory:part", name: "unit", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "Renews next", view_type: "table", pinned: true, config: { group_by: "category", visible_fields: ["title", "cost_per_cycle", "billing_cycle", "renewal_date"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "📚",
    blurb:
      "Catalog what you collect (books, wine, records, cards, coins) grouped by condition, with paid-vs-value, so you stop buying the dupe.",
    next_steps: [
      { label: "Add your first piece", module: "inventory", path: "/instances/collections", hint: "Condition, edition/year, what you paid + value today." },
    ],
    manifest: {
      id: "cobblr.flagship.collections",
      catalog: "disabled",
      version: "0.3.1",
      name: "Collections",
      description: "Your collection as its own cover wall: condition, edition, paid vs value today, so you stop buying the dupe.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an inventory instance), not generic Inventory with extra columns: its own nav entry, a “New piece” button, only collector fields (parts/warranty/supplier cruft hidden). Plain-language hints + a pinned “By condition” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "collections",
          display_name: "Collections",
          glyph: "📚",
          item_noun: "piece",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", position: 1, choices: ["Mint / Sealed", "Near Mint", "Excellent", "Good", "Fair", "Poor"], help: "Collector grade, the table groups by this; condition drives resale value." },
            { entity_kind: "inventory:part", name: "edition", display_label: "Edition / year", type: "text", position: 2, help: "Printing/pressing/edition or year: first editions, reissues, etc." },
            { entity_kind: "inventory:part", name: "acquired_date", display_label: "Acquired", type: "date", position: 3 },
            { entity_kind: "inventory:part", name: "acquired_price", display_label: "Paid", type: "number", position: 4 },
            { entity_kind: "inventory:part", name: "current_value", display_label: "Value today", type: "number", position: 5, help: "Roughly what it'd sell for now, for insurance or knowing your collection's worth." },
            { entity_kind: "inventory:part", name: "signed", display_label: "Signed / sealed", type: "boolean", position: 6, help: "Tick if signed, sealed, or otherwise special, usually a value bump." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Maker / label" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
          ],
          saved_views: [
            // A collection is photo-first — the wall of covers IS the point, so it
            // opens on the gallery; the grouped table stays a click away.
            { entity_kind: "inventory:part", name: "Gallery", view_type: "gallery", pinned: true, config: { image_field: "image_path", caption_field: "edition" } },
            { entity_kind: "inventory:part", name: "By condition", view_type: "table", config: { group_by: "condition", visible_fields: ["title", "edition", "current_value", "acquired_date"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🔩",
    blurb:
      "Screws, bolts, nuts, washers: thread, length, head and drive as real columns, grouped by thread, so you find an M3×8 in seconds.",
    next_steps: [
      { label: "Add your first fastener", module: "inventory", path: "/instances/fasteners", hint: "Type, thread (M3, 1/4-20…), length, head + drive, and how many you've got." },
    ],
    item_example: "a bag of M3×8 socket head screws",
    manifest: {
      id: "cobblr.flagship.fasteners",
      changelog: "First catalogued release: the fastener drawer skin (length, diameter, thread, head) on inventory.",
      version: "0.1.1",
      name: "Fasteners",
      description:
        "Your fastener drawers as their own table: an inventory instance with thread, length, head, drive and material pre-shaped, quantities + reorder thresholds kept, grouped by thread.",
      author: "Cobblr",
      released_at: "2026-07-02",
      requires: [{ module: "inventory" }],
      features: [
        {
          key: "labels",
          name: "Label printing",
          question: "Print QR labels for the drawers?",
          description: "Adds the Labels module + a one-tap print action on each fastener.",
          requires: [{ module: "labels" }],
          wires: [
            {
              source_kind: "inventory:part",
              action_id: "labels:print",
              trigger_type: "user-invoked",
              template:
                '{{fastener_type | default: "Fastener"}} {{thread | default: "?"}}×{{length_mm | default: "?"}} {{head | default: ""}}',
            },
          ],
        },
      ],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "fasteners",
          display_name: "Fasteners",
          glyph: "🔩",
          item_noun: "fastener",
          qty_unit: "each",
          // Disambiguation-only (lint-scan-keywords): the fields' choices/help
          // already carry screw/bolt/nut/washer/M3/torx… — list only capture
          // phrasings the fields don't.
          scan_keywords: ["heat set insert", "wood screw", "machine screw", "sheet metal screw", "hardware assortment"],
          field_defs: [
            { entity_kind: "inventory:part", name: "fastener_type", display_label: "Type", type: "text", position: 1, choices: ["Screw", "Bolt", "Nut", "Washer", "Standoff", "Threaded insert", "Rivet", "Anchor"] },
            { entity_kind: "inventory:part", name: "thread", display_label: "Thread", type: "text", position: 2, help: "M3, M5, 1/4-20, #6-32…, the table groups by this." },
            { entity_kind: "inventory:part", name: "length_mm", display_label: "Length (mm)", type: "number", unit: "mm", position: 3, help: "Shaft length, not counting the head. Leave blank for nuts/washers." },
            { entity_kind: "inventory:part", name: "head", display_label: "Head", type: "text", position: 4, choices: ["Socket cap", "Button", "Countersunk (flat)", "Pan", "Hex", "Flanged", "None"] },
            { entity_kind: "inventory:part", name: "drive", display_label: "Drive", type: "text", position: 5, choices: ["Hex (Allen)", "Phillips", "Torx", "Slotted", "External hex", "None"] },
            { entity_kind: "inventory:part", name: "material", display_label: "Material", type: "text", position: 6, choices: ["Steel (black oxide)", "Stainless", "Zinc-plated", "Brass", "Nylon", "Titanium"] },
          ],
          field_overrides: [
            // Quantity + reorder threshold are the POINT of a fastener
            // tracker — keep qty/min_qty/location; hide the product-catalog
            // cruft a drawer of M3s never needs.
            { entity_kind: "inventory:part", name: "supplier_url", display_label: "Reorder URL" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "manufacturer", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By thread", view_type: "table", pinned: true, config: { group_by: "thread", visible_fields: ["title", "fastener_type", "length_mm", "head", "qty"] } },
            { entity_kind: "inventory:part", name: "Running low", view_type: "table", config: { filter: { _low_stock: true }, visible_fields: ["title", "thread", "qty", "min_qty"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🪪",
    blurb:
      "Passport, license, registration, insurance: every document that expires, with its number + issuer. Expiry dates land on your calendar automatically.",
    next_steps: [
      { label: "Add your first document", module: "assets", path: "/instances/documents", hint: "Type, number, issuer, and the expiry date." },
    ],
    manifest: {
      id: "cobblr.flagship.documents",
      catalog: "extended",
      version: "0.2.3",
      name: "Documents",
      description: "Every document that expires as its own table: number/issuer/expiry, grouped by type, with expiry dates on your calendar.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Dropped the computed “Summary” line (clutter on the form). (Now its OWN table (an assets instance), not generic Assets with extra columns) its own nav entry, a “New document” button, only the fields a document tracker needs (make/model/serial cruft hidden). Plain-language hints + a pinned “Renewals” view.",
      requires: [{ module: "assets" }],
      provides_instances: [
        {
          module: "assets",
          instance_name: "documents",
          display_name: "Documents",
          glyph: "🪪",
          item_noun: "document",
          field_defs: [
            { entity_kind: "assets:asset", name: "doc_type", display_label: "Type", type: "text", position: 1, choices: ["Passport", "Driver's license", "Vehicle registration", "Insurance policy", "Membership", "Certification", "Visa / permit", "Warranty", "Other"], help: "What kind of document, the table groups by this." },
            { entity_kind: "assets:asset", name: "document_number", display_label: "Number", type: "text", position: 2, help: "The document/policy/licence number printed on it." },
            { entity_kind: "assets:asset", name: "issuer", display_label: "Issued by", type: "text", position: 3, help: "Who issued it: passport office, DMV, insurer, etc." },
            { entity_kind: "assets:asset", name: "issued_date", display_label: "Issued", type: "date", position: 4 },
            { entity_kind: "assets:asset", name: "expires_date", display_label: "Expires", type: "date", position: 5, help: "Expiry date, renew before this; it lands on your calendar." },
          ],
          field_overrides: [
            { entity_kind: "assets:asset", name: "manufacturer", hidden: true },
            { entity_kind: "assets:asset", name: "model", hidden: true },
            { entity_kind: "assets:asset", name: "serial_number", hidden: true },
            { entity_kind: "assets:asset", name: "short_name", hidden: true },
            { entity_kind: "assets:asset", name: "excitement", hidden: true },
          ],
          saved_views: [
            { entity_kind: "assets:asset", name: "Renewals", view_type: "table", pinned: true, config: { group_by: "doc_type", visible_fields: ["title", "document_number", "issuer", "expires_date"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🐾",
    blurb:
      "Each pet's vitals + schedule: species, breed, birthday, vet, microchip, weight, and next-vet / rabies-due dates that land on your calendar.",
    next_steps: [
      { label: "Add your first pet", module: "assets", path: "/instances/pets", hint: "Species, breed, birthday, vet + vaccination dates." },
    ],
    manifest: {
      id: "cobblr.flagship.pets",
      catalog: "extended",
      version: "0.2.2",
      name: "Pets",
      description: "Your pets as their own table: vitals + vet/vaccination dates (calendar-reminded), grouped by species.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an assets instance), not generic Assets with extra columns: its own nav entry, a “New pet” button, only pet fields (make/model/serial cruft hidden). Plain-language hints + a pinned “By species” view.",
      requires: [{ module: "assets" }],
      provides_instances: [
        {
          module: "assets",
          instance_name: "pets",
          display_name: "Pets",
          glyph: "🐾",
          item_noun: "pet",
          scan_keywords: ["leash", "collar", "litter", "kibble", "dog food", "cat food", "treats", "aquarium", "pet bed"],
          field_defs: [
            { entity_kind: "assets:asset", name: "species", display_label: "Species", type: "text", position: 1, choices: ["Dog", "Cat", "Rabbit", "Bird", "Reptile", "Fish", "Horse", "Other"], help: "The table groups pets by this." },
            { entity_kind: "assets:asset", name: "breed", display_label: "Breed", type: "text", position: 2 },
            { entity_kind: "assets:asset", name: "birthdate", display_label: "Birthday", type: "date", position: 3 },
            { entity_kind: "assets:asset", name: "weight_kg", display_label: "Weight (kg)", type: "number", unit: "kg", position: 4, help: "Current weight, handy for dosing meds + spotting changes." },
            { entity_kind: "assets:asset", name: "vet", display_label: "Vet", type: "text", position: 5 },
            { entity_kind: "assets:asset", name: "microchip", display_label: "Microchip", type: "text", position: 6, help: "The chip ID registered to you, vets/shelters scan it to find the owner." },
            { entity_kind: "assets:asset", name: "next_vet_visit", display_label: "Next vet visit", type: "date", position: 7, help: "Next check-up, lands on your calendar." },
            { entity_kind: "assets:asset", name: "rabies_due", display_label: "Rabies due", type: "date", position: 8, help: "When the rabies vaccination is next due." },
          ],
          field_overrides: [
            { entity_kind: "assets:asset", name: "manufacturer", hidden: true },
            { entity_kind: "assets:asset", name: "model", hidden: true },
            { entity_kind: "assets:asset", name: "serial_number", hidden: true },
            { entity_kind: "assets:asset", name: "short_name", hidden: true },
            { entity_kind: "assets:asset", name: "excitement", hidden: true },
          ],
          saved_views: [
            { entity_kind: "assets:asset", name: "By species", view_type: "table", pinned: true, config: { group_by: "species", visible_fields: ["title", "breed", "weight_kg", "next_vet_visit", "rabies_due"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🎁",
    blurb:
      "Stash gift ideas year-round: who, what occasion + its date, a link, a budget, and the idea→bought→wrapped→given pipeline. Dates hit your calendar.",
    next_steps: [
      { label: "Add your first gift idea", module: "inventory", path: "/instances/gifts", hint: "Who it's for, the occasion + its date, a budget." },
    ],
    manifest: {
      id: "cobblr.flagship.gifts-occasions",
      catalog: "disabled",
      version: "0.2.1",
      name: "Gifts & Occasions",
      description: "Gift ideas as their own table: who, occasion + date (calendar-reminded), budget, and an idea→bought→wrapped→given pipeline.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an inventory instance), not generic Inventory with extra columns: its own nav entry, a “New gift” button, only gift-list fields (stock/parts cruft hidden). Plain-language hints + a pinned “By recipient” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "gifts",
          display_name: "Gifts & Occasions",
          glyph: "🎁",
          item_noun: "gift",
          field_defs: [
            { entity_kind: "inventory:part", name: "recipient", display_label: "For", type: "text", position: 1, help: "Who the gift is for, the table groups by this." },
            { entity_kind: "inventory:part", name: "occasion", display_label: "Occasion", type: "text", position: 2, choices: ["Birthday", "Christmas", "Anniversary", "Wedding", "Graduation", "Holiday", "Just because", "Other"] },
            { entity_kind: "inventory:part", name: "occasion_date", display_label: "Occasion date", type: "date", position: 3, help: "When you need it by, lands on your calendar." },
            { entity_kind: "inventory:part", name: "budget", display_label: "Budget", type: "number", position: 4 },
            { entity_kind: "inventory:part", name: "status", display_label: "Status", type: "text", position: 5, choices: ["Idea", "Bought", "Wrapped", "Given"], help: "Where it is in the pipeline. Idea → Bought → Wrapped → Given." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "supplier_url", display_label: "Idea link" },
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Store" },
            { entity_kind: "inventory:part", name: "cost", display_label: "Spent" },
            { entity_kind: "inventory:part", name: "qty", hidden: true },
            { entity_kind: "inventory:part", name: "unit", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By recipient", view_type: "table", pinned: true, config: { group_by: "recipient", visible_fields: ["title", "occasion", "occasion_date", "budget", "status"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🧻",
    blurb:
      "Toiletries / cleaning / batteries hit their reorder level → auto onto the shopping list; check off after shopping → it restocks. Grouped by area.",
    next_steps: [
      { label: "Add your first supply", module: "inventory", path: "/instances/supplies", hint: "Set a reorder level so it auto-adds to your shopping list when low." },
    ],
    manifest: {
      id: "cobblr.flagship.household-supplies",
      catalog: "disabled",
      version: "0.3.2",
      name: "Household Supplies",
      description: "Your household supplies as their own table, reorder level per supply auto-adds to a shopping list on low stock; check off → it restocks. Grouped by where they live.",
      author: "Cobblr",
      released_at: "2026-07-15",
      changelog:
        "Named for the thing, not the trick it does: “Household Supplies auto-reorder” is now just “Household Supplies” (the auto-reorder is what it DOES, and the description already says so). Earlier: “Area” became a real Location, so a thing has one place, not two, and existing area values moved over automatically; before that, “Usual pack” became “Pack size”.",
      requires: [{ module: "inventory" }, { module: "lists" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "supplies",
          display_name: "Household Supplies",
          glyph: "🧻",
          item_noun: "supply",
          scan_keywords: ["detergent", "cleaner", "soap", "shampoo", "toothpaste", "deodorant", "paper towel", "toilet paper", "tissue", "battery", "batteries", "trash bag", "garbage bag", "sponge", "bleach", "wipes", "laundry", "dish soap", "air freshener", "light bulb"],
          qty_unit: "each",
          // Low-stock → shopping list, and check-off → restock, scoped to this
          // instance (the installer rewrites source_kind to supplies:item).
          wires: [
            { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "inventory.stock.low", args: { listTitle: "Shopping list" } },
            { source_kind: "inventory:part", action_id: "inventory:adjust-stock", trigger_type: "event", trigger_event: "lists.item.checked", args: { delta: 1, reason: "Restocked, checked off the shopping list" } },
          ],
          field_defs: [
            // "Area" is deliberately NOT a field — where a supply lives is its
            // Location (the platform's canonical "where"). The migration below
            // moves any pre-0.3 area values into real Locations.
            { entity_kind: "inventory:part", name: "typical_pack", display_label: "Pack size", type: "text", position: 2, field_role: "pack", help: "How many units are in the package you scanned, e.g. a single, or a 10-pack. The pack in front of you, not a reorder estimate." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "min_qty", display_label: "Reorder at" },
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            // `location` is NOT hidden — it's where the supply lives now.
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By area", view_type: "table", pinned: true, config: { group_by: "location", visible_fields: ["title", "qty", "unit", "typical_pack"] } },
          ],
        },
      ],
      // On upgrade from any pre-0.3 version, move each supply's old "Area" text
      // value into a real Location (find-or-create the area, file it in), then
      // drop the field. Runs once per workspace on update; idempotent.
      migrations: [
        { to_version: "0.3.0", action: "inventory:field-to-location", args: { field: "area", instance: "supplies" } },
      ],
    },
  },
  {
    glyph: "🏡🔧",
    blurb:
      "The home version of Vehicle Maintenance (furnace, water heater, HVAC filters, detectors) with service logs + next-due dates on your calendar.",
    next_steps: [
      { label: "Add your first system", module: "assets", path: "/instances/maintenance", hint: "Furnace, water heater, HVAC filter, with its next-service date." },
    ],
    manifest: {
      id: "cobblr.flagship.home-maintenance",
      catalog: "disabled",
      version: "0.3.2",
      name: "Home Maintenance",
      description: "Your home's systems as their own table (furnace, water heater, HVAC filters, detectors) with service logs + next-due dates on your calendar.",
      author: "Cobblr",
      released_at: "2026-07-15",
      changelog:
        "Named for the thing, not the artefact: “Home Maintenance Schedule” is now just “Home Maintenance” (a bundle title is the noun; the schedule is one of the things inside it). Earlier: each system's “Location” became a real Location so a thing has one place not two, with existing values moved over automatically; before that, Home Maintenance became its OWN table with only the fields a maintenance schedule needs.",
      requires: [{ module: "assets" }, { module: "core-maintenance" }],
      provides_instances: [
        {
          module: "assets",
          instance_name: "maintenance",
          display_name: "Home Maintenance",
          glyph: "🔧",
          item_noun: "system",
          field_defs: [
            // "Location" is deliberately NOT a field — where a system lives is
            // its Location (the platform's canonical "where", native on assets).
            // The migration below moves any pre-0.3 location values into real
            // Locations.
            { entity_kind: "assets:asset", name: "system_type", display_label: "System", type: "text", position: 1, choices: ["Furnace", "Air conditioner", "Water heater", "HVAC filter", "Smoke / CO detector", "Gutters", "Sump pump", "Dishwasher", "Washer", "Dryer", "Refrigerator", "Garage door", "Other"], help: "Which home system, the table groups by this." },
            { entity_kind: "assets:asset", name: "installed_date", display_label: "Installed", type: "date", position: 3 },
            { entity_kind: "assets:asset", name: "filter_size", display_label: "Filter / part size", type: "text", position: 4, help: "The filter or replacement-part size to buy, e.g. “16×25×1” for a furnace filter." },
          ],
          field_overrides: [
            { entity_kind: "assets:asset", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "assets:asset", name: "model", display_label: "Model" },
            { entity_kind: "assets:asset", name: "short_name", hidden: true },
            { entity_kind: "assets:asset", name: "type", hidden: true },
            { entity_kind: "assets:asset", name: "serial_number", hidden: true },
            { entity_kind: "assets:asset", name: "excitement", hidden: true },
          ],
          saved_views: [
            { entity_kind: "assets:asset", name: "By system", view_type: "table", pinned: true, config: { group_by: "system_type", visible_fields: ["title", "installed_date", "filter_size"] } },
          ],
        },
      ],
      // On upgrade from any pre-0.3 version, move each system's old "Location"
      // text value into a real Location (find-or-create the area, file it in),
      // then drop the field. Runs once per workspace on update; idempotent.
      migrations: [
        { to_version: "0.3.0", action: "assets:field-to-location", args: { field: "location", instance: "maintenance" } },
      ],
    },
  },
  {
    // Your closet as its own table; the visual outfit builder lives in the
    // companion Outfit Planner app (a Tier-B custom app that reads this
    // instance). Title is the noun ("Wardrobe"); planning is an opt-in feature.
    glyph: "👗",
    blurb:
      "Your closet as its own table: every garment by type, colour, season + a photo, grouped by type. Turn on Outfits to plan looks by occasion + date (and drag garments onto a figure in the Outfit Planner app).",
    next_steps: [
      { label: "Add your first garment", module: "inventory", path: "/instances/wardrobe", hint: "Type, colour, season, snap a photo so it shows in the closet." },
    ],
    manifest: {
      id: "cobblr.flagship.wardrobe",
      catalog: "extended",
      version: "0.1.2",
      name: "Wardrobe",
      description: "Catalog your clothing as its own table (type, colour, season, formality, a photo each) grouped by type. Optional Outfits table for planning looks.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "First release: your wardrobe as its own inventory table (a “New garment” button, only clothing fields, the parts/stock cruft hidden), with a pinned “By type” view + plain-language hints. Turn on Outfits to plan looks by occasion + the date you'll wear them (they land on your calendar); the Outfit Planner app drags garments onto a figure.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "wardrobe",
          display_name: "Wardrobe",
          glyph: "👗",
          item_noun: "garment",
          scan_keywords: ["shirt", "pants", "jeans", "jacket", "coat", "sweater", "socks", "shoes", "sneakers", "boots", "dress", "skirt", "hat", "gloves", "belt", "hoodie", "scarf"],
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "garment_type", display_label: "Type", type: "text", position: 1, choices: ["Top", "Bottom", "Dress", "Outerwear", "Shoes", "Bag", "Accessory", "Jewelry", "Activewear", "Underwear", "Other"], help: "What kind of piece, the closet groups by this." },
            { entity_kind: "inventory:part", name: "color", display_label: "Colour", type: "text", position: 2, renderer: "color-hex", help: "Pick a swatch so the closet shows the colour at a glance." },
            { entity_kind: "inventory:part", name: "season", display_label: "Season", type: "text", position: 3, choices: ["Spring", "Summer", "Fall", "Winter", "All-season"], help: "When you wear it, filter to the right season fast." },
            { entity_kind: "inventory:part", name: "formality", display_label: "Formality", type: "text", position: 4, choices: ["Loungewear", "Casual", "Smart casual", "Work", "Formal", "Athletic"], help: "How dressed-up it is, for building work vs weekend looks." },
            { entity_kind: "inventory:part", name: "fabric", display_label: "Fabric", type: "text", position: 5, choices: ["Cotton", "Wool", "Linen", "Denim", "Leather", "Silk", "Knit", "Synthetic", "Blend", "Other"], help: "Main material, handy for care + seasonality." },
            { entity_kind: "inventory:part", name: "size", display_label: "Size", type: "text", position: 6 },
            { entity_kind: "inventory:part", name: "last_worn", display_label: "Last worn", type: "date", position: 7, help: "Update when you wear it, surfaces the pieces you never reach for." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "cost", display_label: "Paid" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By type", view_type: "table", pinned: true, config: { group_by: "garment_type", visible_fields: ["title", "color", "season", "formality", "manufacturer"] } },
            { entity_kind: "inventory:part", name: "By season", view_type: "table", config: { group_by: "season", visible_fields: ["title", "garment_type", "color", "formality"] } },
          ],
        },
      ],
      features: [
        {
          key: "outfits",
          name: "Outfit planning",
          question: "Plan outfits from your wardrobe?",
          description:
            "Adds an 'Outfits' table (each look by occasion + the date you'll wear it (so it lands on your calendar)) plus the Outfit Planner app, where you drag garments onto a figure to compose a look visually.",
          default: true,
          // The Outfit Planner app needs core-apps (the App Player) enabled.
          requires: [{ module: "projects" }, { module: "core-apps" }],
          next_steps: [
            { label: "Open the Outfit Planner", module: "core-apps", path: "/app/outfit-planner", hint: "Drag garments onto a figure and save the look." },
            { label: "Plan an outfit", module: "projects", path: "/instances/outfits", hint: "Name the look, set the occasion + when you'll wear it." },
          ],
          // Seed the Outfit Planner app (a Tier-B custom block reading the
          // Wardrobe instance). See web/src/lib/outfit-planner-app.ts.
          provides_apps: [
            {
              slug: "outfit-planner",
              name: "Outfit Planner",
              icon: "👗",
              pages: [
                { slug: "plan", title: "Plan an outfit", blocks: [{ type: "custom", html: OUTFIT_PLANNER_HTML, height: 760 }] },
              ],
            },
          ],
          provides_instances: [
            {
              module: "projects",
              instance_name: "outfits",
              display_name: "Outfits",
              glyph: "👚",
              item_noun: "outfit",
              field_defs: [
                { entity_kind: "projects:project", name: "occasion", display_label: "Occasion", type: "text", position: 1, choices: ["Everyday", "Work", "Date", "Event", "Travel", "Workout", "Special"], help: "What the look is for, the table groups by this." },
                { entity_kind: "projects:project", name: "wear_date", display_label: "Wear on", type: "date", position: 2, help: "When you'll wear it, lands on your calendar as “what to wear”." },
                { entity_kind: "projects:project", name: "pieces", display_label: "Pieces", type: "text", position: 3, help: "The garments in this look: jot them here, or build it visually in the Outfit Planner app." },
              ],
              saved_views: [
                { entity_kind: "projects:project", name: "By occasion", view_type: "table", pinned: true, config: { group_by: "occasion", visible_fields: ["title", "occasion", "wear_date"] } },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    // The Cataloging Bench (Phase 1). Your CNC tooling as its own table, plus a
    // guided "Bench" Tier-B app that captures an unknown tool's measurements +
    // observations + bin and composes its spec — no manual data entry. See
    // docs/product/cataloging-bench.md. The bench app needs core-apps (the App
    // Player); the commit goes through inventory's `bench-commit` action.
    glyph: "🔧",
    blurb:
      "Organize your CNC tooling (end mills, drills, taps) without typing. The guided Bench app walks each unknown tool through measure → weigh → observe → photograph → bin, composes its spec, and files it. AI enriches the name when a provider is connected.",
    next_steps: [
      { label: "Open the Bench", module: "core-apps", path: "/app/cataloging-bench", hint: "Run an unknown tool through measure → weigh → observe → bin: no typing." },
      { label: "See your Tooling table", module: "inventory", path: "/instances/tooling", hint: "Every tool by type, with its spec + which bin it's in." },
    ],
    manifest: {
      id: "cobblr.flagship.cnc-tooling",
      catalog: "extended",
      version: "0.2.1",
      name: "CNC Tooling",
      description:
        "Your CNC tooling as its own table (end mills, drills, taps, reamers, inserts) by type/diameter/flutes/material, with the bin each lives in. Ships the guided Cataloging Bench app: capture an unknown tool's measurements + observations and it composes the spec for you (AI-enriched when a provider is connected).",
      author: "Cobblr",
      released_at: "2026-06-12",
      changelog:
        "The guided Cataloging Bench: measure (caliper) → weigh (scale) → observe → photograph → bin, hands-busy, no typing, with a live edge mode that streams real readings from an on-site agent. The structured spec is composed deterministically; a best-effort multimodal AI identify enriches the name/brand from the measurements when a provider is connected. Built on two GENERIC capabilities the bench app wires together, inventory:create-item + core-scan:identify, not a bench-specific module action. See docs/product/cataloging-bench.md.",
      requires: [{ module: "inventory" }, { module: "core-apps" }, { module: "core-scan" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "tooling",
          display_name: "Tooling",
          glyph: "🔧",
          item_noun: "tool",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "tool_type", display_label: "Type", type: "text", position: 1, choices: ["End mill", "Drill", "Tap", "Reamer", "Insert", "Collet", "Other"], help: "What kind of tool, the table groups by this." },
            { entity_kind: "inventory:part", name: "diameter_mm", display_label: "Diameter (mm)", type: "number", unit: "mm", position: 2, help: "Cutting diameter, from the calipers." },
            { entity_kind: "inventory:part", name: "shank_dia_mm", display_label: "Shank (mm)", type: "number", unit: "mm", position: 3, help: "Shank diameter, the size your collet/holder needs." },
            { entity_kind: "inventory:part", name: "overall_length_mm", display_label: "Overall length (mm)", type: "number", unit: "mm", position: 4, help: "Tip to end, for reach + holder clearance." },
            { entity_kind: "inventory:part", name: "flute_length_mm", display_label: "Flute length (mm)", type: "number", unit: "mm", position: 5, help: "Length of cut." },
            { entity_kind: "inventory:part", name: "flute_count", display_label: "Flutes", type: "number", position: 6, help: "Number of flutes / lands." },
            { entity_kind: "inventory:part", name: "end_type", display_label: "End", type: "text", position: 7, choices: ["Square", "Ball", "Corner-radius", "Chamfer", "Drill point"], help: "Geometry of the cutting end." },
            { entity_kind: "inventory:part", name: "material", display_label: "Material", type: "text", position: 8, choices: ["Carbide", "HSS", "Cobalt", "Other"], help: "What the tool is made of." },
            { entity_kind: "inventory:part", name: "coating", display_label: "Coating", type: "text", position: 9, choices: ["Uncoated", "TiN", "TiCN", "TiAlN", "AlTiN", "DLC", "Other"], help: "Surface coating, if any." },
            { entity_kind: "inventory:part", name: "weight_g", display_label: "Weight (g)", type: "number", unit: "g", position: 10, help: "From the scale, helps the AI tell carbide from HSS." },
            { entity_kind: "inventory:part", name: "bin", display_label: "Bin", type: "text", position: 11, help: "Where it physically lives. “Bin 1 / Comp 6”. Set at the bench." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By type", view_type: "table", pinned: true, config: { group_by: "tool_type", visible_fields: ["title", "diameter_mm", "flute_count", "end_type", "material", "bin"] } },
            { entity_kind: "inventory:part", name: "By bin", view_type: "table", config: { group_by: "bin", visible_fields: ["title", "tool_type", "diameter_mm", "material"] } },
          ],
        },
      ],
      // The guided capture app — a Tier-B custom block reading nothing and
      // committing via inventory:bench-commit. See web/src/lib/bench-app.ts.
      provides_apps: [
        {
          slug: "cataloging-bench",
          name: "Cataloging Bench",
          icon: "🔧",
          pages: [
            { slug: "bench", title: "The bench", blocks: [{ type: "custom", html: CATALOGING_BENCH_HTML, height: 720 }] },
          ],
        },
      ],
    },
  },
  {
    glyph: "🚗",
    blurb:
      "Vehicles as their own table - make/model/year, VIN, mileage, plate - with service logs and next-due dates on your calendar.",
    item_example: "your car (scan the VIN)",
    manifest: {
      "id": "cobblr.flagship.vehicles",
      "name": "Vehicles",
      "version": "0.4.1",
      "description": "Your vehicles as their own table - make/model/year, VIN, mileage, plate - with service logs (oil, tires, brakes) and next-due dates on your calendar. Replaces a glovebox folder of receipts and a sticky note on the windshield.",
      "author": "Cobblr",
      "released_at": "2026-07-13",
      "changelog": "Renamed to Vehicles and given its OWN table (an assets instance), not generic Assets with extra columns - its own nav entry, a “New vehicle” button, and only the fields a vehicle needs (VIN, make, model, year, trim, mileage, fuel, color). Service logs come from core-maintenance; scan a VIN and it fills the whole record.",
      "requires": [
        {
          "module": "assets"
        },
        {
          "module": "core-maintenance"
        }
      ],
      "provides_instances": [
        {
          "module": "assets",
          "instance_name": "vehicles",
          "display_name": "Vehicles",
          "glyph": "🚗",
          "item_noun": "vehicle",
          "scan_keywords": [
            "vin",
            "vehicle",
            "car",
            "truck",
            "suv",
            "van",
            "minivan",
            "sedan",
            "coupe",
            "hatchback",
            "motorcycle",
            "automobile",
            "odometer",
            "mileage",
            "license plate",
            "make",
            "model",
            "engine"
          ],
          "field_defs": [
            {
              "entity_kind": "assets:asset",
              "name": "year",
              "display_label": "Year",
              "type": "number",
              "position": 1,
              "decode_role": "decode:year"
            },
            {
              "entity_kind": "assets:asset",
              "name": "trim",
              "display_label": "Trim",
              "type": "text",
              "position": 2,
              "help": "The trim level - e.g. EX, Sport, Limited. Filled from a VIN decode when available.",
              "decode_role": "decode:trim"
            },
            {
              "entity_kind": "assets:asset",
              "name": "license_plate",
              "display_label": "License plate",
              "type": "text",
              "position": 3
            },
            {
              "entity_kind": "assets:asset",
              "name": "mileage",
              "display_label": "Mileage",
              "type": "number",
              "position": 4,
              "help": "Current odometer reading - service schedules count from this."
            },
            {
              "entity_kind": "assets:asset",
              "name": "fuel_type",
              "display_label": "Fuel",
              "type": "text",
              "position": 5,
              "choices": [
                "Gas",
                "Diesel",
                "Hybrid",
                "Electric"
              ],
              "decode_role": "decode:fuel_type"
            },
            {
              "entity_kind": "assets:asset",
              "name": "color",
              "display_label": "Color",
              "type": "text",
              "position": 6
            }
          ],
          "field_overrides": [
            {
              "entity_kind": "assets:asset",
              "name": "manufacturer",
              "display_label": "Make",
              "decode_role": "decode:make"
            },
            {
              "entity_kind": "assets:asset",
              "name": "model",
              "display_label": "Model",
              "decode_role": "decode:model"
            },
            {
              "entity_kind": "assets:asset",
              "name": "serial_number",
              "display_label": "VIN",
              "decode_role": "identifier:vin"
            },
            {
              "entity_kind": "assets:asset",
              "name": "short_name",
              "hidden": true
            },
            {
              "entity_kind": "assets:asset",
              "name": "type",
              "hidden": true
            },
            {
              "entity_kind": "assets:asset",
              "name": "quantity",
              "hidden": true
            },
            {
              "entity_kind": "assets:asset",
              "name": "excitement",
              "hidden": true
            },
            {
              "entity_kind": "assets:asset",
              "name": "last_service_at",
              "hidden": true
            }
          ],
          "saved_views": [
            {
              "entity_kind": "assets:asset",
              "name": "By make",
              "view_type": "table",
              "pinned": true,
              "config": {
                "group_by": "manufacturer",
                "visible_fields": [
                  "title",
                  "year",
                  "model",
                  "mileage",
                  "fuel_type"
                ]
              }
            }
          ]
        }
      ],
      "features": [
        {
          "key": "connected-car",
          "name": "Connected car (auto-mileage)",
          "question": "Does a device report your mileage?",
          "description": "Let the car update its own odometer. Point anything that can POST JSON - an OBD reader via a phone app, a WiFi OBD device through Home Assistant, or a telematics service webhook - at a Cobblr inbound webhook (Configuration → Integrations → Inbound tokens) with a body like {\"vehicle\": \"Honda Civic\", \"odometer\": 48650}. The shipped wire matches the vehicle by name and writes the mileage; service schedules and the calendar react to the new reading. Add more keys to the payload and the wire to sync other fields (fuel level, battery health, …).",
          "default": false,
          "wires": [
            {
              "source_kind": "assets:asset",
              "action_id": "assets:update-fields",
              "trigger_type": "event",
              "trigger_event": "core-integrations.inbound.received",
              "target": "none",
              "args": {
                "asset": "{{event.body.vehicle}}",
                "mileage": "{{event.body.odometer}}"
              }
            }
          ]
        }
      ]
    },
  },
  {
    glyph: "🧱",
    blurb:
      "The six Rebrickable reference catalogs (themes, colors, parts, sets, minifigs, part categories) with the right renderer per field - schema config; load rows via the CSV importer.",
    manifest: {
      "id": "cobblr.community.rebrickable-catalogs",
      "released_at": "2026-07-13",
      "changelog": "First catalogued release: the six Rebrickable reference catalogs with per-field renderers (schema config; rows load via the CSV importer).",
      "version": "0.5.0",
      "name": "Rebrickable Catalogs",
      "description": "Installs the six Rebrickable reference catalogs (themes, part categories, colors, parts, sets, minifigs) with pre-configured renderers: color swatches for the colors palette, image thumbs for sets + minifigs, year columns formatted as years. Row data is loaded separately via the CSV importer or scripts/seed-rebrickable.mjs.",
      "author": "Cobblr community",
      "readme_md": "# Rebrickable catalogs\n\nSix reference catalogs sourced from [Rebrickable's public CSV dumps](https://rebrickable.com/downloads/). The bundle ships the **schema config only** - id columns, title columns, image columns, hero swatch for the colors palette, and the right renderer per field.\n\n## Catalogs installed\n\n| Catalog | Rows | Notes |\n|---|---|---|\n| Themes | ~500 | Bionicle, Star Wars, City, etc. |\n| Part categories | ~75 | Bricks, plates, slopes, tiles, … |\n| Colors | ~280 | Big swatch on every card via `hero_field=rgb` + `hero_renderer=color-hex`. |\n| Parts | ~62,000 | Individual LEGO elements. Image enrichment via `inventory_parts.csv.gz` (see seeder). |\n| Sets | ~27,000 | Has `img_url` from Rebrickable's CDN. |\n| Minifigs | ~17,000 | Has `img_url`; broken URLs fall back to a placeholder. |\n\n## Loading the data\n\nThis bundle is the *configuration*, not the rows. To load rows:\n\n```bash\nnode scripts/seed-rebrickable.mjs\n```\n\nThe seeder logs in as the demo user, finds the workspace with this bundle installed, and CSV-imports each catalog from Rebrickable's CDN. It runs idempotently - re-running refreshes the rows.",
      "requires": [],
      "catalogs": [
        {
          "external_id": "rebrickable-themes",
          "name": "Rebrickable themes",
          "description": "LEGO themes - Bionicle, Star Wars, City, Town, Castle, etc. Reference taxonomy; not directly bindable to inventory items (sets reference themes).",
          "source_url": "https://cdn.rebrickable.com/media/downloads/themes.csv.gz",
          "schema": {
            "id_column": "id",
            "title_column": "name",
            "bindable_to_kinds": [],
            "semantic_type": "lego.theme"
          }
        },
        {
          "external_id": "rebrickable-part-categories",
          "name": "Rebrickable part categories",
          "description": "Part categories - bricks, plates, slopes, tiles, minifig parts, etc. Reference taxonomy; not directly bindable.",
          "source_url": "https://cdn.rebrickable.com/media/downloads/part_categories.csv.gz",
          "schema": {
            "id_column": "id",
            "title_column": "name",
            "bindable_to_kinds": [],
            "semantic_type": "lego.part-category"
          }
        },
        {
          "external_id": "rebrickable-colors",
          "name": "Rebrickable colors",
          "description": "Every LEGO color Rebrickable tracks. The card renders a big swatch in the image slot via hero_field=rgb + hero_renderer=color-hex.",
          "source_url": "https://cdn.rebrickable.com/media/downloads/colors.csv.gz",
          "schema": {
            "id_column": "id",
            "title_column": "name",
            "hero_field": "rgb",
            "hero_renderer": "color-hex",
            "field_renderers": {
              "is_trans": "boolean"
            },
            "field_labels": {
              "is_trans": "Transparent",
              "num_parts": "Used in parts",
              "num_sets": "Used in sets",
              "y1": "First seen",
              "y2": "Last seen"
            },
            "bindable_to_kinds": [],
            "semantic_type": "lego.color"
          }
        },
        {
          "external_id": "rebrickable-parts",
          "name": "Rebrickable parts",
          "description": "Individual LEGO parts (~62k rows). image_column points at img_url, populated by the seeder from inventory_parts.csv.gz.",
          "source_url": "https://cdn.rebrickable.com/media/downloads/parts.csv.gz",
          "schema": {
            "id_column": "part_num",
            "title_column": "name",
            "image_column": "img_url",
            "field_labels": {
              "part_num": "Part number",
              "part_cat_id": "Category",
              "part_material": "Material",
              "img_url": "Image"
            },
            "bindable_to_kinds": [
              "inventory:part"
            ],
            "semantic_type": "lego.part"
          }
        },
        {
          "external_id": "rebrickable-sets",
          "name": "Rebrickable sets",
          "description": "LEGO sets (~27k rows). Each has an img_url on Rebrickable's CDN.",
          "source_url": "https://cdn.rebrickable.com/media/downloads/sets.csv.gz",
          "schema": {
            "id_column": "set_num",
            "title_column": "name",
            "image_column": "img_url",
            "field_renderers": {
              "year": "year",
              "img_url": "url-link"
            },
            "field_labels": {
              "set_num": "Set number",
              "theme_id": "Theme",
              "num_parts": "Pieces",
              "year": "Year",
              "img_url": "Image"
            },
            "bindable_to_kinds": [
              "inventory:part"
            ],
            "semantic_type": "lego.set"
          }
        },
        {
          "external_id": "rebrickable-minifigs",
          "name": "Rebrickable minifigs",
          "description": "Minifigure catalog (~17k rows). Some img_urls 404 on the CDN - those degrade to a placeholder.",
          "source_url": "https://cdn.rebrickable.com/media/downloads/minifigs.csv.gz",
          "schema": {
            "id_column": "fig_num",
            "title_column": "name",
            "image_column": "img_url",
            "field_renderers": {
              "img_url": "url-link"
            },
            "field_labels": {
              "fig_num": "Figure number",
              "num_parts": "Pieces",
              "img_url": "Image"
            },
            "bindable_to_kinds": [
              "inventory:part"
            ],
            "semantic_type": "lego.minifig"
          }
        },
        {
          "external_id": "rebrickable-inventory-parts",
          "name": "Rebrickable set inventories",
          "description": "The set BOM: every (set_inventory, part_num, color_id) tuple with quantity + img_url. ~5M rows. Powers the 'what parts does set X contain' lookup and the 'what am I still missing' restoration workflow. Excluded from the global quick-add typeahead because the row count would drown out the real catalogs. The seeder synthesises a row_id = '<inventory_id>-<part_num>-<color_id>-<is_spare>' column on import so each tuple gets its own external_id.",
          "source_url": "https://cdn.rebrickable.com/media/downloads/inventory_parts.csv.gz",
          "schema": {
            "id_column": "row_id",
            "title_column": "part_num",
            "image_column": "img_url",
            "field_renderers": {
              "img_url": "url-link",
              "is_spare": "boolean"
            },
            "field_labels": {
              "row_id": "Row ID",
              "inventory_id": "Set inventory",
              "set_num": "Set number",
              "part_num": "Part number",
              "color_id": "Color",
              "is_spare": "Spare",
              "img_url": "Image"
            },
            "exclude_from_global_search": true,
            "bindable_to_kinds": [],
            "semantic_type": "lego.bom"
          }
        }
      ],
      "catalog": "extended"
    },
  },
];

/** The CURRENT label a bundle declares for a next-step `path`. Setup cards are
 *  cached in localStorage at install time, so a copy change to a next_steps
 *  label wouldn't otherwise reach an existing card — the renderer prefers this
 *  live label over the cached one (matched by path). */
let _nextStepLabelByPath: Map<string, string> | null = null;
export function liveNextStepLabel(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (!_nextStepLabelByPath) {
    _nextStepLabelByPath = new Map();
    for (const b of FEATURED_BUNDLES) {
      for (const s of b.next_steps ?? []) if (s.path) _nextStepLabelByPath.set(s.path, s.label);
      for (const f of b.manifest.features ?? [])
        for (const s of f.next_steps ?? []) if (s.path) _nextStepLabelByPath.set(s.path, s.label);
    }
  }
  return _nextStepLabelByPath.get(path);
}
