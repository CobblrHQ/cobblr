// core-tags — polymorphic labels across any entity in any module.
// Foundational because tagging is table-stakes infrastructure: every
// other module that ships an entity kind eventually wants "let me
// label this thing." The old api/src/platform/tags.ts had the same
// idea but no consumer code — promoted here with REST routes so
// it's actually usable.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-tags",
  version: "0.2.0",
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
        createEndpoint: "/tags",
        updateEndpoint: "/tags/{id}",
        deleteEndpoint: "/tags/{id}",
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
    actions: [
      // Wire/AI-invokable tagging — the same attach/detach the /attachments
      // routes do, reachable through the actions surface (Ask Cobb + MCP hit
      // these via invoke_action; wires can label records on events). NOT
      // userInvokable: the person-facing surface is the tag picker on the
      // record's detail page, not an every-kind button.
      {
        id: "core-tags:tag-record",
        label: "Tag record",
        description:
          "Attach a tag (by name) to the targeted record — the tag is created on the fly if it doesn't exist yet. Idempotent: tagging an already-tagged record is a no-op. Args: { tag_name }.",
        // DELIBERATELY universal: labels are the point of this module —
        // ANY record of ANY kind can be tagged (the assignments table is
        // polymorphic by design). No trait narrows that honestly.
        appliesTo: { any: true },
        invokeHandler: "core-tags.tag-record",
        userInvokable: false,
        argsSchema: {
          tag_name: { label: "Tag name", type: "text" },
        },
      },
      {
        id: "core-tags:untag-record",
        label: "Remove tag from record",
        description:
          "Detach a tag (by name) from the targeted record. A no-op if the record isn't tagged with it. Args: { tag_name }.",
        // DELIBERATELY universal: mirrors tag-record — anything taggable
        // must be untaggable.
        appliesTo: { any: true },
        invokeHandler: "core-tags.untag-record",
        userInvokable: false,
        argsSchema: {
          tag_name: { label: "Tag name", type: "text" },
        },
      },
    ],
  },

  subscribes: [],
});
