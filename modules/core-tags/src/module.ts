// core-tags — polymorphic labels across any entity in any module.
// Foundational because tagging is table-stakes infrastructure: every
// other module that ships an entity kind eventually wants "let me
// label this thing." The old api/src/platform/tags.ts had the same
// idea but no consumer code — promoted here with REST routes so
// it's actually usable.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-tags",
  version: "0.1.0",
  displayName: "Tags",
  description:
    "Cross-module polymorphic labels. Attach the same tag to a part, a task, a printer — they all show up under that tag.",
  icon: "tag",
  band: "foundational",

  schema: {
    tablePrefix: "core_tags_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  // ──────────────── Pillar A — entity kinds we provide ─────────────
  provides: {
    entityKinds: [
      {
        id: "core-tags:tag",
        displayName: "Tag",
        displayNamePlural: "Tags",
        icon: "tag",
        // A label users define and reuse. Digital, unique by name,
        // long-lived — `digital-record` is the closest preset.
        profile: "digital-record",
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "color", type: "text" },
        ],
        exposableFields: ["name", "color"],
        detailRoute: "/tags/{id}",
      },
    ],
  },

  intents: [
    { name: "create_tag", description: "Define a new tag" },
    { name: "attach_tag", description: "Apply a tag to any entity" },
  ],

  dependencies: [],

  exposes: {
    events: [
      "core-tags.tag.created",
      "core-tags.tag.deleted",
      "core-tags.assignment.created",
      "core-tags.assignment.deleted",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
