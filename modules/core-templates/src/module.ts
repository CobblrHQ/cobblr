// core-templates — per-workspace entity templates.
//
// Save a set of default values + tags against a target entity kind;
// stamp out new entities pre-filled from that template. Closes the
// "Tier 2: entity templates" item from
// docs/product/homebox-parity-report.md.
//
// Use cases:
//   - Household appliance template: insured=true, lifetime_warranty
//     defaults to false, archived=false, room=null. Stamping out a
//     new appliance starts with the right shape — user only fills
//     name + model + serial.
//   - "New Voron printer" template on machines:machine — family =
//     Voron, state = building, manufacturer = ...
//   - "Lego set acquired" template on inventory:part — pre-set
//     tags = [lego, new-arrival], status = unbuilt.
//
// Stock band. Inert in workspaces that don't define any templates.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-templates",
  version: "0.2.0",
  displayName: "Templates",
  description:
    "Start new things from a template with the usual details already filled in.",
  icon: "copy-plus",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_templates_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  // AI-REACH: no kinds by design. Templates are READ through the shared
  // registry's get_workspace_setup (part: "templates"), which reports what each
  // one creates and prefills, and saved or deleted through the actions below.

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [
      "core-templates.template.created",
      "core-templates.template.updated",
      "core-templates.template.deleted",
      "core-templates.template.instantiated",
    ],
    actions: [
      {
        group: "organise",
        // UI-SCREEN: /configuration/templates
        id: "core-templates:save-template",
        // ADMIN-ONLY: the page's own routes POST and PATCH /templates are owner or admin (templates.ts)
        runBy: "admin",
        examples: ["make a template for PLA spools with colour black and 1 kg", "change the new laptop template to tag it IT"],
        undoable: true,
        label: "Save a template",
        description:
          "Save a template for one kind of record: the field values and tags a new one starts with. Saving under a name that already exists for that kind changes that template. Use the kind's field names for the values.",
        icon: "copy",
        scope: "workspace",
        invokeHandler: "core-templates.save-template",
        userInvokable: true,
        argsSchema: {
          kind: { label: "Which kind of record (e.g. inventory:part, or its name)", type: "text", required: true },
          name: { label: "The template's name", type: "text", required: true },
          values: { label: "The values a new record starts with, by field name", type: "json" },
          tags: { label: "Tags a new record starts with", type: "list" },
          description: { label: "What it is for", type: "text" },
        },
      },
      {
        group: "organise",
        // UI-SCREEN: /configuration/templates
        id: "core-templates:delete-template",
        // ADMIN-ONLY: the page's own route DELETE /templates/:id is owner or admin (templates.ts)
        runBy: "admin",
        examples: ["delete the old PETG template"],
        label: "Delete a template",
        description: "Delete a template by its name. Records already made from it are not touched.",
        icon: "trash-2",
        scope: "workspace",
        invokeHandler: "core-templates.delete-template",
        userInvokable: true,
        argsSchema: {
          template: { label: "Which template (its name)", type: "text", required: true },
          kind: { label: "Which kind of record it is for, when two share a name", type: "text" },
        },
      },
    ],
  },

  subscribes: [],
});
