// Labels — the second Cobblr connector.
//
// Provides QR generation, per-user print queue, batch + print
// history. Labels has no concept of "part" or "location" — it
// operates on any entity that satisfies the platform's "labelable"
// shape (declared via the appliesTo predicate below).

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "labels",
  version: "0.25.0",
  displayName: "Labels",
  description:
    "QR codes, label templates, per-user print queue, scan-to-navigate/scan-to-action tokens. Polymorphic — any module's entity can have a label.",
  icon: "tag",
  band: "stock",
  // An operator, not a trackable kind: labels are printed FOR things
  // (parts, assets, machines) — nobody "tracks labels". Keeps it out of
  // the funnel's "track a kind of thing" column; recipes offer label
  // printing as an opt-in feature instead.
  operatesOn: ["inventory", "assets", "machines"],

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
      // The QR scan-token half (merged in from the former core-labels-qr
      // module, 0.6.0): mint/revoke printed-code tokens; scans resolve via
      // the public /qr/:token route and fire the scan.* events.
      "labels.qr.token.created",
      "labels.qr.token.revoked",
      "labels.qr.scan.received",
      "labels.qr.scan.action_invoked",
    ],
    api: ["queue", "listQueue", "clearQueue", "printBatch"],
    // ──────────── Live box — the accumulate-then-print policy ─────────────
    // Applicable only when the workspace has a printer connected; a per-user
    // switch (the auto-flush policy) with a "configure" deep-link. See
    // docs/design-decisions/live-controls.md.
    live: [
      {
        id: "labels.auto-print",
        label: "Labels print automatically",
        icon: "printer",
        requires: "printer.connected",
        scope: "user",
        control: "switch-detail",
        endpoint: "/modules/labels/autoflush",
        detail: "/labels",
        order: 20,
      },
    ],
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
        // (see docs/architecture/traits.md §Example).
        appliesTo: { traits: ["physical"] },
        invokeHandler: "labels.queue-from-entity",
      },
      {
        // A WORKSPACE-scoped action: it configures the workspace's label codes,
        // it doesn't run on a record. This is what makes "give my 3D printers a
        // 'p' prefix" reachable by Cobb / the MCP through the generic
        // invoke_action rail — no bespoke per-op AI tool. A rename on a printed
        // (frozen) group keeps the printed stickers valid and only changes new
        // labels (keep_existing), so it's always safe to run.
        id: "labels:set-code",
        label: "Change label codes",
        description:
          "Rename a code group's prefix (e.g. p1, p2 for 3D printers), remove a list's code entirely to free that letter, or toggle whether THAT group's code prints inside the QR (per instance, so 3d printers can show it and cnc can hide it). Runs on the workspace, not a record.",
        icon: "hash",
        scope: "workspace",
        invokeHandler: "labels.set-code",
        argsSchema: {
          group_key: { label: "Code group key", type: "text" },
          prefix: { label: "New prefix (letters only)", type: "text" },
          remove_code: { label: "Remove this list's code entirely (frees the letter)", type: "boolean" },
          code_in_qr: { label: "Draw the code inside the QR for this group", type: "boolean" },
        },
      },
    ],
  },

  subscribes: [],
});
