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
// See docs/design-decisions/core-scan.md.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-scan",
  version: "0.1.0",
  displayName: "Scan",
  description:
    "Scan a barcode or take a photo of a thing; end up with a draft inventory row, pre-filled with the resolved name + brand + catalog photo. One tap to commit.",
  icon: "scan-line",
  band: "stock",

  schema: {
    tablePrefix: "core_scan_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [
      "core-scan.scan.received",
      "core-scan.scan.enriched",
      "core-scan.scan.confirmed",
      "core-scan.scan.discarded",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
