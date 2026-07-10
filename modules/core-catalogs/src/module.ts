// core-catalogs — reference datasets imported into the workspace.
//
// The user's own entities (parts, machines, assets) can MATCH a row
// in a catalog via core's entity_pairings table with
// relationship_kind='matches'. Once matched, the catalog's payload
// (name, photo, dimensions, year, set membership, etc.) is available
// everywhere the user's entity is rendered.
//
// Stock band — workspaces that don't import external datasets don't
// pay the cost. Specific data sources (Rebrickable, McMaster,
// OpenLibrary, USDA, Discogs) become small modules that register a
// puller with the platform contract (v0.3, deferred). v0.1 ships
// only CSV upload as the import path — no module code required for
// static datasets.
//
// See docs/modules/catalogs.md for the full design.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-catalogs",
  version: "0.2.0",
  displayName: "Catalogs",
  description:
    "Import reference datasets (parts catalogs, ingredient databases, etc.) and MATCH your own entities to entries inside them. v0.1 supports CSV upload; live-API pullers + auto-match deferred.",
  icon: "library",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_catalogs_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  provides: {
    entityKinds: [
      {
        id: "core-catalogs:catalog",
        createEndpoint: "/catalogs",
        updateEndpoint: "/catalogs/{id}",
        deleteEndpoint: "/catalogs/{id}",
        displayName: "Catalog",
        displayNamePlural: "Catalogs",
        icon: "library",
        fields: [
          { name: "name", type: "text", role: "title" },
          { name: "description", type: "text", role: "summary" },
          { name: "source_url", type: "url" },
          { name: "puller_id", type: "text" },
          { name: "entry_count", type: "number", role: "quantity" },
        ],
        getEndpoint: "/catalogs/{id}",
        detailRoute: "/configuration/catalogs/{id}",
        profile: "digital-record",
        exposableFields: [
          "name",
          "description",
          "source_url",
          "puller_id",
          "entry_count",
        ],
      },
      {
        // AI-CRUD: none — entries are import-owned (the catalog importer
        // writes them); ad-hoc creates would bypass provenance.
        id: "core-catalogs:entry",
        displayName: "Catalog entry",
        displayNamePlural: "Catalog entries",
        icon: "book-open",
        fields: [
          // `name` is the conventional display title — payload->>'name'
          // by default; catalogs override via schema.title_column at
          // creation time. The resolver applies the override at
          // lookup time.
          { name: "name", type: "text", role: "title" },
          { name: "description", type: "text", role: "summary" },
          { name: "image_url", type: "image-path", role: "image" },
          { name: "external_id", type: "text", role: "subtitle" },
          { name: "catalog_id", type: "text" },
        ],
        profile: "digital-record",
        exposableFields: [
          "name",
          "description",
          "image_url",
          "external_id",
          "catalog_id",
        ],
      },
    ],
    // Pillar B — the platform action that matches a user entity to
    // a catalog entry. The handler creates a pairing with
    // relationship_kind='matches'.
    //
    // (Actions live on `exposes.actions` per the manifest contract.)
  },

  exposes: {
    events: [
      "core-catalogs.catalog.created",
      "core-catalogs.catalog.updated",
      "core-catalogs.catalog.deleted",
      "core-catalogs.catalog.synced",
      "core-catalogs.entry.matched",
      "core-catalogs.entry.unmatched",
    ],
    api: [],
    actions: [
      {
        id: "core-catalogs:match-to-catalog",
        label: "Match to catalog",
        description:
          "Link this entity to a row in an imported reference catalog. Opens a picker over installed catalogs; on confirm, writes an entity_pairings row with relationship_kind='matches'.",
        // Default to the kinds where catalog matching is meaningful.
        // Locations / catalogs themselves / bundles / users / org_modules
        // never want this. Workspaces can broaden via the per-org
        // `entity_action_org_overrides.applies_to_override` jsonb if
        // they really need a different kind to be matchable.
        // Each catalog can further declare `schema.bindable_to_kinds`
        // to scope WHICH catalogs the picker offers for a given
        // source kind (e.g. Rebrickable only binds to inventory:part).
        appliesTo: {
          kinds: ["inventory:part", "assets:asset", "machines:machine"],
        },
        // No server-side handler — the click navigates to a picker
        // page that creates the pairing via /pairings on confirm.
        // (v0.2 may add an invokeHandler so wires can auto-match
        // when an entity is created, but that needs a matchCandidates
        // function from a puller; CSV catalogs have no auto-match
        // heuristic so it'd misfire.)
        invokeRoute:
          "/configuration/catalogs/match?source_kind={entityKind}&source_id={entityId}",
      },
    ],
  },

  subscribes: [],
});
