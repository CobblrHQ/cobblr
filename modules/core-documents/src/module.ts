// core-documents: the things a person keeps in other apps (receipts and
// manuals in Paperless-ngx, games in RomM, any library an adapter speaks),
// linked to the records they belong to.
//
// A CAPABILITY, not a domain: it adds no noun you manage and every kind of
// record gets the panel, so `core-` and on for every workspace. It holds no
// item. A library answers the generic library.* Services capabilities, and
// this module matches what it holds to records in the background and shows it.
//
// Spec: docs/modules/core-documents.md

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-documents",
  aliases: ["core-library"],
  maturity: "beta",
  version: "0.2.4",
  displayName: "Libraries",
  description:
    "The things you keep in other apps, like receipts and manuals in Paperless-ngx or games in RomM, matched to the records they belong to and linked where you can open them.",
  icon: "file-text",
  band: "stock",
  // Ambient: the panel stays out of the way until a library is
  // connected, and there is nothing to decide by turning it on.
  autoEnable: true,

  lifecycle: {
    onBoot: async () => {
      const { registerPaperless } = await import("./paperless.js");
      registerPaperless();
      const { registerRomm } = await import("./romm.js");
      registerRomm();
      const { registerMatchSweep, subscribeRecordSaves, subscribeDocumentAdded, registerDocumentsInbound } = await import("./matching.js");
      registerMatchSweep();
      subscribeRecordSaves();
      subscribeDocumentAdded();
      registerDocumentsInbound();
      const { registerCopyCompletion } = await import("./copy-completion.js");
      registerCopyCompletion();
      const { registerLibraryPairingPresentationHeal } = await import("./heal-pairing-presentations.js");
      registerLibraryPairingPresentationHeal();
    },
  },

  schema: {
    tablePrefix: "core_documents_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  exposes: {
    events: ["core-documents.document.added"],
    actions: [
      {
        group: "more",
        id: "core-documents:link-item",
        examples: ["link the warranty PDF to the dishwasher", "link the Zelda ROM to this cartridge"],
        label: "Link from a library",
        description:
          "Link an item from one of the person's libraries (a document in Paperless-ngx, a game in RomM) to this record. Pass `item` (words from its title, e.g. 'warranty'), or `connection_id` and `ref` from library.find. The item itself is not changed.",
        icon: "link",
        // DELIBERATELY universal: a receipt, a manual or a ROM can belong to
        // any kind of thing, the way a tag or a file can.
        appliesTo: { any: true },
        invokeHandler: "core-documents.link-item",
        undoable: true,
        argsSchema: {
          item: { label: "Which item, in words from its title", type: "text" },
          connection_id: { label: "The library's connection id (from library.find)", type: "text" },
          ref: { label: "The item's ref (from library.find)", type: "text" },
        },
        // The person's door is the record's library panel, not a button in
        // the action bar.
        userInvokable: false,
      },
      {
        group: "more",
        id: "core-documents:unlink-item",
        examples: ["that manual is not for this one, unlink it"],
        label: "Unlink a library item",
        description: "Take a linked library item off this record. Pass `connection_id` and `ref` (list_related shows them on the link). The item itself is not touched.",
        icon: "unlink",
        // DELIBERATELY universal: anything that can have an item linked can
        // have it taken off.
        appliesTo: { any: true },
        invokeHandler: "core-documents.unlink-item",
        undoable: true,
        argsSchema: {
          connection_id: { label: "The library's connection id", type: "text", required: true },
          ref: { label: "The item's ref", type: "text", required: true },
        },
        userInvokable: false,
      },
      {
        group: "more",
        id: "core-documents:copy-item",
        examples: ["keep a copy of the manual in Cobblr"],
        label: "Bring a copy into Cobblr",
        description: "Copy a library item's file into Cobblr, attached to this record, so it is in Cobblr's backup too. Only a library that offers library.copy can. Pass `connection_id` and `ref`.",
        icon: "download",
        // DELIBERATELY universal: a file can be attached to any record.
        appliesTo: { any: true },
        invokeHandler: "core-documents.copy-item",
        undoable: false,
        argsSchema: {
          connection_id: { label: "The library's connection id", type: "text", required: true },
          ref: { label: "The item's ref", type: "text", required: true },
        },
        userInvokable: false,
      },
    ],
  },

  // The Documents panel belongs on every record's detail view, the way tags
  // and the discussion do: a module-owned detail page reaches it through the
  // panel seam without naming this module.
  contributes: {
    panels: [
      {
        // DELIBERATELY universal: any kind of thing can have a receipt, a
        // manual or a ROM.
        id: "core-documents:documents",
        surface: "entity-detail-panel" as const,
        target: "*",
        title: "From your libraries",
      },
    ],
  },

  subscribes: ["services.job.done"],
});
