// Labels — the second Cobblr connector.
//
// Provides QR generation, per-user print queue, batch + print
// history. Labels has no concept of "part" or "location" — it
// operates on any entity that satisfies the platform's "labelable"
// shape (declared via the appliesTo predicate below).

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "labels",
  version: "0.1.0",
  displayName: "Labels",
  description:
    "QR codes, label templates, per-user print queue. Polymorphic — any module's entity can have a label.",
  icon: "tag",
  band: "stock",

  schema: {
    tablePrefix: "labels_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [
    { name: "queue_label", description: "Add a label for an entity to the print queue" },
    { name: "print_queue", description: "Snapshot the current queue into a printed batch" },
  ],

  dependencies: [],

  exposes: {
    events: [
      "labels.print.queued",
      "labels.print.completed",
    ],
    api: ["queue", "listQueue", "clearQueue", "printBatch"],
    // ──────────────── Pillar B — labels' actions ──────────────────
    actions: [
      {
        id: "labels:print",
        label: "Print label",
        description: "Queue a printable label for this entity",
        icon: "tag",
        // Default: only physical entities — you can attach a QR
        // sticker to a part, a machine, an asset, a location. You
        // can't attach one to a task or an order. Users can broaden
        // this per-org via the wires-UI Containment-axis override
        // (see docs/design-decisions/traits.md §Example).
        appliesTo: { traits: ["physical"] },
        invokeHandler: "labels.queue-from-entity",
      },
    ],
  },

  subscribes: [],
});
