// digifab — Digital Fabrication. Connect to the software that runs your
// machines (FDM Monster, OctoPrint, …), send a file to be made, and track
// the job to completion. Server-to-server over the machine manager's REST
// API — it sends files, it never drives hardware (coordinate-not-control).
// The driver layer (MachineDriver interface + fdm-monster + mock) is in
// ./drivers; this is the connection registry + its HTTP surface.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "digifab",
  version: "0.30.2",
  displayName: "Digital Fabrication",
  description:
    "Send a design to the software that runs your machine (FDM Monster, OctoPrint and others) and follow the job until it is done.",
  icon: "printer",
  band: "stock",
  // Experimental: the machine-manager drivers are still narrow + moving, so it
  // carries an Experimental badge and is skipped on public / trial deploys that
  // set COBBLR_DISABLE_EXPERIMENTAL_MODULES (see the module loader).
  maturity: "experimental",
  // An operator, not a trackable kind: digifab acts ON machines (sends
  // files to their managers) and on the files it sends (Print this on a
  // model file's page). Keeps it out of the funnel's "track a kind of
  // thing" column — what-to-do-funnel.md option (c).
  operatesOn: ["machines", "core-files"],

  schema: {
    tablePrefix: "digifab_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  // Register the auto-poll worker once at boot — a core-queue worker
  // that walks a sent job to its terminal state, re-enqueuing itself
  // until done (no cron). Same dynamic-import shape as `api`.
  lifecycle: {
    onBoot: async () => {
      const { registerPollWorker } = await import("./poll-worker.js");
      registerPollWorker();
      // One-shot heal: detectors onto adapter connections (see
      // heal-detectors-to-connections.ts for the retirement condition).
      const { registerDetectorsToConnectionsHeal } = await import("./heal-detectors-to-connections.js");
      registerDetectorsToConnectionsHeal();
      const { registerAssignWorker } = await import("./assign-worker.js");
      registerAssignWorker();
      // Keeps jobs moving across a restart: revives dead poll/assign chains and
      // returns a job a stopped send left half way.
      const { registerFarmWatchdog } = await import("./farm-watchdog.js");
      registerFarmWatchdog();
      const { registerMakeRecovery } = await import("./make-recovery.js");
      registerMakeRecovery();
      // Background warmer for the printer file cache — a self-perpetuating queue
      // loop that keeps each printer's file list + thumbnails warm in the DB, so
      // the UI reads warm data and the machine is never hit on a modal open.
      const { registerFileWarmer } = await import("./printer-file-cache.js");
      registerFileWarmer();
      // Live Bambu cloud telemetry — holds an MQTT subscription per cloud Bambu
      // account and writes real-time temps/progress into digifab_bambu_status.
      const { startBambuPump } = await import("./bambu-pump.js");
      startBambuPump();
      // AI print-failure watch — samples each printing device's camera, folds a
      // failure score, auto-pauses + alerts when it crosses the threshold.
      const { registerFailureWatcher } = await import("./failure-detect.js");
      registerFailureWatcher();
    },
  },

  dependencies: [],

  provides: {
    entityKinds: [
      {
        // AI-CRUD: no create — jobs are created by the send-to-machine flow
        // (file + machine + driver), not a generic POST.
        id: "digifab:job",
        updateEndpoint: "/jobs/{id}",
        deleteEndpoint: "/jobs/{id}",
        displayName: "Machine job",
        displayNamePlural: "Machine jobs",
        icon: "printer",
        // A unit of work that queues → prints → completes: digital,
        // unique, completable, durable. Registering it lets the wire
        // composer show digifab:job as a source (e.g. the seeded
        // print.confirmed → mark-task-done binding) and lets other
        // modules look a job up via platform.entities.
        profile: "work-item",
        fields: [
          { name: "file_ref", type: "text", role: "title", required: true },
          { name: "status", type: "text" },
          { name: "target_device", type: "text" },
          { name: "progress", type: "number" },
          { name: "remote_job_id", type: "text" },
          { name: "metadata", type: "object" },
        ],
        exposableFields: ["file_ref", "status", "target_device", "progress", "remote_job_id"],
        detailRoute: "/configuration/devices?tab=machines",
      },
      {
        // A Make: one fabrication run, from the request to the outcome, every
        // step kept with the files it made (services.md §13). Created by
        // asking for something to be made, or by bringing a model or G-code;
        // its steps are recorded by whatever does them.
        id: "digifab:make",
        createEndpoint: "/makes",
        updateEndpoint: "/makes/{id}",
        deleteEndpoint: "/makes/{id}",
        displayName: "Make",
        displayNamePlural: "Makes",
        icon: "sparkles",
        profile: "work-item",
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "prompt", type: "text" },
          { name: "start_step", type: "text" },
          { name: "printer_name", type: "text" },
          { name: "material", type: "text" },
          { name: "outcome", type: "text" },
          { name: "metadata", type: "object" },
        ],
        exposableFields: ["name", "prompt", "start_step", "printer_name", "material", "outcome"],
        detailRoute: "/makes/{id}",
      },
    ],
  },

  contributes: {
    // UI presence on the module digifab OPERATES ON (gated by operatesOn —
    // the manifest schema rejects a panel targeting an undeclared module).
    // Components live in web/src/panels/registry.tsx under these ids; the
    // machines pages render them generically, never naming digifab.
    panels: [
      // "Just my 3D printers, live" — the scoped fleet floor as a page tab
      // on every machines collection (3D Printers, Laser Cutters, …).
      { id: "digifab:fleet-tab", surface: "module-page-tab" as const, target: "machines", title: "Fleet" },
      // The per-machine cockpit half: link THIS machine to its manager +
      // live status, inside the machine's own detail modal.
      { id: "digifab:cockpit", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Job manager" },
      // The spools loaded on this printer, one per slot: a print draws its
      // grams from them (loaded-spools.ts).
      { id: "digifab:loaded", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Loaded filament" },
      // What a slicer needs to know about this printer (Services §14.3): its
      // neutral model id, nozzle, build volume, default quality and a preset
      // per filament type. One per machine, read by every slicer.
      { id: "digifab:printing-profile", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Printing profile" },
      // Print this on a model file's own page (Services §14.3): the door to a
      // Make, a printer it fits, a slice, and the one yes.
      { id: "digifab:print-this", surface: "entity-detail-panel" as const, target: "core-files:file", title: "Print this" },
    ],
  },

  exposes: {
    // What the print events carry for the stock wires: partId, delta and
    // reason only when the job named a material.
    eventPayloads: {
      "digifab.print.completed": ["jobId", "connectionId", "linkedMachineId", "linkedTaskId", "partId", "delta", "reason", "sourceKind", "sourceId"],
      "digifab.print.reversed": ["jobId", "linkedMachineId", "prints", "partId", "delta", "reason"],
      "digifab.print.consumed": ["jobId", "partId", "delta", "unit", "once", "slot", "reason", "sourceKind", "sourceId"],
    },
    events: [
      "digifab.connection.created",
      "digifab.connection.tested",
      "digifab.connection.updated",
      "digifab.connection.deleted",
      "digifab.job.sent",
      // A print's grams taken off (or, scrapped, put back on) a spool loaded
      // on its printer: { partId, delta, unit: "g", slot, sourceKind, sourceId }.
      // One per spool, so a multi-material print draws on each.
      "digifab.print.consumed",
      // Fired on send when the job is linked to a build (BoM). Carries
      // { buildId, qty, outputOnGood } so a seeded builds wire consumes the
      // components from inventory. Idempotent (once per job) — the
      // "job-in → subtract inventory → queue the machine" path.
      "digifab.job.build_committed",
      // The plate was judged good: { buildId, qty } is how many builds came out
      // good. The seeded builds wire credits the output part. Parts count as
      // made here, never at send (#4050).
      "digifab.job.build_output",
      // A job's outcome, once per job: { jobId, runId, buildId, outcome:
      // good|scrap, goodQty, scrapQty, source }. What a work order's yield reads.
      "digifab.job.outcome",
      // The reversal twin: a committed build whose job then failed / was
      // cancelled / was scrapped at the bed-clear verdict. Carries the same
      // { buildId, qty } (+ reason) so the seeded builds wire puts the
      // components back and removes the never-made output credit.
      "digifab.job.build_reversed",
      // Print-lifecycle notifications (the "post updates to Discord" flow): a
      // user routes these to a channel at /me/notification-channels.
      // (digifab.connection.synced / print.started / print.progress were
      //  declared but never emitted — removed so the wires UI doesn't offer
      //  dead triggers; re-add with the emit when the poll loop wires them.
      //  Audit 2026-06-26 follow-up.)
      "digifab.print.completed",
      "digifab.print.failed",
      // AI failure watch tripped: the print was auto-paused (or flagged) — routes
      // to the notification channels like the other print.* events.
      "digifab.print.failure_suspected",
      // F-13 — the human's bed-clear verdict. `completed` fires the cheap,
      // reversible effects (filament deduct, usage accrual) immediately; the
      // consequential one (closing the linked task) waits for `confirmed`.
      // `reversed` fires on a "scrapped" verdict to undo the optimistic effects.
      "digifab.print.confirmed",
      // A production run hit its target (all plates verdicted good). Carries
      // { runId, name, targetQty, completedQty, linkedBuildId } — wire it to
      // notifications ("the 250 brackets are done") or downstream stock moves.
      "digifab.run.completed",
      // A Make was started (or run again from one of its steps). Carries
      // { makeId, rerunOf?, fromStep?, source? }.
      "digifab.make.created",
      // A Make's outcome is known, by a person or the bed check. Carries
      // { makeId, outcome: "pass" | "fail", source?: { kind, id } }, so what
      // it was made for (an order line, a work order) can count it made.
      "digifab.make.completed",
      "digifab.print.reversed",
      "digifab.driver.installed",
    ],
    // Who hears that a print is waiting for its one yes (Configuration > Who gets told).
    notifications: [
      { eventType: "digifab.make.ready", label: "A print is ready to start", description: "Print this has sliced a model for a printer; the print waits on its Make for someone to start it." },
    ],
    actions: [
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      {id: "digifab:reflow-profiles", group: "make", label: "Read paste profiles", description: "List saved immutable reflow profiles for this paste jar.", scope: "workspace", invokeHandler: "digifab.reflow-profiles", userInvokable: true, argsSchema: {paste_kind: {label: "Paste collection kind", type: "text", required: true}, paste_id: {label: "Paste jar id", type: "text", required: true}}},
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      {id: "digifab:reflow-profile", group: "make", label: "Read a paste profile", description: "Read one saved paste profile and its manufacturer limits.", scope: "workspace", invokeHandler: "digifab.reflow-profile", userInvokable: true, argsSchema: {profile_id: {label: "Paste profile id", type: "text", required: true}}},
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      {id: "digifab:save-reflow-profile", group: "make", label: "Save a paste reflow profile", description: "Save the four phases and manufacturer limits as a new immutable version for a liquid paste jar.", scope: "workspace", invokeHandler: "digifab.save-reflow-profile", userInvokable: true, argsSchema: {paste_kind: {label: "Paste collection kind", type: "text", required: true}, paste_id: {label: "Paste jar id", type: "text", required: true}, profile: {label: "Four phases and manufacturer limits", type: "json", required: true}}},
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      {id: "digifab:reflow-bridge-package", group: "make", label: "Download the reflow bridge driver", description: "Read the installable bridge driver package for T-962 open firmware and YARC controllers.", scope: "workspace", invokeHandler: "digifab.reflow-bridge-package", userInvokable: true, argsSchema: {}},
      {
        // UI-SCREEN: /digifab/manager
        id: "digifab:dispatch-material", label: "Dispatch a laser batch by material", scope: "workspace", group: "more", userInvokable: false,
        description: "Spread an SVG/DXF quantity across idle lasers with matching profiles and available sheet area. Plan previews layouts; queue verifies saved layouts and queues sheet jobs without Start; cancel withdraws an unqueued batch. Returns a saved blocked batch when stock is short; plan again by id after restocking. Requires an admin. Request fields: library_id, quantity, material, thickness_mm, operations (drawing layer to cut/score/engrave), spacing_mm, kerf_mm, rotate, dxf_units.",
        examples: ["spread 200 stars across the plywood lasers", "retry this batch after restocking"], invokeHandler: "digifab.dispatch-material", effect: "writes", undoable: false,
        argsSchema: {
          operation: { label: "Operation", type: "text", required: true, choices: ["plan", "queue", "cancel"].map(value => ({ value, label: value })) },
          request: { label: "Batch request", type: "json", oneOf: "batch" },
          id: { label: "Saved batch id", type: "text", oneOf: "batch" },
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:laser-control", label: "Control a direct laser", scope: "workspace", group: "more", userInvokable: false,
        description: "Stop, pause or resume a direct laser, or frame its reviewed file with the cutting laser off. Workspace members may stop a laser. This action cannot start a new cutting job.",
        invokeHandler: "digifab.laser-control", effect: "writes", undoable: false,
        argsSchema: {
          connection_id: { label: "Connection", type: "text", required: true },
          device_id: { label: "Device", type: "text", required: true },
          operation: { label: "Control", type: "text", required: true, choices: ["stop", "pause", "resume", "frame"].map(value => ({ value, label: value })) },
          file_id: { label: "Reviewed file for Frame", type: "text" },
          job_id: { label: "Queued job for Frame", type: "text" },
        },
      },
      {
        // UI-SCREEN: /digifab
        id: "digifab:laser-batch", label: "Prepare a laser batch", group: "more", scope: "workspace", userInvokable: false,
        description: "Create, import or update material profiles, plan SVG/DXF batches on chosen sheets, queue reviewed plans or discard unqueued plans. Requires an admin. Never starts the laser. Create fields: connection_id, device_id, profile. Import fields: connection_id, device_id. Update fields: profile from read_laser_batch. Plan fields: connection_id, device_id, library_id, quantity, sheet_ids, mapping (layer to profile id), spacing_mm, kerf_mm, rotate, dxf_units. Queue/discard: saved plan id.",
        examples: ["prepare 200 parts from this drawing", "import the laser material profiles"],
        invokeHandler: "digifab.laser-batch", effect: "writes", undoable: false,
        argsSchema: {
          operation: { label: "Operation", type: "text", required: true, choices: ["create_profile", "import_profiles", "update_profile", "plan", "queue", "discard"].map(value => ({ value, label: value.replaceAll("_", " ") })) },
          id: { label: "Profile or plan id", type: "text" },
          fields: { label: "Profile or plan fields", type: "json" },
        },
      },
      {
        // The one door a job reaches a machine by: the page's Send button and
        // this action run the same send (api/jobs.ts sendAndWatch). It starts
        // a physical machine, so a person's yes stands in front of it from
        // every door, not only the page's dialog (Services §9, §14.3).
        group: "more",
        id: "digifab:send",
        label: "Send a job to its machine",
        description:
          "Sends a queued job's file to its machine and starts watching it. This physically starts the machine, so it always asks a person first.",
        appliesTo: { kinds: ["digifab:job"] },
        recordOptional: true,
        userInvokable: false,
        examples: ["send the bracket job to the printer"],
        invokeHandler: "digifab.send",
        effect: "physical",
        argsSchema: {
          job_id: { label: "Job", type: "text" },
        },
      },
      {
        // UI-SCREEN: /makes, whose New make form starts one; this is the same
        // act for another module (an order line, a work order) and the assistant.
        group: "more",
        id: "digifab:start-make",
        label: "Start a make",
        description:
          "Start a Make (one print's whole history, from the request to the outcome) and say what it is for. Args: { name, prompt?, source_kind?, source_id? }. With a source (an order line, a work order) the Make and the source are linked both ways and digifab.make.completed carries it. Returns { makeId, detailUrl }.",
        examples: ["start a make for this order line", "make a round spacer"],
        scope: "workspace",
        invokeHandler: "digifab.start-make",
        argsSchema: {
          name: { label: "What is being made", type: "text", required: true },
          prompt: { label: "What to make, in words", type: "text" },
          source_kind: { label: "What it is for: the kind", type: "text", with: "source_id" },
          source_id: { label: "What it is for: the record", type: "text", with: "source_kind" },
        },
        userInvokable: false,
      },
      {
        // Which printer should print this: ranked by fits, then loaded with
        // enough of the filament, then idle, then pool order (pick-printer.ts).
        // Sends nothing; the step before the one confirm card in "Print this".
        // UI-SCREEN: /files/:id, where Print this shows the printer it picked.
        group: "more",
        id: "digifab:pick-printer",
        label: "Pick a printer for a print",
        description:
          "Ranks the linked printers for a print: the part has to fit the build volume, then a printer already loaded with enough of the material and colour, then an idle one, then the pool order. Returns each printer with the loaded spool and slot, its Printing profile (printer model, nozzle, quality, preset hint) and the reason. Sends nothing.",
        scope: "workspace",
        userInvokable: false,
        undoable: true,
        examples: ["which printer should print a 60 by 60 by 20 mm part in black PETG, about 40 grams?"],
        invokeHandler: "digifab.pick-printer",
        argsSchema: {
          material: { label: "Material", type: "text", required: true },
          color: { label: "Colour", type: "text" },
          grams: { label: "Grams of filament", type: "number", required: true },
          bbox_mm: { label: "Part size x, y, z (mm)", type: "list", required: true },
          nozzle_mm: { label: "Nozzle (mm)", type: "number" },
        },
      },
      {
        // Print this (Services §14.3): a model file (or a Make with one) to a
        // print. Opens a Make, picks the printer by pick-printer's rule,
        // slices for that printer's Printing profile, and leaves the print
        // waiting for a person's one yes on the Make. Starts no machine.
        // UI-SCREEN: /files/:id, the Print this panel on a model file's page.
        group: "more",
        id: "digifab:print-this",
        label: "Print this",
        description:
          "Starts from a file, a Make, or a request with a design template or CAD source. For a design, prefer a template; otherwise write build123d (top-level part) or OpenSCAD source and pass it with the prompt. Design outputs wait for model approval on the Make. Then choose Print this to pick a printer and slice. Only Start the print moves a machine.",
        scope: "workspace",
        userInvokable: false,
        undoable: true,
        examples: ["print the bracket.stl in black PETG", "print this model in PLA"],
        invokeHandler: "digifab.print-this",
        argsSchema: {
          file_id: { label: "Model file", type: "text" },
          make_id: { label: "Make", type: "text" },
          prompt: { label: "What to make", type: "text" },
          source: { label: "CAD source", type: "text" },
          source_lang: { label: "CAD language", type: "text" },
          template: { label: "Design template", type: "text" },
          params: { label: "Template parameters", type: "json" },
          quantity: { label: "Prints", type: "number" },
          material: { label: "Material", type: "text", required: true },
          color: { label: "Colour", type: "text" },
          bbox_mm: { label: "Part size x, y, z (mm)", type: "list" },
        },
      },
      {
        // DEPRECATED ALIAS. The actuator moved to core-devices (general device
        // I/O, not fabrication). This thin alias delegates to
        // core-devices:run-command so wires in ALREADY-INSTALLED bundles keep
        // working; new bundles should use core-devices:run-command.
        // NO-PHRASING: a deprecated alias kept so installed wires keep working; phrasings here would compete with core-devices:run-command
        group: "more",
        id: "digifab:run-command",
        label: "Run a device command (deprecated → core-devices:run-command)",
        description:
          "Deprecated alias of core-devices:run-command, kept so installed bundle wires keep working. Fires a parameterized command-and-forget at a connected actuator via platform().devices. New wires should target core-devices:run-command.",
        appliesTo: { traits: ["physical"] },
        invokeHandler: "digifab.run-command",
        userInvokable: false,
      },
    ],
  },

  subscribes: ["services.job.done", "services.job.failed"],
});
