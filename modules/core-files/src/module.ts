// core-files — foundational file storage + image variants.
//
// Every Cobblr app eventually wants to attach a photo, a PDF receipt,
// a sample 3MF — without core-files each module would either glue
// together its own bytes-on-disk layout (drift + duplication) or punt
// to "store the URL". This module is the platform's canonical answer:
// upload once, attach polymorphically, retrieve with sensible
// thumbnails.
//
// Band: foundational. Always on for a fresh tenant; can't be disabled
// without breaking attachments other modules already created.
//
// Storage: bytes live on the host filesystem under
//   <COBBLR_FILES_ROOT>/<orgId>/<fileId>/
// — see api/storage.ts. Default root is ./_files (relative to api
// cwd); deployments override with COBBLR_FILES_ROOT.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-files",
  version: "0.2.0",
  displayName: "Files",
  description:
    "File uploads, image variants (thumb + medium), and polymorphic attachments. The platform answer to 'where does this photo live?' so every module doesn't reinvent storage.",
  icon: "image",
  band: "foundational",

  // Browse-not-configure: this is a page you VISIT, so it owns a nav entry
  // and one canonical URL rather than living under /configuration.
  nav: {
    label: "Files",
    route: "/files",
    icon: "files",
  },

  schema: {
    // Convention from sibling modules: prefix is module-name +
    // underscore. Hyphens aren't legal in identifiers so 'core-files'
    // becomes 'core_files_'. Tables: core_files_files (the row per
    // upload), core_files_attachments (polymorphic link).
    tablePrefix: "core_files_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  // ──────────────── Pillar A — entity kinds we provide ─────────────
  provides: {
    entityKinds: [
      {
        // AI-CRUD: no create/update — file records are born from multipart
        // upload (no JSON create route) and their bytes are immutable; delete
        // is the only generic verb.
        id: "core-files:file",
        deleteEndpoint: "/files/{id}",
        displayName: "File",
        displayNamePlural: "Files",
        icon: "image",
        // A stored bytes-on-disk artefact: digital, unique (each
        // upload's a distinct row, even if filenames repeat), durable,
        // persists indefinitely until deleted — `digital-record`
        // maps cleanly.
        profile: "digital-record",
        fields: [
          { name: "filename", type: "text", role: "title", required: true },
          { name: "mime_type", type: "text" },
          { name: "size_bytes", type: "number" },
          { name: "kind", type: "text" },
          { name: "width", type: "number" },
          { name: "height", type: "number" },
          // Path to the canonical-display variant ("medium" for images,
          // "original" for everything else). Modules that want to
          // embed this entity render via this field.
          { name: "image_path", type: "image-path", role: "image" },
        ],
        // Cross-module exposable: enough to render a card (filename
        // + image preview + size). Internal-only: sha256, variants
        // map, owner_user_id — not relevant outside the files module.
        exposableFields: [
          "filename",
          "mime_type",
          "size_bytes",
          "kind",
          "width",
          "height",
          "image_path",
        ],
        detailRoute: "/files/{id}",
      },
    ],
  },

  intents: [
    { name: "upload_file", description: "Upload a new file" },
    { name: "attach_file", description: "Attach an existing file to an entity" },
  ],

  dependencies: [],

  exposes: {
    events: [
      "core-files.file.uploaded",
      "core-files.file.deleted",
      "core-files.attachment.created",
      "core-files.attachment.deleted",
    ],
    api: ["getFileById", "listAttachments"],
    actions: [],
  },

  subscribes: [],
});
