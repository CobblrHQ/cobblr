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
  version: "0.8.0",
  displayName: "Files",
  description:
    "Keep photos, manuals and other files with the things they belong to.",
  icon: "image",
  band: "foundational",

  // Browse-not-configure: this is a page you VISIT, so it owns a nav entry
  // and one canonical URL rather than living under /configuration.
  nav: {
    label: "Files",
    route: "/files",
    icon: "files",
  },
  // It draws its Files section onto a part's page (contributes.panels), which
  // is declaring that it works on inventory. It is still a place you keep
  // things, not a tool you go to, so the sidebar keeps it with collections.
  operatesOn: ["inventory"],
  navKind: "collection",

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
        // AI-CRUD: no create — file records are born from multipart upload
        // (no JSON create route). Update renames or moves one (its name and
        // folder; the bytes never change), and delete is soft.
        id: "core-files:file",
        updateEndpoint: "/files/{id}",
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
          { name: "metadata", type: "object" },
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

  dependencies: [],

  exposes: {
    events: [
      "core-files.file.uploaded",
      "core-files.file.deleted",
      "core-files.file.restored",
      "core-files.attachment.created",
      "core-files.attachment.deleted",
    ],
    actions: [
      {
        id: "core-files:restore",
        label: "Restore a deleted file",
        description:
          "Brings a file back from Recently deleted, where it was. A deleted file stays there for 30 days before it is removed for good.",
        appliesTo: { kinds: ["core-files:file"] },
        recordOptional: true,
        userInvokable: false,
        examples: ["restore the photo I deleted", "bring back the manual I deleted yesterday"],
        invokeHandler: "core-files.restore",
        argsSchema: {
          file_id: { label: "File", type: "text" },
        },
      },
    ],
  },

  // A part's page is the inventory module's own and cannot draw the web
  // app's Files section, so a part had nowhere to keep a manual, a receipt or a
  // bill of sale, and nowhere to paste one (#4523). The other record pages draw
  // Files themselves.
  contributes: {
    panels: [
      {
        id: "core-files:files",
        surface: "entity-detail-panel" as const,
        target: "inventory:part",
        title: "Files",
      },
    ],
  },

  subscribes: [],

  lifecycle: {
    onBoot: async () => {
      // One-shot heal: server-written copies of a file fold into the file
      // they repeat (see heal-same-bytes.ts for the retirement condition).
      const { registerSameBytesHeal } = await import("./heal-same-bytes.js");
      registerSameBytesHeal();
      // Recently deleted files are purged once their days run out.
      const { registerPurgeSweep, registerRestoreAction } = await import("./purge.js");
      registerPurgeSweep();
      registerRestoreAction();
    },
  },
});
