// knowledge — a Knowledge Base: rich Markdown entries (notes, references, SOPs,
// prompts, papers) with custom fields, tags, attachments, and the four views.
// A domain (a noun you manage): bare name, opt-in, its own nav entry + table.
// The entry BODY is a `richtext` field (Markdown editor), the field type shipped
// in KB phase 1. Categorise inside one vault via the `kind` choice + tags; the
// `pinned` flag surfaces an entry in the Quick Access drawer (a later phase).
//
// Spec: docs/design-decisions/knowledge-base.md. This is phase 2 (the domain);
// instanceability is `single` for now — one vault, categorised inside — with
// multi-instance (several named vaults) a documented fast-follow.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "knowledge",
  version: "0.3.0",
  displayName: "Knowledge Base",
  description:
    "A knowledge base: rich Markdown entries (notes, references, SOPs, prompts, papers) with custom fields, tags, and attachments. Categorise inside one vault; pin entries for quick access.",
  icon: "book-open",
  band: "stock",
  autoEnable: false, // opt-in — "do you keep a knowledge base?"

  schema: {
    tablePrefix: "knowledge_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  provides: {
    entityKinds: [
      {
        id: "knowledge:entry",
        displayName: "Entry",
        displayNamePlural: "Entries",
        icon: "book-open",
        profile: "digital-record",
        // These are the module's NATIVE columns (a manifest entity-kind field is
        // a simple typed column — no choices/renderer/richtext; those belong to
        // USER field-defs). The `body` is a plain text column that stores a
        // Markdown string; the knowledge UI renders + edits it with the shared
        // Markdown editor (KB phase 1). `kind`'s category choices live in the UI.
        fields: [
          { name: "title", type: "text", role: "title", required: true },
          { name: "body", type: "text" }, // Markdown string — rendered by the UI
          { name: "kind", type: "text", role: "subtitle" }, // in-vault category
          { name: "pinned", type: "boolean" }, // surfaced in Quick Access (later)
          { name: "code", type: "text" }, // owned code → barcode renderer (later)
          { name: "metadata", type: "object" },
        ],
        exposableFields: ["title", "body", "kind", "pinned", "code"],
        detailRoute: "/knowledge/{id}",
        getEndpoint: "/entries/{id}",
        createEndpoint: "/entries",
        updateEndpoint: "/entries/{id}",
        deleteEndpoint: "/entries/{id}",
      },
    ],
  },

  exposes: {
    events: ["knowledge.entry.created", "knowledge.entry.updated", "knowledge.entry.deleted"],
    api: [],
    actions: [],
  },

  subscribes: [],
});
