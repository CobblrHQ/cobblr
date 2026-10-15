// digifab — Digital Fabrication. Connect to the software that runs your
// machines (FDM Monster, OctoPrint, …), send a file to be made, and track
// the job to completion. Server-to-server over the machine manager's REST
// API — it sends files, it never drives hardware (coordinate-not-control).
// The driver layer (MachineDriver interface + fdm-monster + mock) is in
// ./drivers; this is the connection registry + its HTTP surface.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "digifab",
  version: "0.39.0",
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
      const { registerKilnMonitor } = await import("./kilns/monitor.js");
      registerKilnMonitor();
      const { registerPollWorker } = await import("./poll-worker.js");
      registerPollWorker();
    (await import("./large-format/supplies.js")).registerSupplyPolling();
      // One-shot heal: detectors onto adapter connections (see
      // heal-detectors-to-connections.ts for the retirement condition).
      const { registerDetectorsToConnectionsHeal } = await import("./heal-detectors-to-connections.js");
      registerDetectorsToConnectionsHeal();
      const { registerLaserRunPoolsHeal } = await import("./heal-laser-run-pools.js");
      registerLaserRunPoolsHeal();
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
        // AI-CRUD: immutable attempts are prepared and finished by production-test, never edited or deleted.
        id: "digifab:test-run", displayName: "Production test attempt", displayNamePlural: "Production test attempts", icon: "activity", profile: "work-item",
        fields: [{ name: "name", type: "text", role: "title" }, { name: "status", type: "text" }, { name: "plan_version", type: "number" }, { name: "plan_hash", type: "text" }, { name: "result", type: "object" }, { name: "unit_kind", type: "text" }, { name: "unit_id", type: "text" }, { name: "operator_id", type: "text" }, { name: "station", type: "text" }, { name: "jig_id", type: "text" }, { name: "jig_cycle", type: "number" }],
        exposableFields: ["name", "status", "plan_version", "plan_hash", "result", "unit_kind", "unit_id", "operator_id", "station", "jig_id", "jig_cycle"], detailRoute: "/digifab/production?run={id}",
      },
      {
        // AI-CRUD: no create/update/delete: creation and completion share the kiln-log action; firing recipes stay immutable.
        id: "digifab:firing", displayName: "Firing", displayNamePlural: "Firings", icon: "flame", profile: "work-item",
        fields: [{ name: "name", type: "text", role: "title", required: true }, { name: "status", type: "text" }, { name: "peak_c", type: "number" }, { name: "duration_hours", type: "number" }],
        exposableFields: ["name", "status", "peak_c", "duration_hours"],
      },
      {
        // AI-CRUD: no create/update/delete, immutable readings come from digifab:instrument and remain evidence.
        id: "digifab:instrument-reading",displayName:"Instrument reading",displayNamePlural:"Instrument readings",icon:"activity",profile:"work-item",
        fields:[{name:"identity",type:"text",role:"title"},{name:"measured_at",type:"text"},{name:"readings",type:"object"},{name:"screenshot_file_id",type:"text"},{name:"capture_file_id",type:"text"},{name:"decoded_frames",type:"text"}],
        exposableFields:["identity","measured_at","readings","screenshot_file_id","capture_file_id","decoded_frames"],
      },
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
      // Each machine panel names the collections it serves, and shows on any
      // other machine only where that machine already has its data
      // (panel-presence.ts): a kiln's firing logs on every 3D printer was the
      // growth the owner named (#6337).
      { id: "digifab:kiln", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Firing logs", collections: ["kilns"], presence: true },
      { id: "digifab:instrument", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Bench instrument", presence: true },
      // "Just my 3D printers, live" — the scoped fleet floor as a page tab
      // on every machines collection (3D Printers, Laser Cutters, …).
      { id: "digifab:fleet-tab", surface: "module-page-tab" as const, target: "machines", title: "Fleet" },
      // The per-machine cockpit half: link THIS machine to its manager +
      // live status, inside the machine's own detail modal.
      { id: "digifab:cockpit", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Job manager", collections: ["3d-printers", "laser-cutters", "cnc-machines"], presence: true },
      // The spools loaded on this printer, one per slot: a print draws its
      // grams from them (loaded-spools.ts).
      { id: "digifab:loaded", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Loaded filament", collections: ["3d-printers"], presence: true },
      // What a slicer needs to know about this printer (Services §14.3): its
      // neutral model id, nozzle, build volume, default quality and a preset
      // per filament type. One per machine, read by every slicer.
      { id: "digifab:printing-profile", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Printing profile", collections: ["3d-printers"], presence: true },
      // Print this on a model file's own page (Services §14.3): the door to a
      // Make, a printer it fits, a slice, and the one yes.
      { id: "digifab:print-this", surface: "entity-detail-panel" as const, target: "core-files:file", title: "Print this" },
    ],
  },

  // Running the machines without setting them up (#6672): the operator role
  // holds it, an admin can grant it to a member, and every run door asks it.
  capabilities: [
    {
      id: "digifab:operate",
      label: "Run machines",
      description: "Start and send jobs, resume them, start a machine's file, confirm the stock loaded at a station and record how a job came out. Setting up machines, connections and stations stays with admins; stopping and pausing are every member's.",
      heldBy: ["operator"],
    },
  ],

  exposes: {
    // What the print events carry for the stock wires: partId, delta and
    // reason only when the job named a material.
    eventPayloads: {
      "digifab.print.completed": ["jobId", "connectionId", "linkedMachineId", "linkedTaskId", "hours", "partId", "delta", "reason", "sourceKind", "sourceId"],
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
      {eventType:"digifab.ink.low",label:"Printer ink is running low",description:"An IPP printer reports an ink or toner supply at 10 percent or less. One alert until a known refill."},
      { eventType: "digifab.make.ready", label: "A print is ready to start", description: "Print this has sliced a model for a printer; the print waits on its Make for someone to start it." },
    ],
    actions: [
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      {runBy: "member", id: "digifab:reflow-profiles", group: "make", label: "Read paste profiles", description: "List saved immutable reflow profiles for this paste jar.", scope: "workspace", invokeHandler: "digifab.reflow-profiles", userInvokable: true, argsSchema: {paste_kind: {label: "Paste collection kind", type: "text", required: true}, paste_id: {label: "Paste jar id", type: "text", required: true}}},
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      {runBy: "member", id: "digifab:reflow-profile", group: "make", label: "Read a paste profile", description: "Read one saved paste profile and its manufacturer limits.", scope: "workspace", invokeHandler: "digifab.reflow-profile", userInvokable: true, argsSchema: {profile_id: {label: "Paste profile id", type: "text", required: true}}},
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      // ADMIN-ONLY: a paste's reflow profile is the recipe every later batch is baked with; saving one is process setup, and a member has no say over configuration
      {runBy: "admin", id: "digifab:save-reflow-profile", group: "make", label: "Save a paste reflow profile", description: "Save the four phases and manufacturer limits as a new immutable version for a liquid paste jar.", scope: "workspace", invokeHandler: "digifab.save-reflow-profile", userInvokable: true, argsSchema: {paste_kind: {label: "Paste collection kind", type: "text", required: true}, paste_id: {label: "Paste jar id", type: "text", required: true}, profile: {label: "Four phases and manufacturer limits", type: "json", required: true}}},
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      {runBy: "member", id: "digifab:reflow-bridge-package", group: "make", label: "Download the reflow bridge driver", description: "Read the installable bridge driver package for T-962 open firmware and YARC controllers.", scope: "workspace", invokeHandler: "digifab.reflow-bridge-package", userInvokable: true, argsSchema: {}},
      {
        // UI-SCREEN: /digifab/production
        id: "digifab:production-test", label: "Manage production tests", scope: "workspace", group: "more", userInvokable: false, effect: "writes", undoable: false,
        runBy: "member",
        description: "Save a new immutable test-plan version; register a native jig asset with its fixture pins (pins: name, gpio, direction input or output, pull) and maintenance interval; mint a quantity-one inventory unit without changing its model quantity; prepare an exact unit/plan_version/jig_id/station/bridge_connection_id attempt; sync offline evidence; record reworked or scrapped dispositions; export unit or filtered product/customer/lot PDF or JSON certificates through Files. Admin required for save_plan, save_jig and mint_unit. Other operations require a member. fields is the operation's JSON object.",
        invokeHandler: "digifab.production-test", argsSchema: { operation: { label: "Operation", type: "text", required: true, choices: ["save_plan", "save_jig", "mint_unit", "prepare", "sync", "disposition", "export"].map(value => ({ value, label: value })) }, fields: { label: "Production fields", type: "json", required: true } },
      },
      {
        // UI-SCREEN: /station/production/:connectionId
        id: "digifab:production-control", label: "Run a production test", scope: "workspace", group: "more", userInvokable: false, effect: "physical", undoable: false,
        // ADMIN-ONLY: starting an attempt powers the board on its jig and answering a prompt moves it on, so it runs the station: the admin tier, or an operator (#6785); aborting stays every member's (digifab:production-abort)
        runBy: "admin",
        grantedAs: "digifab:operate",
        description: "Start a prepared production attempt with fields id, confirmed:true and the scanned jig_id, or answer its current operator prompt with id, step_id, value and optional photo. Requires an admin or an operator. Uses the exact saved plan and approved bridge. All controlled supplies must be owner-enabled. Abort is the separate production-abort stop action, which any member may use.",
        invokeHandler: "digifab.production-control", argsSchema: { operation: { label: "Operation", type: "text", required: true, choices: ["start", "answer"].map(value => ({ value, label: value })) }, fields: { label: "Run or answer fields", type: "json", required: true } },
      },
      {
        // UI-SCREEN: /station/production/:connectionId
        id: "digifab:production-abort", label: "Abort a production test", scope: "workspace", group: "more", userInvokable: false, effect: "stops", undoable: false,
        runBy: "member",
        description: "Stop the prepared or active attempt immediately and turn every declared supply off. Requires a member; no confirmation is needed.", invokeHandler: "digifab.production-abort", argsSchema: { id: { label: "Attempt id", type: "text", required: true } },
      },
      {
        // UI-SCREEN: /digifab/production
        id: "digifab:production-read", label: "Read production test evidence", scope: "workspace", group: "more", userInvokable: false, effect: "none", undoable: false,
        runBy: "member",
        description: "Read a serialized unit's full history (fields kind/id), product/customer/lot statistics (fields product_id/customer_id/lot), or a production bridge's cached attempts (fields connection_id). Reports first-pass yield, step failures, measured spreads and drift, and operator/jig failure rates. Requires a workspace member.", invokeHandler: "digifab.production-read", argsSchema: { operation: { label: "Read", type: "text", required: true, choices: ["history", "report", "artifact", "bridge"].map(value => ({ value, label: value })) }, fields: { label: "Scope", type: "json", required: true } },
      },
      {
        // UI-SCREEN: /machines
        id: "digifab:kiln-log", label: "Record kiln firings", scope: "workspace", group: "more", userInvokable: false, effect: "writes", undoable: false,
        // ADMIN-ONLY: the page's kiln routes POST /kilns/:machineId/profile, /firings and /firings/:id/finish gate on this action, owner or admin (kilns.ts)
        runBy: "admin",
        description: "Save a kiln profile, create a firing log with schedule and every piece, or finish a log with measured hours and peak temperature. Requires an admin. Never starts or stops a kiln. Profile id is machine id, fields: connection_id, device_id, components (name, interval_hours, replaced_at_hours). Create id is a new UUID, fields: machine_id, firing (name, cone, schedule of ramp_c_per_hour/target_c/hold_minutes, pieces of kind/id, glazes of part_id/ml and optional kind for an Inventory collection (must be liquid workshop stock), notes). Finish id is firing id, fields: duration_hours, peak_c, outcome completed/failed/stopped.",
        examples: ["log this glaze firing and all its pieces", "replace the kiln elements after 200 firing hours"], invokeHandler: "digifab.kiln-log",
        argsSchema: {
          operation: { label: "Operation", type: "text", required: true, choices: ["profile", "create", "finish"].map(value => ({ value, label: value })) },
          id: { label: "Machine or firing id", type: "text", required: true },
          fields: { label: "Profile or log fields", type: "json", required: true },
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id:"digifab:large-format",label:"Prepare and account for a large-format print",scope:"workspace",group:"more",userInvokable:false,
        // ADMIN-ONLY: the page's large-format routes POST /plans, /refresh and /jobs/:id/outcome gate on this action, owner or admin (large-format.ts)
        runBy: "admin",
        description:"Plan PDF/image prints on loaded Roll stock; refresh IPP/SNMP supplies; record roll and Liquid ink use. Admin required; members Stop through digifab:stop. Plan fields: connection_id, device_id, library_id, roll_id, copies, margin_mm, media_type, image width_mm and height_mm. Outcome id is the job; fields: station_token, verdict, used_length_m, idle_confirmed:true, ink [{stock_id,kind,amount_ml,estimated:true}]. Start requires station review through digifab:send. Read via read_laser_batch large_format_station or large_format_jobs.",
        invokeHandler:"digifab.large-format",effect:"writes",undoable:false,
        argsSchema: {
          operation: {label:"Operation",type:"text",required:true,choices:["plan","refresh","outcome"].map(value=>({value,label:value}))},
          fields: {label:"Print fields",type:"json",required:true},
          id: {label:"Job id",type:"text"},
        },
      },
      {
        // UI-SCREEN: /digifab/manager
        id: "digifab:dispatch-material", label: "Dispatch a laser batch by material", scope: "workspace", group: "more", userInvokable: false,
        // ADMIN-ONLY: plans a laser or cutter job from a design; its page twin POST /laser/plans gates on digifab:laser-batch, admin tier (laser.ts)
        runBy: "admin",
        description: "Spread an SVG/DXF quantity across idle lasers with matching profiles and available sheet area. Plan previews layouts; queue verifies saved layouts and queues sheet jobs without Start; cancel withdraws an unqueued batch. Returns a saved blocked batch when stock is short; plan again by id after restocking. Requires an admin. Request fields: library_id, quantity, material, thickness_mm, operations (drawing layer to cut/score/engrave), spacing_mm, kerf_mm, rotate, dxf_units.",
        examples: ["spread 200 stars across the plywood lasers", "retry this batch after restocking"], invokeHandler: "digifab.dispatch-material", effect: "writes", undoable: false,
        argsSchema: {
          operation: { label: "Operation", type: "text", required: true, choices: ["plan", "queue", "cancel"].map(value => ({ value, label: value })) },
          request: { label: "Batch request", type: "json", oneOf: "batch" },
          id: { label: "Saved batch id", type: "text", oneOf: "batch" },
        },
      },
      {
        // UI-SCREEN: /machines/:id
        id: "digifab:instrument",label:"Read a bench instrument",scope:"workspace",group:"more",userInvokable:false,
        runBy: "member",
        description:"Identify or read a bench instrument, log fresh Riden readings, capture or import sigrok sessions with protocol decodes, or configure owner-enabled supply control. Log and capture need record_kind and record_id. Output on and set points require confirmed:true and control enabled by the owner. Output off uses instrument-stop without confirmation.",
        invokeHandler:"digifab.instrument",effect:"writes",undoable:false,
        argsSchema: {
          machine_id:{label:"Machine",type:"text",required:true},
          operation:{label:"Operation",type:"text",required:true,choices:["identify","read","log","capture","configure"].map(value=>({value,label:value.replaceAll("_"," ")}))},
          record_kind:{label:"Record kind",type:"text"},
          record_id:{label:"Record",type:"text"},
          capture:{label:"Capture settings",type:"json"},
          control_enabled:{label:"Allow control",type:"boolean"},
          confirmed:{label:"Confirmed change",type:"boolean"},
          value:{label:"Set point",type:"number"}
        },
      },
      {
        // UI-SCREEN: /configuration/devices
        id:"digifab:discover-esphome",label:"Find ESPHome bench devices",scope:"workspace",group:"more",userInvokable:false,
        // ADMIN-ONLY: the page's GET /bench/discover is owner or admin (bench.ts): finding devices on the network is setting up a station
        runBy: "admin",
        description:"Discover ESPHome devices through the selected bridge's mDNS without returning device credentials.",invokeHandler:"digifab.discover-esphome",effect:"none",undoable:false,
        argsSchema:{bridge:{label:"Bridge",type:"text"}},
      },
      {
        // UI-SCREEN: /machines/:id
        id:"digifab:instrument-control",label:"Change a bench supply",scope:"workspace",group:"more",userInvokable:false,
        runBy: "member",
        description:"Confirmed output-on or set-point change for a Riden supply whose owner enabled control. Every request and result is logged; require device read-back.",invokeHandler:"digifab.instrument-control",effect:"physical",undoable:false,
        argsSchema: {
          machine_id:{label:"Machine",type:"text",required:true},
          operation:{label:"Operation",type:"text",required:true,choices:["output_on","set_voltage","set_current"].map(value=>({value,label:value.replaceAll("_"," ")}))},
          confirmed:{label:"Confirmed",type:"boolean",required:true},
          value:{label:"Set point",type:"number"}
        },
      },
      {
        // UI-SCREEN: /machines/:id
        id:"digifab:instrument-stop",label:"Turn instrument output off",scope:"workspace",group:"more",userInvokable:false,
        runBy: "member",
        description:"Turn the supply output off and require read-back. Never waits for confirmation.",invokeHandler:"digifab.instrument-stop",effect:"stops",undoable:false,
        argsSchema:{machine_id:{label:"Machine",type:"text",required:true}},
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:laser-setup", label: "Set up a laser at its station", scope: "workspace", group: "more", userInvokable: false,
        // ADMIN-ONLY: the page's own route POST /laser/setup gates on this action's own id, owner or admin
        runBy: "admin",
        description: "Read G-code laser configuration, explicitly home it or confirm its firmware build settings. Home and confirmation require an admin and the authorized station credential. Never changes firmware or starts a cut.",
        invokeHandler: "digifab.laser-setup", effect: "physical", undoable: false,
        argsSchema: {
          connection_id: {label:"Connection",type:"text",required:true},device_id:{label:"Device",type:"text",required:true},
          operation:{label:"Operation",type:"text",required:true,choices:["read","home","commission"].map(value=>({value,label:value}))},
          station_token:{label:"Station credential",type:"text"},configuration:{label:"Firmware configuration",type:"json"},
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        // Stop is its own action, and it never waits for a yes (#5091).
        group: "more", id: "digifab:stop", label: "Stop a machine", scope: "workspace", userInvokable: false,
        runBy: "member",
        description: "Stop or pause what a machine is doing: the job it is running by job_id, or a laser, cutter, resin or large-format machine by connection_id and device_id. Runs at once, with no confirm: it only brings a machine toward stopped and never starts or resumes anything. Workspace members may stop a machine. Use the machine's physical Stop in an emergency too.",
        examples: ["stop the laser", "stop that print", "pause the resin printer"],
        invokeHandler: "digifab.stop", effect: "stops", undoable: false,
        argsSchema: {
          command: { label: "Stop or pause", type: "text", choices: [{ value: "stop", label: "Stop" }, { value: "pause", label: "Pause" }] },
          job_id: { label: "Job", type: "text" },
          connection_id: { label: "Connection", type: "text" },
          device_id: { label: "Machine", type: "text" },
        },
      },
      {
        // UI-SCREEN: /digifab
        // Revoking only removes access, so it is not a security exception;
        // minting or showing a station credential stays the page's alone (#5091).
        group: "more", id: "digifab:revoke-station", label: "Take a station's Start away", scope: "workspace", userInvokable: false,
        // ADMIN-ONLY: the page's own routes gate on this action's own id, owner or admin (stations.ts, embroidery.ts)
        runBy: "admin",
        description: "Take a station screen's permission to start jobs away, by the station's name. The screen can no longer start a job; nothing already running is stopped. Requires an admin. Asks the person first.",
        examples: ["kick that tablet off the laser station", "the shop tablet should not start jobs any more"],
        invokeHandler: "digifab.revoke-station", effect: "writes", undoable: false,
        argsSchema: { station: { label: "Station", type: "text", required: true } },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:laser-control", label: "Control a direct laser", scope: "workspace", group: "more", userInvokable: false,
        runBy: "member",
        description: "Stop, pause or resume a direct laser, or frame its reviewed file with the cutting laser off. Any member may stop or pause a laser; resuming and framing need an admin or an operator. This action cannot start a new cutting job.",
        invokeHandler: "digifab.laser-control", effect: "physical", undoable: false,
        argsSchema: {
          connection_id: { label: "Connection", type: "text", required: true },
          device_id: { label: "Device", type: "text", required: true },
          operation: { label: "Control", type: "text", required: true, choices: ["stop", "pause", "resume", "frame"].map(value => ({ value, label: value })) },
          file_id: { label: "Reviewed file for Frame", type: "text" },
          job_id: { label: "Queued job for Frame", type: "text" },
        },
      },
      {
        // UI-SCREEN: /digifab/embroidery
        id:"digifab:embroidery-job",label:"Prepare and record embroidery",scope:"workspace",group:"more",userInvokable:false,
        // ADMIN-ONLY: the page's own route POST /embroidery/actions gates on this action's own id, owner or admin
        runBy: "admin",
        description:"Create or update a machine (label, hoops with name/width_mm/height_mm, formats, stitches_per_minute, filename_prefix, asset_ref), import a design (file_id, name), prepare a USB run (machine_id, design_id, hoop, format, threads mapping colour-stop indices to native spool ids), start tracking at its authorized station (station_token and file_copied/file_confirmed/hoop_mounted/colours_loaded/origin_clear all true), record interruption, or record outcome (station_token, verdict good/scrap, finished, idle_confirmed and needle_up_confirmed true, usage array of index/metres for every colour stop). Requires admin. Never operates a physical machine. Unstarted discards require scrap and zero use. Read with read_laser_batch embroidery operations. Download the prepared machine file with /embroidery/runs/{job_id}/export.",
        invokeHandler:"digifab.embroidery-job",effect:"writes",undoable:false,
        argsSchema: {
          operation: {label:"Operation",type:"text",required:true,choices:["create_machine","update_machine","import_design","prepare","start","interrupt","outcome"].map(value=>({value,label:value.replaceAll("_"," ")}))},
          id: {label:"Machine or job id",type:"text"},
          fields: {label:"Fields",type:"json"},
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:machine-control", label: "Control a machine", scope: "workspace", group: "more", userInvokable: false,
        // A member at the station may stop, pause, resume or frame: the page's own control route POST /fleet/:connectionId/:deviceId/control admits members (fleet.ts)
        runBy: "member",
        description: "Stop, pause or resume a machine that uses station review, or frame its reviewed queued program with the spindle or cutting laser off. Any member may stop or pause; resuming and framing need an admin or an operator. This action cannot start a new job.",
        invokeHandler: "digifab.machine-control", effect: "physical", undoable: false,
        argsSchema: {
          connection_id: { label: "Connection", type: "text", required: true },
          device_id: { label: "Device", type: "text", required: true },
          operation: { label: "Control", type: "text", required: true, choices: ["stop", "pause", "resume", "frame"].map(value => ({value,label:value})) },
          file_id: { label: "Reviewed file for Frame", type: "text" },
          job_id: { label: "Queued program for Frame", type: "text" },
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:machine-outcome", label: "Record a CNC outcome", group: "more", scope: "workspace", userInvokable: false,
        // ADMIN-ONLY: recording an outcome consumes stock and bit hours; the page's route POST /fleet/:connectionId/:deviceId/ready gates on this action's own id: the admin tier, or an operator (#6672)
        runBy: "admin",
        grantedAs: "digifab:operate",
        description: "Record a finished CNC job as good or scrap, consuming its sheet region or block and actual bit hours once. Requires an admin or an operator, and a confirmed idle machine. If a bridge restart lost native runtime, provide actual tool_seconds for every reviewed tool, including zero for unused tools and never less than runtime already observed.",
        invokeHandler: "digifab.machine-outcome", effect: "writes", undoable: false,
        argsSchema: {
          connection_id: { label: "Connection", type: "text", required: true },
          device_id: { label: "Device", type: "text", required: true },
          job_id: { label: "Finished job", type: "text", required: true },
          outcome: { label: "Outcome", type: "text", required: true, choices: ["good", "scrapped"].map(value => ({ value, label: value })) },
          tool_seconds: { label: "Confirmed actual seconds by tool number", type: "json" },
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:station-run", label: "Record a station job's run", group: "more", scope: "workspace", userInvokable: false,
        // ADMIN-ONLY: running a prepared job at its station consumes stock; the page's outcome routes (cutter.ts, large-format.ts) and the embroidery run's start, interrupt and outcome gate on this action's own id: the admin tier, or an operator (#6672)
        runBy: "admin",
        grantedAs: "digifab:operate",
        description: "At a machine's authorized station, record how a prepared job came out, or start and interrupt an embroidery run. Operations: cutter_outcome and large_format_outcome (id is the job; fields as the cutter or print report, with station_token), embroidery_start, embroidery_interrupt and embroidery_outcome (id is the embroidery job; fields as for digifab:embroidery-job). Requires an admin or an operator. Never plans, prepares or sets up a machine: those stay with digifab:cutter-batch, digifab:large-format and digifab:embroidery-job.",
        examples: ["the vinyl cut came out good, record it", "start the embroidery run on the hoop that's loaded"],
        invokeHandler: "digifab.station-run", effect: "writes", undoable: false,
        argsSchema: {
          operation: { label: "Operation", type: "text", required: true, choices: ["cutter_outcome", "large_format_outcome", "embroidery_start", "embroidery_interrupt", "embroidery_outcome"].map(value => ({ value, label: value.replaceAll("_", " ") })) },
          id: { label: "Job id", type: "text", required: true },
          fields: { label: "Report fields", type: "json" },
        },
      },
      {
        // UI-SCREEN: /digifab
        id: "digifab:place-program", label: "Find free CNC sheet area", group: "more", scope: "workspace", userInvokable: false,
        // ADMIN-ONLY: placing a program on stock is setting up the machine; the page's route POST /jobs/:id/place gates on this action's own id, owner or admin (jobs.ts)
        runBy: "admin",
        description: "Find a free region for one queued posted CNC program using the existing rectangle nesting planner. Choose sheet stock and every matching library bit. The footprint includes the widest bit's radius, never rotates or rewrites the program, and returns the G54 origin to set and confirm at the machine. Requires an owner or admin; never starts or frames a machine.",
        invokeHandler: "digifab.place-program", effect: "none", undoable: false,
        argsSchema: {
          job_id: { label: "Queued CNC job", type: "text", required: true },
          stock_id: { label: "Sheet stock", type: "text", required: true },
          tools: { label: "Tool numbers and library partId values", type: "json", required: true },
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:cutter-batch", label: "Prepare a cutter job", group: "more", scope: "workspace", userInvokable: false,
        // ADMIN-ONLY: the page's own cutter routes gate on this action's own id, owner or admin (cutter.ts)
        runBy: "admin",
        description: "Create or update machine-bound vinyl, HTV and cardstock profiles and prepare SVG/DXF cuts on a native roll. Requires an admin. Never starts a machine. Profile fields: connection_id, device_id, profile (material, material_type, speed, force, blade_depth, passes, blade_offset_mm). Plan fields: connection_id, device_id, library_id, roll_id, mapping (layer to profile id), quantity, length_mm, spacing_mm, mirror, weed_box_mm, weed_line_spacing_mm, dxf_units. Outcome requires the authorized station token, measured used_length_m, good or scrap verdict, idle_confirmed and blade_up_confirmed. Interrupted cuts are scrap. Read profiles and station state with read_laser_batch (cutter_profiles or cutter_station).",
        invokeHandler: "digifab.cutter-batch", effect: "writes", undoable: false,
        argsSchema: {
          operation: {label:"Operation",type:"text",required:true,choices:["create_profile","update_profile","plan","outcome"].map(value=>({value,label:value.replaceAll("_"," ")}))},
          id: {label:"Profile or job id",type:"text"}, fields: {label:"Fields",type:"json"},
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:cutter-control", runBy: "member", label: "Control a cutter", group: "more", scope: "workspace", userInvokable: false,
        description: "Stop, pause or resume cutter streaming. Any member may stop or pause a cutter without a station credential; resuming, framing and confirming idle need an admin or an operator. Frame requires its reviewed queued job, loaded roll and authorized station token. Confirm idle requires that token and physical idle and blade-up confirmation. Never starts a new cut. Use the machine's physical Stop in an emergency.",
        invokeHandler: "digifab.cutter-control", effect: "physical", undoable: false,
        argsSchema: {
          connection_id:{label:"Connection",type:"text",required:true},device_id:{label:"Device",type:"text",required:true},operation:{label:"Control",type:"text",required:true,choices:["stop","pause","resume","frame","confirm-idle"].map(value=>({value,label:value}))},
          job_id:{label:"Queued job",type:"text"},file_id:{label:"Reviewed file",type:"text"},project_hash:{label:"Review hash",type:"text"},station_token:{label:"Authorized station token",type:"text"},idle_confirmed:{label:"Machine is idle",type:"boolean"},blade_up_confirmed:{label:"Blade is up",type:"boolean"},
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:resin-control", label: "Control a resin printer", scope: "workspace", group: "more", userInvokable: false,
        runBy: "member",
        description: "Stop, pause or resume a resin printer. Stop also prevents an uploading job from starting. Any member may stop or pause; resuming needs an admin or an operator; starting a print requires its authorized station and reviewed file.",
        invokeHandler: "digifab.resin-control", effect: "physical", undoable: false,
        argsSchema: {
          connection_id: { label: "Connection", type: "text", required: true },
          device_id: { label: "Device", type: "text", required: true },
          operation: { label: "Control", type: "text", required: true, choices: ["stop", "pause", "resume"].map(value => ({ value, label: value })) },
        },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:resin-postprocess", runBy: "member", label: "Record resin print washing and curing", scope: "workspace", group: "more", userInvokable: false,
        description: "Mark a good resin print washed or cured after its stock use is recorded. Washing comes before curing. This records the physical checklist and does not operate a wash or cure machine.",
        invokeHandler: "digifab.resin-postprocess", effect: "writes", undoable: false,
        argsSchema: {
          job_id: { label: "Print job", type: "text", required: true },
          step: { label: "Finished step", type: "text", required: true, choices: ["wash", "cure"].map(value => ({ value, label: value })) },
        },
      },
      {
        // UI-SCREEN: /digifab
        id: "digifab:laser-batch", label: "Prepare a laser batch", group: "more", scope: "workspace", userInvokable: false,
        // ADMIN-ONLY: the page's own laser routes gate on this action's own id, owner or admin (laser.ts)
        runBy: "admin",
        description: "Create, import or update material profiles, plan SVG/DXF batches on chosen sheets, queue reviewed plans or discard unqueued plans. Nest outlines for laser, CNC or cutter previews with operation nest, without a machine or profiles. Requires an admin. Never starts a machine. Create fields: connection_id, device_id, profile. Import fields: connection_id, device_id. Update fields: profile from read_laser_batch. Plan fields: connection_id, device_id, library_id, quantity, sheet_ids, mapping (layer to profile id), spacing_mm, kerf_mm, rotate, rotation_step, budget_ms (3000 default, up to 30000), seed, dxf_units. Nest fields: the same without connection_id, device_id or mapping. Plan also accepts allow_flip. Adjust: saved plan id and fields.operation pick (alternative 0-2), lock (parts, locked), clear_locks, avoid (sheet_id, rectangle, permanent), clear_avoid, renest (budget_ms), move or check_move (part, sheet_id, x, y, angle, mirrored), limit (sheet_id, maximum), fill (sheet_id), export (sheet_id, format svg/dxf/lightburn), import (sheet_id, filename, content, extras review/keep/drop, assignments mapping reported shape names to missing part numbers). Layout coordinates are millimetres from the lower-left. Imports match names first, then geometry and position. New, changed or ambiguous shapes need an explicit assignment or extra-shape decision. Requested part counts stay intact. Queue/discard: saved plan id.",
        examples: ["prepare 200 parts from this drawing", "import the laser material profiles"],
        invokeHandler: "digifab.laser-batch", effect: "writes", undoable: false,
        argsSchema: {
          operation: { label: "Operation", type: "text", required: true, choices: ["create_profile", "import_profiles", "update_profile", "plan", "nest", "adjust", "queue", "discard"].map(value => ({ value, label: value.replaceAll("_", " ") })) },
          id: { label: "Profile or plan id", type: "text" },
          fields: { label: "Profile or plan fields", type: "json" },
        },
      },
      {
        // UI-SCREEN: /digifab
        id: "digifab:discover-snapmakers", label: "Find Snapmakers", group: "more", scope: "workspace", userInvokable: false,
        // ADMIN-ONLY: finds machines on the network; adding a connection, POST /connections, is owner or admin (bulk.ts)
        runBy: "admin",
        description: "Find Snapmakers on one LAN bridge and report which transport each machine advertises. Requires an admin. Does not pair or start a machine.",
        examples: ["find Snapmakers on the workshop bridge"], invokeHandler: "digifab.discover-snapmakers", effect: "none", undoable: false,
        argsSchema: { bridge: { label: "Bridge id", type: "text" } },
      },
      {
        // The one door a job reaches a machine by: the page's Send button and
        // this action run the same send (api/jobs.ts sendAndWatch). It starts
        // a physical machine, so a person's yes stands in front of it from
        // every door, not only the page's dialog (Services §9, §14.3).
        group: "more",
        id: "digifab:send",
        // ADMIN-ONLY: sends a file to a printer; POST /jobs/:id/send gates on this action's own id: the admin tier, or an operator (#6672)
        runBy: "admin",
        grantedAs: "digifab:operate",
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
        runBy: "member",
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
        runBy: "member",
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
        runBy: "member",
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
        // UI-SCREEN: /makes/:id, the approved batch card.
        userInvokable: false,
        group: "more",
        id: "digifab:start-next-print", label: "Bed is clear, start the next one", effect: "physical",
        // ADMIN-ONLY: starts a physical printer; its page route POST /makes/:id/print/next gates on this action: the admin tier, or an operator (#6672)
        runBy: "admin",
        grantedAs: "digifab:operate",
        scope: "workspace", appliesTo: { kinds: ["digifab:make"] }, invokeHandler: "digifab.start-next-print",
        description: "Starts the next print in an approved Make batch after the person clears the bed. Always asks for a physical confirmation. Changed printer, files, spools, material or quantity require full batch review and approval again.",
        argsSchema: { make_id: { label: "Make", type: "text" } },
      },
      {
        // UI-SCREEN: /makes/:id, the batch review controls.
        userInvokable: false,
        group: "more",
        id: "digifab:review-print-batch", label: "Review the changed print batch", effect: "writes",
        // ADMIN-ONLY: re-approves what a batch will print; its page route POST /makes/:id/print/review gates on this action, owner or admin (makes.ts)
        runBy: "admin",
        scope: "workspace", appliesTo: { kinds: ["digifab:make"] }, invokeHandler: "digifab.review-print-batch",
        description: "Refreshes a waiting batch card with its current printer, file, spools and quantity. Starts no machine. A person must approve the new card before starting.",
        argsSchema: { make_id: { label: "Make", type: "text" }, quantity: { label: "Total prints including those finished", type: "number" } },
      },
      {
        // UI-SCREEN: /makes/:id, the remaining prints control.
        userInvokable: false,
        group: "more",
        id: "digifab:cancel-print-batch", label: "Cancel the remaining prints", effect: "stops",
        runBy: "member",
        scope: "workspace", appliesTo: { kinds: ["digifab:make"] }, invokeHandler: "digifab.cancel-print-batch",
        description: "Cancels a Make batch's remaining jobs immediately. Never starts a machine. An active job finishes.",
        argsSchema: { make_id: { label: "Make", type: "text" } },
      },
      {
        // DEPRECATED ALIAS. The actuator moved to core-devices (general device
        // I/O, not fabrication). This thin alias delegates to
        // core-devices:run-command so wires in ALREADY-INSTALLED bundles keep
        // working; new bundles should use core-devices:run-command.
        // NO-PHRASING: a deprecated alias kept so installed wires keep working; phrasings here would compete with core-devices:run-command
        group: "more",
        id: "digifab:run-command",
        // ADMIN-ONLY: sends a command to a physical machine; no page route admits a member to do that
        runBy: "admin",
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
