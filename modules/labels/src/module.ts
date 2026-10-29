// Labels — the second Cobblr connector.
//
// Provides QR generation, per-user print queue, batch + print
// history. Labels has no concept of "part" or "location" — it
// operates on any entity that satisfies the platform's "labelable"
// shape (declared via the appliesTo predicate below).

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "labels",
  version: "0.27.3",
  displayName: "Labels",
  description:
    "Make QR labels for your things and shelves, print them, and scan one to open or act on what it names.",
  icon: "tag",
  band: "stock",
  // The Labels row's number: what is waiting to print, on the row itself in
  // every nav, so the queue never needs a second "Labels (2 queued)" row.
  nav: {
    label: "Labels",
    route: "/labels",
    icon: "tag",
    count: { path: "/queue/count", field: "total" },
  },
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
    ],
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
        group: "label",
        id: "labels:print",
        changes: "records",
        runBy: "member",
        examples: ["print a label for this", "sticker it"],
        label: "Print label",
        description:
          "Queue a printable label for this thing or place. For everything in a place ('labels for everything in Bin 7'): list_related on the place once, then invoke this once per record it holds; do not keep listing.",
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
        group: "label",
        // UI-SCREEN: /labels (Codes panel prefix and code-in-QR controls)
        id: "labels:set-code",
        changes: "workspace",
        runBy: "member",
        examples: ["change the code prefix", "stop printing codes on those labels"],
        label: "Change label codes",
        description:
          "Rename a code group's prefix (e.g. p1, p2 for 3D printers), remove a list's code entirely to free that letter, or toggle whether THAT group's code prints inside the QR (per instance, so 3d printers can show it and cnc can hide it). Runs on the workspace, not a record.",
        icon: "hash",
        scope: "workspace",
        invokeHandler: "labels.set-code",
        argsSchema: {
          group_key: { label: "Code group key", type: "text", required: true },
          prefix: { label: "New prefix (letters only)", type: "text", oneOf: "change" },
          remove_code: { label: "Remove this list's code entirely (frees the letter)", type: "boolean", oneOf: "change" },
          code_in_qr: { label: "Draw the code inside the QR for this group", type: "boolean", oneOf: "change" },
        },
      },
      {
        group: "label",
        // UI-SCREEN: /labels/*
        id: "labels:change-queued-label",
        changes: "records",
        runBy: "member",
        undoable: true,
        examples: ["print three of that label instead"],
        label: "Change a queued label",
        description: "Change how many of a queued label to print, or the caption printed on it, before it prints.",
        scope: "workspace",
        invokeHandler: "labels.change-queued-label",
        userInvokable: true,
        argsSchema: {
          label: { label: "Which queued label (its caption; empty: the only one)", type: "text" },
          qty: { label: "How many to print, 1 to 99", type: "number" },
          caption: { label: "The caption printed on it", type: "text" },
        },
      },
      {
        group: "label",
        // UI-SCREEN: /labels/*
        id: "labels:remove-queued-label",
        changes: "records",
        runBy: "member",
        examples: ["drop the drill label from the queue"],
        label: "Remove a queued label",
        description: "Take a label off the print queue before it prints.",
        scope: "workspace",
        invokeHandler: "labels.remove-queued-label",
        userInvokable: true,
        argsSchema: {
          label: { label: "Which queued label (its caption; empty: the only one)", type: "text" },
        },
      },
      {
        group: "label",
        // UI-SCREEN: /labels/*
        id: "labels:save-size",
        changes: "workspace",
        runBy: "member",
        examples: ["add a 2 by 1 inch label size"],
        label: "Save a label size",
        description: "Save a custom label size (label and sheet sizes, margins and gaps, in inches) under a name; saving under a name that exists changes it.",
        scope: "workspace",
        invokeHandler: "labels.save-size",
        userInvokable: true,
        argsSchema: {
          name: { label: "What to call the size", type: "text", required: true },
          label_w: { label: "Label width, inches", type: "number", required: true },
          label_h: { label: "Label height, inches", type: "number", required: true },
          sheet_w: { label: "Sheet width, inches (empty: one label across)", type: "number" },
          sheet_h: { label: "Sheet height, inches", type: "number" },
          margin_top: { label: "Top margin, inches", type: "number" },
          margin_left: { label: "Left margin, inches", type: "number" },
          column_gap: { label: "Gap between columns, inches", type: "number" },
          row_gap: { label: "Gap between rows, inches", type: "number" },
        },
      },
      {
        group: "label",
        // UI-SCREEN: /labels/*
        id: "labels:remove-size",
        changes: "workspace",
        runBy: "member",
        examples: ["remove the old address label size"],
        label: "Remove a label size",
        description: "Remove a custom label size by its name.",
        scope: "workspace",
        invokeHandler: "labels.remove-size",
        userInvokable: true,
        argsSchema: {
          name: { label: "Which size (its name)", type: "text", required: true },
        },
      },
    ],
  },

  subscribes: [],
  lifecycle: {
    onBoot: async () => {
      // What its dashboard tile reads, in the one dashboard request (#6563).
      const { registerLabelsDashboardReads } = await import("./dashboard-reads.js");
      registerLabelsDashboardReads();
      // An auto-print the queue gave up but the printer never got is sent again.
      const { registerAutoflushDispatchSweep } = await import("./api/autoflush.js");
      registerAutoflushDispatchSweep();
    },
  },
});
