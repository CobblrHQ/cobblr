// The flagship template catalog (templates-first-authoring.md).
//
// A curated, module-OWNED catalog — NOT read from demo-sites/ (that dir is
// not shipped in the api Docker image). Each entry is a refined starting
// point: a real bundle manifest (field_defs + wires only, same shape the
// builder emits) plus the metadata a model/user needs to pick the nearest.
//
// Phase 1 = "match-template" by reading this list (the driving model picks).
// Grow the catalog from white-label engagements (business-models/08 flywheel).

export interface TemplateEntry {
  id: string;
  name: string;
  /** One line — what it is + what it replaces, for the picker. */
  description: string;
  /** A few plain-English phrases a user's intent might resemble. The picker
   *  (model or human) matches against these; no LLM call in Phase 1. */
  use_case: string[];
  /** Modules the manifest needs enabled. */
  requires: string[];
  /** Entity kinds the template touches — the default `selected_kinds` for a
   *  customize-template compile, so context stays minimal. */
  kinds: string[];
  /** The bundle manifest to start from (field_defs + wires). */
  manifest: Record<string, unknown>;
}

export const TEMPLATE_CATALOG: TemplateEntry[] = [
  {
    id: "home-inventory",
    name: "Home Inventory",
    description:
      "Track household belongings the way HomeBox does — room, purchase info, replacement cost, asset labels. The HomeBox alternative you can extend.",
    use_case: [
      "track my stuff at home",
      "household inventory",
      "what i own and where it is",
      "home contents for insurance",
      "homebox replacement",
    ],
    requires: ["inventory", "labels"],
    kinds: ["inventory:part"],
    manifest: {
      id: "cobblr.user.home-inventory",
      version: "0.1.0",
      name: "Home Inventory",
      description:
        "Household fields on parts: room, purchase source/price/date, replacement cost, model year, plus an asset-sticker label wire.",
      requires: [{ module: "inventory" }, { module: "labels" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "room", display_label: "Room", type: "text", choices: ["Garage", "Kitchen", "Living room", "Bedroom", "Office", "Basement", "Attic", "Shed", "Outside"] },
        { entity_kind: "inventory:part", name: "purchase_source", display_label: "Bought from", type: "text" },
        { entity_kind: "inventory:part", name: "purchase_price", display_label: "Purchase price ($)", type: "number" },
        { entity_kind: "inventory:part", name: "purchase_date", display_label: "Purchase date", type: "date" },
        { entity_kind: "inventory:part", name: "replacement_cost", display_label: "Replacement cost ($)", type: "number" },
        { entity_kind: "inventory:part", name: "model_year", display_label: "Model year", type: "number" },
      ],
      wires: [
        {
          source_kind: "inventory:part",
          action_id: "labels:print",
          trigger_type: "user-invoked",
          template: '#{{asset_id_padded | default: "???"}} {{name}}\n{{manufacturer | default: ""}} {{model_number | default: ""}}',
        },
      ],
    },
  },
  {
    id: "collection-and-maintenance",
    name: "Collection + Maintenance",
    description:
      "A collection of items you maintain or service — cars, bikes, tools, equipment. Tracks each item plus its service notes.",
    use_case: [
      "track my car collection and maintenance",
      "vehicle service log",
      "equipment maintenance",
      "collection with service history",
      "things i own and their upkeep",
    ],
    // A maintained thing (car, bike, tool, equipment) is an ASSET, not stock —
    // its canonical home is `assets` (matching the shipped vehicle-maintenance
    // bundle, which targets assets:asset). See vin-decode.md §9.
    requires: ["assets"],
    kinds: ["assets:asset"],
    manifest: {
      id: "cobblr.user.collection-maintenance",
      version: "0.1.0",
      name: "Collection + Maintenance",
      description:
        "Fields for a maintained collection: make/model/year, identifier, acquired date, last/next service, condition.",
      requires: [{ module: "assets" }],
      field_defs: [
        { entity_kind: "assets:asset", name: "make", display_label: "Make / brand", type: "text" },
        { entity_kind: "assets:asset", name: "model", display_label: "Model", type: "text" },
        { entity_kind: "assets:asset", name: "model_year", display_label: "Year", type: "number" },
        { entity_kind: "assets:asset", name: "identifier", display_label: "Identifier (VIN/serial/plate)", type: "text" },
        { entity_kind: "assets:asset", name: "acquired_at", display_label: "Acquired", type: "date" },
        { entity_kind: "assets:asset", name: "last_service", display_label: "Last service", type: "date" },
        { entity_kind: "assets:asset", name: "next_service", display_label: "Next service due", type: "date" },
        { entity_kind: "assets:asset", name: "condition", display_label: "Condition", type: "text", choices: ["mint", "good", "fair", "needs work", "project"] },
      ],
      wires: [],
    },
  },
  {
    id: "garden-tracker",
    name: "Garden Tracker",
    description: "Track plants — species, planted date, watering schedule, sun exposure.",
    use_case: ["track my plants", "garden", "what i planted and when", "watering schedule"],
    requires: ["assets"],
    kinds: ["assets:asset"],
    manifest: {
      id: "cobblr.user.garden-tracker",
      version: "0.1.0",
      name: "Garden Tracker",
      description: "Plant fields on assets: species, planted date, watering RRULE, sun exposure.",
      requires: [{ module: "assets" }],
      field_defs: [
        { entity_kind: "assets:asset", name: "species", display_label: "Species", type: "text" },
        { entity_kind: "assets:asset", name: "planted_at", display_label: "Planted", type: "date" },
        { entity_kind: "assets:asset", name: "water_rrule", display_label: "Watering schedule (RRULE)", type: "text" },
        { entity_kind: "assets:asset", name: "sun", display_label: "Sun exposure", type: "text", choices: ["full sun", "partial sun", "partial shade", "full shade"] },
      ],
      wires: [],
    },
  },
  {
    id: "lego-collection",
    name: "Lego Collection",
    description: "Track a Lego collection — set ID, theme, year, condition, minifig count, with a shelf-label wire.",
    use_case: ["track my lego", "lego sets", "brick collection", "minifigs"],
    requires: ["inventory", "labels"],
    kinds: ["inventory:part"],
    manifest: {
      id: "cobblr.user.lego-collection",
      version: "0.1.0",
      name: "Lego Collection",
      description: "Lego fields on parts: set_id, year, theme, color, condition, state, minifig count, plus a shelf-label wire.",
      requires: [{ module: "inventory" }, { module: "labels" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "set_id", display_label: "Set ID", type: "text" },
        { entity_kind: "inventory:part", name: "year", display_label: "Release year", type: "number" },
        { entity_kind: "inventory:part", name: "theme", display_label: "Theme", type: "text" },
        { entity_kind: "inventory:part", name: "color", display_label: "Primary color", type: "text" },
        { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", choices: ["sealed", "built", "used", "damaged", "loose"] },
        { entity_kind: "inventory:part", name: "minifig_count", display_label: "Minifig count", type: "number" },
      ],
      wires: [
        {
          source_kind: "inventory:part",
          action_id: "labels:print",
          trigger_type: "user-invoked",
          template: 'LEGO {{theme | default: "misc"}} #{{set_id | default: "---"}} • {{name}} ({{year | default: "???"}})',
        },
      ],
    },
  },
];

export function listTemplates(): Array<Omit<TemplateEntry, "manifest">> {
  return TEMPLATE_CATALOG.map(({ manifest: _manifest, ...rest }) => rest);
}

export function getTemplate(id: string): TemplateEntry | undefined {
  return TEMPLATE_CATALOG.find((t) => t.id === id);
}
