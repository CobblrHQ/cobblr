// core-scan — barcode + photo identification, generalized.
//
// "Point your phone at a thing, end up with a row." Two ingest
// paths (barcode fast path, photo AI path) converge on one inbox.
// User triages from desktop; one tap commits into the chosen
// entity kind (inventory:part, assets:asset, machines:machine,
// future kinds — target picked at confirm time).
//
// v0.1: barcode-only fast path with Open Products Facts + upcitemdb
// inline lookups (both keyless free-tier). Photo AI path, web-
// search fallback, receipt OCR, large-batch bulk confirm: v0.2.
//
// See docs/modules/core-scan.md.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-scan",
  version: "0.58.4",
  displayName: "Scan",
  description:
    "Scan a barcode or snap a photo, and get the thing named and ready to file in one tap.",
  icon: "scan-line",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  // A throttled barcode look-up is retried by a core-queue worker, so the
  // "trying again" a card shows is backed by something that outlives the
  // browser tab that started the scan. Same dynamic-import shape digifab uses
  // for its own queue workers.
  lifecycle: {
    onBoot: async () => {
      const { registerScanTidyFinders } = await import("./services/tidy-finders.js");
      registerScanTidyFinders();
      const { registerRetryLookupWorker } = await import("./services/retry-worker.js");
      registerRetryLookupWorker();
      // A document that waited for the document model while every one was busy.
      const { registerDocumentReadWorker } = await import("./services/document-read-worker.js");
      registerDocumentReadWorker();
      // A photo the hosted identify queued while every engine it has was
      // busy or out: collected later and landed as if answered at once.
      const { registerHostedIdentifyJobWorker } = await import("./services/hosted-identify-job.js");
      registerHostedIdentifyJobWorker();
      // How a thing must be kept vs where it just got put. Subscribes to
      // core-placement.placed; costs nothing until something moves.
      const { registerStorageFitCheck } = await import("./services/storage-fit.js");
      registerStorageFitCheck();
      // Boot-time heal: a row filed before the commit recorded where it went
      // gets that record - see the DONE WHEN in heal-filed-into.ts for when
      // this call goes.
      const { registerFiledIntoHeal } = await import("./heal-filed-into.js");
      registerFiledIntoHeal();
      // Boot-time heal: a draft identified before #3613 reads its unsupported
      // identifiers as unconfirmed - see the DONE WHEN in
      // heal-unconfirmed-identifiers.ts for when this call goes.
      const { registerUnconfirmedIdentifiersHeal } = await import("./heal-unconfirmed-identifiers.js");
      registerUnconfirmedIdentifiersHeal();
      // Boot-time heal: a record filed from a scan before the commit wrote
      // the barcode and the name's facts gets them, and so does its type -
      // see the DONE WHEN in heal-scanned-type-facts.ts for when this goes.
      const { registerScannedTypeFactsHeal } = await import("./heal-scanned-type-facts.js");
      registerScannedTypeFactsHeal();
      // Boot-time heal: a stored catalog picture is measured, and set aside
      // when it shows another colour than its item states - see the DONE
      // WHEN in heal-picture-colour.ts for when this call goes.
      const { registerPictureColourHeal } = await import("./heal-picture-colour.js");
      registerPictureColourHeal();
      const { registerUnsavedCatalogChoicesHeal } = await import("./heal-unsaved-catalog-choices.js");
      registerUnsavedCatalogChoicesHeal();
      // A read the AI could not do for a passing reason (busy, a limit) is
      // asked again when it answers (hint-without-ai.ts).
      const { registerAiRerunSweep } = await import("./services/hint-without-ai.js");
      registerAiRerunSweep();
      // A record made or renamed without a picture, by any door, is offered
      // one (services/record-photos.ts).
      const { subscribeRecordPhotos, registerRecordPhotoSweep } = await import("./services/record-photos.js");
      subscribeRecordPhotos();
      registerRecordPhotoSweep();
      // Boot-time heal: a stock agency's watermarked preview is set aside and
      // the next picture looked for - see the DONE WHEN in
      // heal-stock-pictures.ts for when this call goes.
      const { registerStockPictureHeal } = await import("./heal-stock-pictures.js");
      registerStockPictureHeal();
      // Boot-time heal: every pending photo row gets its picture's hash, so a
      // pair of the same picture is offered as one - see the DONE WHEN in
      // heal-picture-hashes.ts for when this call goes.
      const { registerPictureHashHeal } = await import("./heal-picture-hashes.js");
      registerPictureHashHeal();
    },
  },

  // Browse-not-configure: this is a page you VISIT, so it owns a nav entry
  // and one canonical URL rather than living under /configuration.
  nav: {
    label: "Scan Inbox",
    route: "/scan",
    icon: "scan-line",
    // The other row every workspace has: what the scanner captured, waiting
    // to be filed. Used daily by anyone who scans.
    primary: true,
    // How many are waiting, on the row itself. The same count the inbox
    // header shows (status = pending), from the one-SQL stats endpoint the
    // dashboard card already reads.
    count: { path: "/inbox/stats", field: "pending" },
  },

  // The scan/camera button earns a permanent icon slot in the navbar's
  // right cluster — it's the most-used action for camera-first intake
  // (camera-first intake hits it constantly). Shows only while core-scan is on.
  // One tap → the full-screen scanner with a LIVE camera;
  // the inbox stays reachable via the "Scan" nav entry.
  headerAction: {
    icon: "camera", // opens a live viewfinder
    label: "Scan",
    route: "/scan/camera",
  },

  schema: {
    tablePrefix: "core_scan_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  provides: {
    entityKinds: [],
  },

  exposes: {
    // The KINDS of workspace notification this module sends, so the
    // workspace can say who each kind is for (Configuration > Who gets told).
    notifications: [
      { eventType: "core-scan.return.update", label: "A return moved (no order matched)", description: "A store's return notice that could not be tied to an order: started, dropped off, received, or refunded." },
      { eventType: "core-scan.parcel.update", label: "Parcel updates", description: "A tracked delivery moved, or arrived." },
      { eventType: "core-scan.storage.mismatch", label: "Stored in the wrong place", description: "Something that must be kept cold was put somewhere warm." },
    ],
    events: [
      "core-scan.scan.received",
      // Stock moved: a purchase filed, a quantity added or used. Announced so
      // whoever keeps a consumption ledger can listen; core-scan does not
      // know who that is.
      "core-scan.stock.observed",
      // A shipping notification said where an order's parcel is: shipped,
      // out for delivery, delivered. Announced so the module that owns the
      // order can ask its own question now rather than at its next walk.
      "core-scan.shipment.observed",
      "core-scan.scan.enriched",
      "core-scan.scan.confirmed",
      "core-scan.scan.unconfirmed",
      "core-scan.scan.discarded",
      "core-scan.organize.applied",
      "core-scan.putaway.session-started",
      "core-scan.putaway.item-placed",
      // Something was put somewhere that contradicts how it must be kept -
      // frozen food in a cupboard. A FACT, not a prediction, which is why it is
      // worth telling someone about at the moment it happens.
      "core-scan.storage.mismatch",
      "core-scan.putaway.session-ended",
    ],
    // ──────────── Live box — scan-drive session mode ────────────
    // Applicable only when a bridge scanner is connected (a scan from elsewhere
    // can drive THIS screen). Tab-scoped (the follower is this browser tab); the
    // Open/Print segment picks navigate vs print disposition (slice 4). See
    // docs/design-decisions/live-controls.md + scan-drives-screen.md.
    live: [
      {
        id: "core-scan.scan-drive",
        label: "Scans drive this screen",
        icon: "scan-line",
        requires: "scanner.bridge",
        scope: "tab",
        control: "switch-segment",
        segment: [
          { value: "navigate", label: "Open" },
          { value: "print", label: "Print" },
        ],
        detail: "/scan",
        order: 10,
      },
    ],
    actions: [
      {
        id: "core-scan:confirm-receipt-arrival",
        examples: ["I have the parcel", "the package is here", "got the delivery in hand"],
        label: "Confirm a parcel is in hand",
        description:
          "Record that a tracked receipt's parcel physically arrived: stamps the receipt confirmed, which ends the carrier watch for it. The receipt itself still gets filed in the inbox. Idempotent. Args: { batch_id }.",
        invokeHandler: "core-scan.confirm-receipt-arrival",
        // It acts on a receipt SESSION, named by batch_id, and a receipt session
        // is not an entity kind. Declared with no appliesTo it defaulted to
        // universal and became a button on every record in every workspace,
        // where pressing it could only ever answer "no receipt in scope"
        // (audit, 2026-09-08). Workspace scope is the honest shape: reachable
        // by the assistant and by the notification button that carries the id,
        // never offered on a record.
        scope: "workspace" as const,
        argsSchema: {
          batch_id: { label: "Which receipt session", type: "text" },
        },
        userInvokable: true,
      },
      {
        // NO-PHRASING: the scan pipeline's own step; a person asking to identify something means core-scan:identify
        id: "core-scan:identify-photo",
        label: "Identify a scanned photo",
        description:
          "Vision-identify a photo-only inbox row (no barcode) into a draft. Wire-fired on scan.received; no-ops for barcode/url scans.",
        // DELIBERATELY universal: fires on scan events, not entity sources —
        // the inbox row in the payload is the subject. Kind/trait scoping
        // would be false precision (see /actions provenance).
        appliesTo: { any: true },
        invokeHandler: "core-scan.identify-photo",
        // Wire-only — the autonomous-sort binding fires it, not a button.
        wireOnly: true,
        userInvokable: false,
      },
      {
        // NO-PHRASING: an internal ranking step between enrichment and the draft; there is no sentence for it
        id: "core-scan:rank-catalog-photo",
        label: "Pick the best catalog photo",
        description:
          "Vision-rank an enriched row's candidate photos and set the cleanest catalog shot (product alone, correct colour, no people). Wire-fired on scan.enriched; no-ops unless the workspace turned always-on ranking on, and never over a photo the user picked.",
        // DELIBERATELY universal: fires on scan events, not entity sources —
        // the inbox row in the payload is the subject (same as identify-photo).
        appliesTo: { any: true },
        invokeHandler: "core-scan.rank-catalog-photo",
        // Wire-only. The per-item equivalent is the ✨ Pick best button, which
        // goes through POST /inbox/:id/rank-photo-ai (a press IS the consent).
        wireOnly: true,
        userInvokable: false,
      },
      {
        // UI-SCREEN: /scan
        id: "core-scan:attach-paperwork",
        examples: ["attach this bill of sale to the Civic", "this receipt is for my mower, put it on it"],
        label: "Attach paperwork to a record",
        description:
          "Put a document (a bill of sale, a receipt, an invoice: a stored file) on a record the workspace already has. The file is kept on the record, the purchase it shows is recorded with every line and its line claimed for the record, and the record's EMPTY fields are filled from it by meaning: Paid, Purchased at, Bought from, and for a vehicle its VIN, make, model, year and mileage. A field that already holds a different value is never written; it comes back in `conflicts` to ask about. A document with several things on it, or none, is kept as a file only. Args: { file_id, kind, id } (the record's kind and id).",
        scope: "workspace" as const,
        argsSchema: {
          file_id: { label: "The document's stored file", type: "text", required: true },
          kind: { label: "The record's kind", type: "text", required: true },
          id: { label: "The record's id", type: "text", required: true },
        },
        invokeHandler: "core-scan.attach-paperwork",
        userInvokable: false,
      },
      {
        // NO-PHRASING: a table's own wire runs it when a record is made or changed; the person's door is the record's identifier box
        id: "core-scan:fill-known",
        label: "Fill what the record already says",
        description:
          "Fill a record's EMPTY fields from what it already carries: its identifier (a VIN, read by the decoder) and its own name (\"Yamaha YZF-R3, Blue\" with Make Yamaha says the model). Never touches a field that holds a value. Wire-fired by a bundle on its table's created and updated events. Undoable.",
        // DELIBERATELY universal: a bundle's wire names the table; which fields
        // it can fill comes from the fields' declared decode roles, never a kind.
        appliesTo: { any: true },
        invokeHandler: "core-scan.fill-known",
        wireOnly: true,
        userInvokable: false,
        undoable: true,
      },
      {
        // NO-PHRASING: the undo step of fill-known, handed back on its card
        // DELIBERATELY universal: the undo of fill-known, which runs on whatever record that did.
        id: "core-scan:unfill-known",
        label: "Empty what was filled",
        description:
          "Undo of fill-known: empty the fields it filled, only where each still holds the value it put there. Args: { filled }.",
        appliesTo: { any: true },
        invokeHandler: "core-scan.unfill-known",
        userInvokable: false,
        internal: true,
      },
      {
        id: "core-scan:fill-fields-from-receipts",
        examples: [
          "fill in where my things came from",
          "backfill provenance from my receipts",
        ],
        label: "Fill fields from past receipts",
        description:
          "Move what already-scanned receipts established (the date printed on them, the shop, a reconciled price) into the fields this workspace has NOW - for items filed before those fields existed. Never overwrites a value that is already there; only fills empty ones. Args: { dry_run? }.",
        // A WORKSPACE sweep, not a record operation: it moves what receipts
        // established into whichever fields the workspace has now, across every
        // kind at once. Declared entity-scoped it rendered a button on every
        // record in the app - on a location called "Rack 1" it sat in the
        // header offering to do something that has nothing to do with Rack 1
        // (2026-08-23). Workspace scope keeps it on the same invoke_action
        // rail, so Cobb and MCP still reach it; it just stops pretending to be
        // about whatever record you are looking at.
        scope: "workspace" as const,
        argsSchema: {
          dry_run: {
            label: "Report what would be filled without writing anything",
            type: "boolean",
          },
        },
        invokeHandler: "core-scan.fill-fields-from-receipts",
        userInvokable: true,
      },
      {
        id: "core-scan:identify",
        examples: ["what is this thing", "identify this for me"],
        label: "Identify a thing",
        description:
          "PURE 'what is this?': from a photo and/or captured measurements + observations. Returns the suggestion ({ name, brand, category, confidence }); writes nothing. A capture app calls it and decides whether to use the suggestion or keep its own name. User-invokable. Args: { image_file_id?, measurements?, observations? }.",
        // Args-driven: a capture app supplies the photo/measurements, and the
        // handler reads no record at all. As an entity action it rendered on
        // every record and, pressed from a detail page with no args, answered
        // `{ identified: false, reason: "nothing to identify" }` - a button
        // that could only ever do nothing.
        scope: "workspace" as const,
        invokeHandler: "core-scan.identify",
        userInvokable: true,
      },
    ],
  },

  // Informational — the reactions run through the seeded wires below.
  subscribes: [
    // Checks a moved record against its storage requirement.
    "core-placement.placed",
    "core-scan.scan.received",
    "core-scan.scan.enriched",
  ],

  // The autonomous photo-sort ships as a default WIRE, not a cron baked
  // into the module: every scan.received fires identify-photo, which
  // vision-identifies photo-only rows detached. Editable / disable-able
  // on /wires like any wire — Pillar-C consistency over hardcoded
  // automation. source_kind "core-scan:item" → the engine reads the
  // row id from payload.itemId; target defaults to "self".
  contributes: {
    wires: [
      {
        source_kind: "core-scan:item",
        action_id: "core-scan:identify-photo",
        trigger_type: "event",
        trigger_event: "core-scan.scan.received",
      },
      // The always-on catalog-photo pick (Phase F). Fires on scan.ENRICHED —
      // the point both intake paths reach once a name exists, which is what the
      // image search needs (scan.received is too early for a photo item: no name
      // yet, so nothing to search for). Seeded ENABLED because a manifest wire
      // cannot express "disabled" — the SPEND gate is the workspace's opt-in
      // setting (core_scan_photo_rank_config, off unless turned on), so an
      // enabled wire costs nothing until someone asks for it. A workspace can
      // still disable the wire itself on /wires; that survives boot
      // (backfillDefaultBindings only INSERTS what is missing, and its probe
      // ignores `enabled`, so it never re-enables what you turned off).
      {
        source_kind: "core-scan:item",
        action_id: "core-scan:rank-catalog-photo",
        trigger_type: "event",
        trigger_event: "core-scan.scan.enriched",
      },
    ],
    // A record made without a picture is offered one (#3818).
    panels: [
      {
        // DELIBERATELY universal: any record whose kind has a picture can be
        // offered one, including on module-owned pages; it says nothing on a
        // record with a picture or no suggestion.
        id: "core-scan:suggested-photo",
        surface: "entity-detail-panel" as const,
        target: "*",
        title: "Suggested photo",
      },
    ],
  },
});
