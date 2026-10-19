// digifab — Digital Fabrication. Connect to the software that runs your
// machines (FDM Monster, OctoPrint, …), send a file to be made, and track
// the job to completion. Server-to-server over the machine manager's REST
// API — it sends files, it never drives hardware (coordinate-not-control).
// The driver layer (MachineDriver interface + fdm-monster + mock) is in
// ./drivers; this is the connection registry + its HTTP surface.

import { defineModule } from "@cobblr/platform-contract";
import { FAMILY_ACTIONS, FAMILY_NOTIFICATIONS, FAMILY_PANELS, FAMILY_PARTS } from "./families/manifests.js";

export default defineModule({
  name: "digifab",
  version: "0.45.0",
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

  // Families of machines a workspace has on or off on their own: robot arms
  // first (docs/modules/digifab-families.md).
  parts: FAMILY_PARTS,

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
      // What each machine runs, once an hour, handed to its machine record.
      const { registerVersionRead } = await import("./version-read.js");
      registerVersionRead();
      // Each family's own boot work (core/families.ts).
      (await import("./core/utilisation.js")).registerUtilisation();
      (await import("./core/alarms.js")).registerAlarmEscalation();
      for (const family of (await import("./families/index.js")).FAMILIES) await family.onBoot?.();
      const { registerPollWorker } = await import("./poll-worker.js");
      registerPollWorker();
    (await import("./large-format/supplies.js")).registerSupplyPolling();
      const { registerLaserRunPoolsHeal } = await import("./heal-laser-run-pools.js");
      registerLaserRunPoolsHeal();
      const { registerAssignWorker } = await import("./assign-worker.js");
      registerAssignWorker();
      // Keeps jobs moving across a restart: revives dead poll/assign chains and
      // returns a job a stopped send left half way.
      const { registerFarmWatchdog } = await import("./farm-watchdog.js");
      registerFarmWatchdog();
      // A good build output is stamped credited only on builds' word, and asked again until it is.
      const { registerOutputCredit } = await import("./output-credit.js");
      registerOutputCredit();
      // Background warmer for the printer file cache — a self-perpetuating queue
      // loop that keeps each printer's file list + thumbnails warm in the DB, so
      // the UI reads warm data and the machine is never hit on a modal open.
      const { registerFileWarmer } = await import("./printer-file-cache.js");
      registerFileWarmer();
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
          { name: "material_pending", type: "boolean" },
          { name: "metadata", type: "object" },
        ],
        exposableFields: ["file_ref", "status", "target_device", "progress", "remote_job_id", "material_pending"],
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
      // Any machine Digital Fabrication follows (a linked device, or one it
      // has sampled): its alarms, its observed use, the tools in it and its
      // spare parts.
      { id: "digifab:care", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Alarms, use and care", presence: true },
      ...FAMILY_PANELS,
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
      "digifab.device.versions_reported",
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
      // A cell's job finished a cycle. Carries { cellId, jobId, cycle, parts,
      // outputPartId }; its parts are already added to the output part.
      "digifab.cell.cycle",
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
      { eventType: "digifab.alarm", label: "A machine raised an alarm", description: "A machine or robot arm raised an alarm: its operators are told at once, its supervisors and then its integrators if no one acknowledges it." },
      ...FAMILY_NOTIFICATIONS,
    ],
    actions: [
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id:"digifab:large-format", changes: "records",label:"Prepare and account for a large-format print",scope:"workspace",group:"more",userInvokable:false,
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
        // UI-SCREEN: /machines/:id
        id: "digifab:instrument", changes: "records",label:"Read a bench instrument",scope:"workspace",group:"more",userInvokable:false,
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
        id:"digifab:discover-esphome", changes: "records",label:"Find ESPHome bench devices",scope:"workspace",group:"more",userInvokable:false,
        // ADMIN-ONLY: the page's GET /bench/discover is owner or admin (bench.ts): finding devices on the network is setting up a station
        runBy: "admin",
        description:"Discover ESPHome devices through the selected bridge's mDNS without returning device credentials.",invokeHandler:"digifab.discover-esphome",effect:"none",undoable:false,
        argsSchema:{bridge:{label:"Bridge",type:"text"}},
      },
      {
        // UI-SCREEN: /machines/:id
        id:"digifab:instrument-control", changes: "records",label:"Change a bench supply",scope:"workspace",group:"more",userInvokable:false,
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
        id:"digifab:instrument-stop", changes: "records",label:"Turn instrument output off",scope:"workspace",group:"more",userInvokable:false,
        runBy: "member",
        description:"Turn the supply output off and require read-back. Never waits for confirmation.",invokeHandler:"digifab.instrument-stop",effect:"stops",undoable:false,
        argsSchema:{machine_id:{label:"Machine",type:"text",required:true}},
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        // Stop is its own action, and it never waits for a yes (#5091).
        group: "more", id: "digifab:stop", changes: "records", label: "Stop a machine", scope: "workspace", userInvokable: false,
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
        group: "more", id: "digifab:revoke-station", changes: "workspace", label: "Take a station's Start away", scope: "workspace", userInvokable: false,
        // ADMIN-ONLY: the page's own routes gate on this action's own id, owner or admin (stations.ts, embroidery.ts)
        runBy: "admin",
        description: "Take a station screen's permission to start jobs away, by the station's name. The screen can no longer start a job; nothing already running is stopped. Requires an admin. Asks the person first.",
        examples: ["kick that tablet off the laser station", "the shop tablet should not start jobs any more"],
        invokeHandler: "digifab.revoke-station", effect: "writes", undoable: false,
        argsSchema: { station: { label: "Station", type: "text", required: true } },
      },
      {
        // UI-SCREEN: /station/machine/:connectionId/:deviceId
        id: "digifab:station-run", changes: "records", label: "Record a station job's run", group: "more", scope: "workspace", userInvokable: false,
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
        // The one door a job reaches a machine by: the page's Send button and
        // this action run the same send (api/jobs.ts sendAndWatch). It starts
        // a physical machine, so a person's yes stands in front of it from
        // every door, not only the page's dialog (Services §9, §14.3).
        group: "more",
        id: "digifab:send",
        changes: "records",
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
        changes: "records",
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
        // DEPRECATED ALIAS. The actuator moved to core-devices (general device
        // I/O, not fabrication). This thin alias delegates to
        // core-devices:run-command so wires in ALREADY-INSTALLED bundles keep
        // working; new bundles should use core-devices:run-command.
        // NO-PHRASING: a deprecated alias kept so installed wires keep working; phrasings here would compete with core-devices:run-command
        group: "more",
        id: "digifab:run-command",
        changes: "records",
        // ADMIN-ONLY: sends a command to a physical machine; no page route admits a member to do that
        runBy: "admin",
        label: "Run a device command (deprecated → core-devices:run-command)",
        description:
          "Deprecated alias of core-devices:run-command, kept so installed bundle wires keep working. Fires a parameterized command-and-forget at a connected actuator via platform().devices. New wires should target core-devices:run-command.",
        appliesTo: { traits: ["physical"] },
        invokeHandler: "digifab.run-command",
        userInvokable: false,
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:prioritize-job",
        changes: "records",
        // ADMIN-ONLY: the page's own route PATCH /jobs/:id is owner or admin
        runBy: "admin",
        undoable: true,
        examples: ["put the bracket job first", "let the spacer job retry three times"],
        label: "Move a job up or down the queue",
        description: "Change a queued job's priority (0 to 100, higher goes first) or how many times it may be tried. A pool job is re-sorted at once. Nothing is sent to a machine.",
        scope: "workspace",
        invokeHandler: "digifab.prioritize-job",
        userInvokable: true,
        argsSchema: {
          job: { label: "Which job (its file name or id)", type: "text", required: true },
          priority: { label: "Priority, 0 to 100 (higher goes first)", type: "number" },
          max_attempts: { label: "How many tries, 1 to 10", type: "number" },
        },
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:refresh-job",
        changes: "records",
        // ADMIN-ONLY: the page's own route POST /jobs/:id/poll is owner or admin
        runBy: "admin",
        examples: ["what is the Mk4 job doing now"],
        label: "Refresh a job's status",
        description: "Ask the printer for a sent job's state now instead of waiting for the next check. Reads only; it never starts or stops anything.",
        scope: "workspace",
        invokeHandler: "digifab.refresh-job",
        userInvokable: true,
        argsSchema: {
          job: { label: "Which job (its file name or id)", type: "text", required: true },
        },
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:delete-job",
        changes: "records",
        // ADMIN-ONLY: the page's own route DELETE /jobs/:id is owner or admin
        runBy: "admin",
        examples: ["clear the failed spacer job"],
        label: "Delete a job",
        description: "Remove a queued, finished, failed or cancelled job from the queue. A job that may still be on a printer has to be stopped first.",
        scope: "workspace",
        invokeHandler: "digifab.delete-job",
        userInvokable: true,
        argsSchema: {
          job: { label: "Which job (its file name or id)", type: "text", required: true },
        },
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:rename-print-file",
        changes: "records",
        // ADMIN-ONLY: the page's own route PATCH /library/:id is owner or admin
        runBy: "admin",
        undoable: true,
        examples: ["rename bracket_v3.3mf to Shelf bracket"],
        label: "Rename a print file",
        description: "Rename a file in the print library or change its notes. A laser layout's material is changed in its plan, not here.",
        scope: "workspace",
        invokeHandler: "digifab.rename-print-file",
        userInvokable: true,
        argsSchema: {
          file: { label: "Which file (its name)", type: "text", required: true },
          name: { label: "Its new name", type: "text" },
          notes: { label: "Notes", type: "text" },
        },
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:delete-print-file",
        changes: "records",
        // ADMIN-ONLY: the page's own route DELETE /library/:id is owner or admin
        runBy: "admin",
        examples: ["delete the old bracket file from the library"],
        label: "Delete a print file",
        description: "Delete a file from the print library. A laser layout's generated project, or a drawing a saved layout uses, is kept.",
        scope: "workspace",
        invokeHandler: "digifab.delete-print-file",
        userInvokable: true,
        argsSchema: {
          file: { label: "Which file (its name)", type: "text", required: true },
        },
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:make-pool",
        changes: "records",
        // ADMIN-ONLY: the page's own route POST /pools is owner or admin
        runBy: "admin",
        undoable: true,
        examples: ["make a pool called PLA farm"],
        label: "Make a printer pool",
        description: "Make an empty printer pool by name, to queue jobs onto later. Adding printers to it stays at the pool's page, because the queue then sends jobs to them by itself.",
        scope: "workspace",
        invokeHandler: "digifab.make-pool",
        userInvokable: true,
        argsSchema: {
          name: { label: "What to call the pool", type: "text", required: true },
        },
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:remove-pool",
        changes: "records",
        // ADMIN-ONLY: the page's own route DELETE /pools/:id is owner or admin
        runBy: "admin",
        examples: ["remove the old PETG pool"],
        label: "Remove a printer pool",
        description: "Remove a printer pool. Its printers stay; jobs still queued on it wait until a person sends them elsewhere.",
        scope: "workspace",
        invokeHandler: "digifab.remove-pool",
        userInvokable: true,
        argsSchema: {
          pool: { label: "Which pool (its name)", type: "text", required: true },
        },
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:remove-from-pool",
        changes: "records",
        // ADMIN-ONLY: the page's own route DELETE /pools/:id/members/… is owner or admin
        runBy: "admin",
        examples: ["take the Mk4 out of the PLA farm pool"],
        label: "Take a printer out of a pool",
        description: "Take one printer out of a pool, so the queue stops sending that pool's jobs to it.",
        scope: "workspace",
        invokeHandler: "digifab.remove-from-pool",
        userInvokable: true,
        argsSchema: {
          pool: { label: "Which pool (its name)", type: "text", required: true },
          connection_id: { label: "Connection", type: "text", required: true },
          device_id: { label: "Device", type: "text", required: true },
        },
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:hold-run",
        changes: "records",
        // ADMIN-ONLY: the page's own route PATCH /runs/:id is owner or admin
        runBy: "admin",
        effect: "stops",
        examples: ["pause the bracket run", "cancel the spacer run"],
        label: "Pause or cancel a production run",
        description: "Pause a production run so no new plates go out, or cancel it and its queued plates. A plate already on a printer finishes. It never resumes a run.",
        scope: "workspace",
        invokeHandler: "digifab.hold-run",
        userInvokable: true,
        argsSchema: {
          run: { label: "Which run (its name)", type: "text", required: true },
          operation: { label: "Pause or cancel", type: "text", required: true, choices: ["pause", "cancel"].map((value) => ({ value, label: value })) },
        },
      },
      {
        group: "make",
        // UI-SCREEN: /digifab
        id: "digifab:arrange-floor",
        changes: "records",
        // ADMIN-ONLY: the page's own route PUT /fleet/layout is owner or admin
        runBy: "admin",
        undoable: true,
        examples: ["put the Bambus in the first row"],
        label: "Arrange the machine floor",
        description: "Set the order the machines show on the floor, and where each row starts. Only how the floor page lays them out; nothing is sent to a machine.",
        scope: "workspace",
        invokeHandler: "digifab.arrange-floor",
        userInvokable: true,
        argsSchema: {
          items: { label: "The machines in order: [{ connection_id, device_id, row_break }]", type: "json", required: true },
          reset: { label: "Clear the order instead (true), as Undo does for a floor that had none", type: "boolean" },
        },
      },
      {
        group: "more",
        // UI-SCREEN: /digifab
        id: "digifab:test-connection",
        changes: "records",
        // ADMIN-ONLY: the page's own route POST /connections/:id/test is owner or admin (connections.ts)
        runBy: "admin",
        examples: ["is the OctoPrint connection still working", "check the Duet link"],
        label: "Test a machine connection",
        description: "Check that a machine manager (OctoPrint, Duet, Klipper, a Bambu account, a bridge) still answers with the credentials stored for it, and say what it found. The credentials are never shown; nothing is sent to a machine.",
        scope: "workspace",
        invokeHandler: "digifab.test-connection",
        userInvokable: true,
        argsSchema: {
          connection: { label: "Which connection (its name)", type: "text", required: true },
        },
      },
      ...FAMILY_ACTIONS,
      {
        // UI-SCREEN: /machines
        group: "service",
        id: "digifab:alarm-ack",
        changes: "records",
        runBy: "member",
        examples: ["I have the alarm on arm 2", "acknowledge the printer fault"],
        label: "Acknowledge a machine alarm",
        description: "Say you have a machine's alarm, so no one further is told: its supervisors and integrators are not called. Requires a member. It changes nothing on the machine. Args: alarm_id, note.",
        scope: "workspace",
        invokeHandler: "digifab.alarm-ack",
        userInvokable: false,
        effect: "writes",
        argsSchema: {
          alarm_id: { label: "Alarm id", type: "text", required: true },
          note: { label: "What you are doing about it", type: "text" },
        },
      },
      {
        // UI-SCREEN: /machines
        group: "service",
        id: "digifab:alarm-escalation",
        changes: "workspace",
        // ADMIN-ONLY: who is called about every machine's alarms is the admin tier's, on the page (POST /care/alarm-escalation) and here
        runBy: "admin",
        examples: ["tell Sam first when a machine alarms", "call the integrator after an hour"],
        label: "Set who is told about alarms",
        description: "Choose who hears about machine alarms: the operators at once, the supervisors if no one acknowledges within some minutes, then the integrators. Requires an admin. Args: operators, supervisors, integrators (people), supervisor_after_minutes, integrator_after_minutes.",
        scope: "workspace",
        invokeHandler: "digifab.alarm-escalation",
        userInvokable: false,
        effect: "writes",
        argsSchema: {
          operators: { label: "Operators, told at once (people)", type: "json", required: true },
          supervisors: { label: "Supervisors, told if no one acknowledges (people)", type: "json", required: true },
          integrators: { label: "Integrators, told last (people)", type: "json", required: true },
          supervisor_after_minutes: { label: "Minutes before the supervisors are told", type: "number", required: true },
          integrator_after_minutes: { label: "Minutes before the integrators are told", type: "number", required: true },
        },
      },
      {
        // UI-SCREEN: /digifab
        group: "make",
        id: "digifab:set-machine-hour-rate",
        changes: "workspace",
        // ADMIN-ONLY: an hour rate prices every print the printer makes from then on; it is the shop's costing, set like the printer's other settings by an owner or admin
        runBy: "admin",
        examples: ["Charge 1.50 an hour for the Prusa MK4", "Set the PLA farm pool to 2 dollars a machine hour", "Remove the hourly rate from the Voron"],
        label: "Set a machine-hour rate",
        description: "Sets what an hour of a printer, or of every printer in a pool, costs, so each finished print is priced with its machine time as well as its filament. An empty rate removes it.",
        scope: "workspace",
        invokeHandler: "digifab.set-machine-hour-rate",
        userInvokable: true,
        argsSchema: {
          printer: { label: "Printer", type: "text", oneOf: "target" },
          pool: { label: "Pool", type: "text", oneOf: "target" },
          rate: { label: "Cost of an hour (empty removes it)", type: "number" },
          currency: { label: "Currency", type: "text" },
        },
      },
    ],
  },

  subscribes: ["services.job.done", "services.job.failed", "builds.output.credited"],
});
