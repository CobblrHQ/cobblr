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
import { readdirSync } from "node:fs";
import type { ModuleActionInput } from "@cobblr/platform-contract";

// The module's actions, one file each under ./actions/ (#7382), found here in
// name order (the NNN prefix keeps the order they were written in). Adding an
// action is a new file; nothing shared changes.
const ACTIONS_DIR = new URL("./actions/", import.meta.url);
const actions: ModuleActionInput[] = await Promise.all(
  readdirSync(ACTIONS_DIR)
    .filter((f) => /\.(js|ts)$/.test(f) && !/\.d\.ts$|\.test\./.test(f))
    .sort()
    .map(async (f) => ((await import(new URL(f, ACTIONS_DIR).href)) as { default: ModuleActionInput }).default),
);


export default defineModule({
  name: "core-scan",
  version: "0.77.13",
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
      // What it shows on the dashboard, read in its one request (#6563).
      const { registerScanDashboardReads } = await import("./dashboard-reads.js");
      registerScanDashboardReads();
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
      // Boot-time heal: an emailed session read before #5722 is named for its
      // shop and numbered from the email it kept - see the DONE WHEN in
      // heal-forwarded-session-identity.ts for when this call goes.
      const { registerForwardedSessionIdentityHeal } = await import("./heal-forwarded-session-identity.js");
      registerForwardedSessionIdentityHeal();
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
      // Boot-time heal: an emailed order's lines read with no store get the
      // store its body names, and their store pass (DONE WHEN in
      // heal-forwarded-store-host.ts).
      const { registerForwardedStoreHostHeal } = await import("./heal-forwarded-store-host.js");
      registerForwardedStoreHostHeal();
      // Boot-time heal: a pack's part split before #6456 gets its own colour
      // and name (DONE WHEN in heal-split-part-values.ts).
      const { registerSplitPartValuesHeal } = await import("./heal-split-part-values.js");
      registerSplitPartValuesHeal();
      const { registerUnsavedCatalogChoicesHeal } = await import("./heal-unsaved-catalog-choices.js");
      registerUnsavedCatalogChoicesHeal();
      const { registerPhotoSuggestionFilesHeal } = await import("./heal-photo-suggestion-files.js");
      registerPhotoSuggestionFilesHeal();
      const { registerUnfoundedPlaceSuggestionsHeal } = await import("./heal-unfounded-place-suggestions.js");
      registerUnfoundedPlaceSuggestionsHeal();
      // What a waiting row knows about its model reaches the model's other
      // waiting rows (heal-model-facts.ts, PERMANENT RECONCILE, #6013).
      const { registerModelFactsHeal } = await import("./heal-model-facts.js");
      registerModelFactsHeal();
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
      // Boot-time heal: a pending row with a shop's own barcode that a global
      // catalog named is re-judged from its photo - see the DONE WHEN in
      // heal-store-code-names.ts for when this call goes (#6100).
      const { registerStoreCodeNameHeal } = await import("./heal-store-code-names.js");
      registerStoreCodeNameHeal();
      // Boot-time heal: a pending row a photo read named with a run-on
      // description is set back to nameless - see the DONE WHEN in
      // heal-prose-names.ts for when this call goes (#6100).
      const { registerProseNameHeal } = await import("./heal-prose-names.js");
      registerProseNameHeal();
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
      "core-scan.scan.broken",
      "core-scan.scan.arrived-damaged",
      "core-scan.scan.discarded",
      "core-scan.organize.applied",
      "core-scan.putaway.session-started",
      "core-scan.putaway.item-placed",
      "core-scan.putaway.destination-selected",
      "core-scan.label.scanned",
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
    actions: actions,
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
