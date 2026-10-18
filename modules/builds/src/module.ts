// builds — light bill-of-materials / assembly for the maker track.
//
// A Build is a recipe: a parent + component lines, each pointing at an inventory
// part + a per-build quantity. The distinctive features: "how many can I build
// right now, and what's the limiting component?" + "build one" consumes the
// components from stock. Consumes inventory ONLY through the inventory API
// (the inventory:adjust-stock action), never a join — cross-module isolation.
//
// Tier 2 = nested sub-assemblies: a component line can be another build, and the
// engine explodes the BoM down to leaf inventory parts. Plus routing: an ordered
// list of operations (steps) per build. A "Maker Workshop" bundle pre-wires
// builds + inventory + purchasing + projects. Strategy: business-models/docs/15
// (operations) + 22 (manufacturing depth ladder — rungs 4+5). Yardsticks:
// docs/design-decisions/pcb-assembly-use-case.md + the maker flagship.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "builds",
  version: "0.2.0",
  displayName: "Builds",
  description:
    "Describe what you make as a recipe of parts, see how many you could build right now and what runs out first, and take the parts from stock when you build one.",
  icon: "hammer",
  band: "stock",
  autoEnable: false,

  schema: {
    tablePrefix: "builds_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],
  operatesOn: ["projects", "inventory", "purchases"],

  provides: {
    entityKinds: [
      {
        // AI-CRUD: inspection evidence is created and revised through inspect-board at an authorized station; deletion would remove trace evidence.
        id: "builds:inspection", displayName: "Board inspection", displayNamePlural: "Board inspections", icon: "clipboard-check", profile: "digital-record", detailRoute: "/builds/inspections/{id}", getEndpoint: "/assembly-inspections/{id}",
        fields: [{ name: "name", type: "text", role: "title", required: true }, { name: "status", type: "text" }, { name: "serial_code", type: "text", fieldRole: "identifier" }, { name: "ordinal", type: "number" }, { name: "order_id", type: "text" }, { name: "metadata", type: "object" }], exposableFields: ["name", "status", "serial_code", "ordinal", "order_id", "metadata"],
      },
      {
        // AI-CRUD: native assembly actions create and advance these planned work orders; generic edits cannot replace their workflow.
        id: "builds:work-order", displayName: "Assembly work order", displayNamePlural: "Assembly work orders", icon: "clipboard-list", profile: "digital-record", getEndpoint: "/assembly-orders/{id}",
        fields: [{ name: "name", type: "text", role: "title", required: true }, { name: "state", type: "text" }, { name: "assembly_finish_proof", type: "object", readOnly: true }], exposableFields: ["name", "state", "assembly_finish_proof"],
      },
      {
        id: "builds:build",
        createEndpoint: "/builds",
        updateEndpoint: "/builds/{id}",
        deleteEndpoint: "/builds/{id}",
        displayName: "Build",
        displayNamePlural: "Builds",
        icon: "hammer",
        profile: "digital-record",
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "description", type: "text", role: "summary" },
          { name: "notes", type: "text" },
          { name: "metadata", type: "object" },
        ],
        // A bundle's own fields ride in `metadata`, readable like a part's,
        // so a view or a label naming one prints its value.
        exposableFields: ["name", "description", "notes", "metadata"],
        detailRoute: "/builds/{id}",
        getEndpoint: "/builds/{id}",
      },
    ],
  },

  exposes: {
    events: [
      "builds.build.created",
      // Fired when a build is recorded (components consumed). Carries build_id +
      // qty_built so a wire can react (e.g. mark a linked task done).
      "builds.build.completed",
      // The undo: a recorded build was reversed (components returned, output
      // credit removed) — a scrapped/failed fabrication run.
      "builds.build.reversed",
      // A fabrication job's good output is in stock (applied now, or found
      // applied before): { jobId, buildId, made }. What marks the job credited.
      "builds.output.credited",
      // Fired when a target build count can't be met — carries the per-component
      // shortfall. Wire it to a purchasing shopping list to auto-restock.
      "builds.shortfall.detected",
      // An operation (routing step) was added to a build.
      "builds.operation.created",
      // An operation crossed into 'done'. Carries build_id + operation_id + name
      // so a wire can react (e.g. mark a linked task done, notify on last step).
      "builds.operation.completed",
      // Shop-floor execution (rung 6): time logged against an operation.
      "builds.operation.time_logged",
      // Scrap recorded at an operation — carries quantity + reason. Wire it to a
      // notification or (later) a quality log.
      "builds.operation.scrapped",
      // Scheduling (rung 7): a planned production order was added.
      "builds.planned.created",
      // A planned order crossed into 'done' — wire to mark a task done / notify.
      "builds.planned.completed",
    ],
    actions: [
      // UI-SCREEN: /builds/inspections/:id displays and edits its additional fields.
      {
        id: "builds:update-inspection-metadata",
        changes: "records",
        runBy: "member",
        examples: ["change this board inspection field"],
        group: "make", label: "Edit board inspection fields", description: "Edit additional fields while preserving the captured inspection evidence.", scope: "workspace", invokeHandler: "builds.update-inspection-metadata", userInvokable: true, argsSchema: { inspection_id: { label: "Inspection id", type: "text", required: true }, metadata: { label: "Additional fields", type: "json", required: true } },
      },
      // UI-SCREEN: /station/inspection/<machineId>/<orderId> records board evidence and the tested-stock handoff.
      {
        id: "builds:inspection-resources",
        changes: "records",
        runBy: "member",
        examples: ["inspection resources"],
        group: "make", label: "Read board inspections", description: "Read the native inspection bench, per-board evidence and full batch counts.", scope: "workspace", invokeHandler: "builds.inspection-resources", userInvokable: true, argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, ordinal: {label: "Board number", type: "number"}}},
      // UI-SCREEN: /station/inspection/<machineId>/<orderId> records board evidence and the tested-stock handoff.
      {
        id: "builds:inspection",
        changes: "records",
        runBy: "member",
        examples: ["inspection"],
        group: "make", label: "Read a board inspection", description: "Read the front and back photos, decisions, rework history and batch material trace.", scope: "workspace", invokeHandler: "builds.inspection", userInvokable: true, argsSchema: {inspection_id: {label: "Inspection id", type: "text", required: true}}},
      // UI-SCREEN: /station/inspection/<machineId>/<orderId> records board evidence and the tested-stock handoff.
      {
        id: "builds:assembly-recall",
        changes: "records",
        runBy: "member",
        examples: ["assembly recall"],
        group: "make", label: "Find boards by reel or paste lot", description: "Find finished board batches by an exact captured reel id or material lot code.", scope: "workspace", invokeHandler: "builds.assembly-recall", userInvokable: true, argsSchema: {code: {label: "Reel id or lot code", type: "text", required: true}}},
      // UI-SCREEN: /station/inspection/<machineId>/<orderId> records board evidence and the tested-stock handoff.
      {
        id: "builds:prepare-inspection",
        changes: "records",
        runBy: "member",
        examples: ["prepare inspection"],
        group: "make", label: "Prepare board inspection", description: "Choose an available native inspection bench for a reflowed batch.", scope: "workspace", invokeHandler: "builds.prepare-inspection", userInvokable: true, argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, machine_kind: {label: "Bench collection kind", type: "text", required: true}, machine_id: {label: "Bench id", type: "text", required: true}}},
      // UI-SCREEN: /station/inspection/<machineId>/<orderId> records board evidence and the tested-stock handoff.
      {
        id: "builds:inspect-board",
        changes: "records",
        runBy: "member",
        examples: ["inspect board"],
        group: "make", label: "Record a board inspection", description: "At the authorized bench, keep front and back photos, pass or fail, defect tags, optional serial and rework notes. Earlier evidence is retained.", scope: "workspace", invokeHandler: "builds.inspect-board", userInvokable: true, argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, station_token: {label: "Authorized station credential", type: "text", required: true}, ordinal: {label: "Board number", type: "number", required: true}, revision: {label: "Current inspection revision or zero", type: "number", required: true}, status: {label: "pass or fail", type: "text", required: true}, front_file_id: {label: "Front photo file id", type: "text", required: true}, back_file_id: {label: "Back photo file id", type: "text", required: true}, defects: {label: "bridge, tombstone, missing, polarity or other", type: "json", required: true}, notes: {label: "Inspection and rework notes", type: "text"}, serial_code: {label: "Optional board serial", type: "text"}, confirmed_tested: {label: "The board was inspected and tested", type: "boolean", required: true}}},
      // UI-SCREEN: /station/inspection/<machineId>/<orderId> records board evidence and the tested-stock handoff.
      {
        id: "builds:finish-assembly",
        changes: "records",
        runBy: "member",
        examples: ["finish assembly"],
        group: "make", label: "Finish the inspected batch", description: "Confirm every board was inspected. Only passed boards become tested count stock, once, with their captured material and process trace.", scope: "workspace", invokeHandler: "builds.finish-assembly", userInvokable: true, argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, station_token: {label: "Authorized station credential", type: "text", required: true}, confirmed_all_boards: {label: "Every board has an inspection decision", type: "boolean", required: true}}},
      // UI-SCREEN: /station/reflow/<machineId>/<orderId> and its work order prepare and record this oven run.
      {runBy: "member", id: "builds:reflow-resources", changes: "records", group: "make", label: "Read ovens and paste profiles", description: "Read native ovens, bridge connections and immutable profiles for the paste used on this work order.", scope: "workspace", invokeHandler: "builds.reflow-resources", userInvokable: true, argsSchema: {order_id: {label: "Work order id", type: "text", required: true}}},
      // UI-SCREEN: /station/reflow/<machineId>/<orderId> and its work order prepare and record this oven run.
      {runBy: "member", id: "builds:prepare-reflow", changes: "records", group: "make", label: "Prepare a paste reflow run", description: "Bind this placed board batch to its paste profile and native oven. A started run cannot change.", scope: "workspace", invokeHandler: "builds.prepare-reflow", userInvokable: true, argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, profile_id: {label: "Paste profile id", type: "text", required: true}, machine_kind: {label: "Machine kind", type: "text", required: true}, machine_id: {label: "Oven id", type: "text", required: true}, model: {label: "manual, controleo3, t962-ue or yarc", type: "text", required: true}, connection_id: {label: "Bridge connection id", type: "text"}, slot: {label: "Verified firmware profile slot", type: "number"}, controller_name: {label: "Exact firmware profile name", type: "text"}, confirmed_profile_matches: {label: "The oven profile matches the paste profile", type: "boolean", required: true}}},
      // UI-SCREEN: /station/reflow/<machineId>/<orderId> and its work order prepare and record this oven run.
      {runBy: "member", id: "builds:send-reflow-profile", changes: "records", group: "make", label: "Send or confirm the oven profile", description: "At the authorized oven station, select the verified T-962 slot, upload YARC data or confirm the local oven profile.", scope: "workspace", invokeHandler: "builds.send-reflow-profile", userInvokable: true, argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, station_token: {label: "Authorized station credential", type: "text", required: true}}},
      // UI-SCREEN: /station/reflow/<machineId>/<orderId> and its work order prepare and record this oven run.
      {runBy: "member", id: "builds:start-reflow", changes: "records", group: "make", label: "Start reflow at its station", description: "Record Start once at the authorized oven screen. T-962 receives one heat command; YARC starts physically at the oven with bridge monitoring.", scope: "workspace", invokeHandler: "builds.start-reflow", userInvokable: false, effect: "physical", argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, station_token: {label: "Authorized station credential", type: "text", required: true}, confirmed_all_boards: {label: "Every board is loaded or completed at this oven", type: "boolean", required: true}}},
      // UI-SCREEN: /station/reflow/<machineId>/<orderId> and its work order prepare and record this oven run.
      {runBy: "member", id: "builds:sample-reflow", changes: "records", group: "make", label: "Record the oven temperature curve", description: "Read the bridge temperature samples for this run and preserve every earlier observation.", scope: "workspace", invokeHandler: "builds.sample-reflow", userInvokable: true, argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, station_token: {label: "Authorized station credential", type: "text", required: true}}},
      // UI-SCREEN: /station/reflow/<machineId>/<orderId> and its work order prepare and record this oven run.
      {runBy: "member", id: "builds:finish-reflow", changes: "records", group: "make", label: "Record completed reflow", description: "Record the actual temperature curve or manual peak, duration and time above liquidus. Manufacturer limit violations stay flagged for inspection.", scope: "workspace", invokeHandler: "builds.finish-reflow", userInvokable: true, argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, station_token: {label: "Authorized station credential", type: "text", required: true}, confirmed_all_boards: {label: "Every board is loaded or completed at this oven", type: "boolean", required: true}, source: {label: "controller, manual or manual-recovery", type: "text", required: true}, peak_c: {label: "Measured peak Celsius", type: "number"}, duration_s: {label: "Measured total seconds", type: "number"}, above_liquidus_s: {label: "Measured seconds above liquidus", type: "number"}, notes: {label: "Run notes or controller recovery explanation", type: "text"}}},
      // UI-SCREEN: /station/reflow/<machineId>/<orderId> and its work order prepare and record this oven run.
      {runBy: "member", id: "builds:stop-reflow", changes: "records", group: "make", label: "Stop reflow at its station", description: "Stop the open T-962 controller or confirm the oven was stopped locally. Keep its interrupted run and temperature history.", scope: "workspace", invokeHandler: "builds.stop-reflow", userInvokable: false, effect: "physical", argsSchema: {order_id: {label: "Work order id", type: "text", required: true}, station_token: {label: "Authorized station credential", type: "text", required: true}, confirmed_all_boards: {label: "Every board is loaded or completed at this oven", type: "boolean", required: true}}},
      {
        // UI-SCREEN: /builds/<revision> lists machines and paste jars for assembly.
        id: "builds:placement-resources", changes: "records", group: "make", label: "Read assembly machines", description: "List native Machines records with their package calibrations and available paste jars.", scope: "workspace" as const, invokeHandler: "builds.placement-resources", userInvokable: true,
        runBy: "member",
      },
      {
        // UI-SCREEN: /builds/<revision> exports its prepared placement program.
        id: "builds:placement-program", changes: "records", group: "make", label: "Export a placement program", description: "Read the immutable placement files and feeder map prepared for an assembly work order. Vendor files are loaded and run at the machine.", scope: "workspace" as const, invokeHandler: "builds.placement-program", userInvokable: true,
        runBy: "member",
        argsSchema: { order_id: { label: "Work order id", type: "text", required: true } },
      },
      {
        // UI-SCREEN: /builds/<revision> saves verified package settings on a native machine.
        id: "builds:configure-placement-machine", changes: "records", group: "make", label: "Save placement calibration", description: "Save the operator-verified rotation, offsets, height and nozzle settings for each package on a native machine, with its measured work area.", scope: "workspace" as const, invokeHandler: "builds.configure-placement-machine", userInvokable: true,
        // ADMIN-ONLY: calibration is machine setup; a wrong rotation or offset misplaces every later board, and a member has no say over configuration
        runBy: "admin",
        argsSchema: { machine_kind: { label: "Machine kind", type: "text", required: true }, machine_id: { label: "Machine id", type: "text", required: true }, model: { label: "openpnp, neoden4, neoden-yy1, neoden-k1830, charmhigh-t48vb or charmhigh-t36va", type: "text", required: true }, packages: { label: "Verified package calibrations", type: "json", required: true }, work_area_width_mm: { label: "Work area width mm", type: "number", required: true }, work_area_height_mm: { label: "Work area height mm", type: "number", required: true } },
      },
      {
        // UI-SCREEN: /builds/<revision> records a reviewed paste application against the linked stencil.
        id: "builds:apply-assembly-paste", changes: "records", group: "make", label: "Record paste application", description: "Consume usable liquid paste once for a released work order and capture its jar, lot, amount and linked stencil. A lost reply recovers the original application.", scope: "workspace" as const, invokeHandler: "builds.apply-assembly-paste", userInvokable: true,
        runBy: "member",
        argsSchema: { order_id: { label: "Work order id", type: "text", required: true }, part_id: { label: "Paste jar id", type: "text", required: true }, kind: { label: "Paste collection kind", type: "text", required: true }, amount_ml: { label: "Paste applied in ml", type: "number", required: true }, confirmed_applied: { label: "The linked stencil and this jar were used for every board", type: "boolean", required: true } },
      },
      {
        // UI-SCREEN: /builds/<revision> binds calibrated placements and feeder slots to its kit.
        id: "builds:prepare-placement", changes: "records", group: "make", label: "Prepare a placement job", description: "Snapshot a machine's verified calibration, board geometry and exact reel-to-slot map against a released kit. A started program cannot be replaced.", scope: "workspace" as const, invokeHandler: "builds.prepare-placement", userInvokable: true,
        runBy: "member",
        argsSchema: { order_id: { label: "Work order id", type: "text", required: true }, machine_kind: { label: "Machine kind", type: "text", required: true }, machine_id: { label: "Machine id", type: "text", required: true }, geometry: { label: "PCB dimensions, origins and panel layout in mm", type: "json", required: true }, slots: { label: "Reel id to feeder slot map", type: "json", required: true } },
      },
      {
        // UI-SCREEN: /station/assembly/<machineId>/<orderId> scans a reel at its exact feeder slot.
        id: "builds:verify-feeder", changes: "records", group: "make", label: "Verify a feeder reel", description: "An authorized station scans the exact Cobblr reel QR at a slot in the prepared job. A wrong reel, expired MSL or revoked station is refused.", scope: "workspace" as const, invokeHandler: "builds.verify-feeder", userInvokable: true,
        runBy: "member",
        argsSchema: { order_id: { label: "Work order id", type: "text", required: true }, station_token: { label: "Authorized station credential", type: "text", required: true }, slot: { label: "Feeder slot", type: "text", required: true }, code: { label: "Scanned reel QR", type: "text", required: true } },
      },
      {
        // UI-SCREEN: /station/assembly/<machineId>/<orderId> starts a reviewed side at its authorized station.
        id: "builds:start-placement", changes: "records", group: "make", label: "Start placement", description: "Record the start of a prepared side after station authorization, every feeder scan, fresh MSL and paste readiness. Physically load and run vendor files at the machine; OpenPnP events can report the same start.", scope: "workspace" as const, invokeHandler: "builds.start-placement", userInvokable: false, effect: "physical",
        runBy: "member",
        argsSchema: { order_id: { label: "Work order id", type: "text", required: true }, station_token: { label: "Authorized station credential", type: "text", required: true }, side: { label: "top or bottom", type: "text", required: true }, source: { label: "manual or openpnp", type: "text", required: true }, coverage_hash: { label: "OpenPnP observed placement and board layout hash", type: "text" }, confirmed_all_boards: { label: "Every board is loaded and the machine is clear", type: "boolean", required: true } },
      },
      {
        // UI-SCREEN: /station/assembly/<machineId>/<orderId> records complete sides and the final physical stock draw.
        id: "builds:finish-placement", changes: "records", group: "make", label: "Finish placement", description: "Confirm every board completed this side. Once all required sides finish, consume the native kit including attrition and create placed-board stock atomically. OpenPnP completion must match every exported placement.", scope: "workspace" as const, invokeHandler: "builds.finish-placement", userInvokable: true,
        runBy: "member",
        argsSchema: { order_id: { label: "Work order id", type: "text", required: true }, station_token: { label: "Authorized station credential", type: "text", required: true }, side: { label: "top or bottom", type: "text", required: true }, source: { label: "manual or openpnp", type: "text", required: true }, coverage_hash: { label: "OpenPnP observed completed placement and board layout hash", type: "text" }, confirmed_all_boards: { label: "Every board completed this side", type: "boolean", required: true } },
      },
      {
        // UI-SCREEN: /instances/board-projects/:id reads through GET board-project to avoid refreshing its own query.
        id: "builds:board-project", changes: "records", group: "make", label: "Board revisions", description: "Read the board revisions belonging to a project. Changes nothing.",
        runBy: "member",
        examples: ["show this board\u2019s revisions"], scope: "workspace" as const, invokeHandler: "builds.board-project", userInvokable: true,
        argsSchema: {
          project_id: { label: "Project id", type: "text", required: true },
          project_kind: { label: "Project collection kind", type: "text", required: true },
        },
      },
      {
        id: "builds:save-board-revision", changes: "records", group: "make", label: "Import a board revision", description: "Import populated BOM and centroid CSV or KiCad position data as an immutable board revision. Units and bottom mirroring are confirmed explicitly. A changed file needs a new revision name.",
        runBy: "member",
        examples: ["import this KiCad board", "add rev B to this board"], scope: "workspace" as const, invokeHandler: "builds.save-board-revision", userInvokable: true,
        argsSchema: {
          project_id: { label: "Project id", type: "text", required: true },
          project_kind: { label: "Project collection kind", type: "text", required: true },
          revision: { label: "Revision name", type: "text", required: true },
          bom: { label: "BOM CSV text", type: "text", required: true },
          positions: { label: "Centroid text", type: "text", required: true },
          format: { label: "kicad, altium or eagle", type: "text", required: true },
          units: { label: "mm or in", type: "text", required: true },
          bottom_x_mirrored: { label: "The exported bottom X coordinates are mirrored", type: "boolean", required: true },
          mapping: { label: "Confirmed column headings by ref, value, package, mpn, manufacturer, x, y, rotation, side", type: "json" },
          notes: { label: "Revision notes", type: "text" },
        },
      },
      {
        id: "builds:create-assembly-order", changes: "records", group: "make", label: "Create assembly work order", description: "Plan a whole board quantity for an immutable revision. A request key makes retries safe. Reserve its kit and check fresh stock and moisture before release.",
        runBy: "member",
        scope: "workspace" as const, invokeHandler: "builds.create-assembly-order", userInvokable: true,
        argsSchema: {
          build_id: { label: "Board revision id", type: "text", required: true },
          boards: { label: "Whole board quantity", type: "number", required: true },
          request_key: { label: "Stable request key", type: "text", required: true },
          notes: { label: "Order notes", type: "text" },
        },
      },
      {
        // UI-SCREEN: /builds/<revision> lists work orders through the shared GET assembly-orders reader.
        id: "builds:assembly-orders", changes: "records", group: "make", label: "List assembly work orders", description: "List a board revision's native assembly work orders, quantities and current kit states. Changes nothing.",
        runBy: "member",
        scope: "workspace" as const, invokeHandler: "builds.assembly-orders", userInvokable: true,
        argsSchema: { build_id: { label: "Board revision id", type: "text", required: true } },
      },
      {
        // UI-SCREEN: /builds/<revision> reads this order and its kit through GET assembly-orders/:id.
        id: "builds:assembly-order", changes: "records", group: "make", label: "Read assembly kit", description: "Read a work order and its kit sorted by location, with fresh quantity and moisture readiness. Changes nothing.",
        runBy: "member",
        scope: "workspace" as const, invokeHandler: "builds.assembly-order", userInvokable: true,
        argsSchema: { order_id: { label: "Assembly work order id", type: "text", required: true } },
      },
      {
        id: "builds:change-assembly-order", changes: "records", group: "make", label: "Kit or release assembly order", description: "Reserve the entire component and blank-board kit, recheck stock and moisture before release, or cancel an unused order and return all reservations. Release does not start a machine.",
        runBy: "member",
        scope: "workspace" as const, invokeHandler: "builds.change-assembly-order", userInvokable: true,
        argsSchema: {
          order_id: { label: "Assembly work order id", type: "text", required: true },
          operation: { label: "kit, release or cancel", type: "text", required: true },
        },
      },
      {
        id: "builds:check-board-stock", changes: "records", group: "make", label: "Check board stock", description: "Check N boards against usable package stock, reservations, moisture clocks and placement attrition. Return a shortage and picks by location. Changes nothing.",
        runBy: "member",
        examples: ["do we have parts for fifty boards"], scope: "workspace" as const, invokeHandler: "builds.check-board-stock", userInvokable: true,
        argsSchema: {
          build_id: { label: "Board revision id", type: "text", required: true },
          boards: { label: "How many boards", type: "number", required: true },
        },
      },
      {
        id: "builds:board-cart", changes: "records", group: "make", label: "Export shortage cart", description: "Export the current component shortage as a distributor BOM-upload CSV. Upload and confirm the column mapping at the distributor. No order is submitted.",
        runBy: "member",
        examples: ["export these shortages for Mouser"], scope: "workspace" as const, invokeHandler: "builds.board-cart", userInvokable: true,
        argsSchema: {
          build_id: { label: "Board revision id", type: "text", required: true },
          boards: { label: "How many boards", type: "number", required: true },
          distributor: { label: "digikey, mouser or lcsc", type: "text", required: true },
        },
      },
      {
        id: "builds:order-blank-boards", changes: "records", group: "make", label: "Track a fabrication order", description: "Record a planned JLCPCB, PCBWay or OSH Park purchase, attached fab zip, expected date and tracking. On arrival the blank board count increases through normal purchase receiving. Place the order on the fab\u2019s site.",
        grantedAs: "inventory:create-part",
        examples: ["track this blank PCB order"], scope: "workspace" as const, invokeHandler: "builds.order-blank-boards", userInvokable: true,
        argsSchema: {
          build_id: { label: "Board revision id", type: "text", required: true },
          vendor: { label: "JLCPCB, PCBWay or OSH Park", type: "text", required: true },
          qty: { label: "Blank boards ordered", type: "number", required: true },
          request_key: { label: "Stable order request key", type: "text", required: true },
          source_file_id: { label: "Uploaded fabrication zip", type: "text", required: true },
          expected_arrival: { label: "Expected date", type: "text" },
          tracking_number: { label: "Tracking number", type: "text" },
        },
      },
      {
        id: "builds:link-board-stencil", changes: "records", group: "make", label: "Record revision stencil", description: "Link stock of a framed or frameless stencil to a board revision, or create its stock record. Keep its received count on the stock page.",
        grantedAs: "inventory:create-part",
        examples: ["link this framed stencil to rev B"], scope: "workspace" as const, invokeHandler: "builds.link-board-stencil", userInvokable: true,
        argsSchema: {
          build_id: { label: "Board revision id", type: "text", required: true },
          style: { label: "framed or frameless", type: "text", required: true },
          part_id: { label: "Existing stencil stock id", type: "text" },
        },
      },
      {
        group: "make",
        id: "builds:build-one",
        changes: "records",
        runBy: "member",
        examples: ["built one of those", "make two of these"],
        undoable: true,
        label: "Build one",
        description:
          "Record building N of a build: decrement each component from inventory stock (via inventory:adjust-stock), log a build run, and (if the build has an output part) increment that. Generic capability; a bundle/app composes it. Args: { build_id, qty? }.",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.build-one",
        userInvokable: true,
        argsSchema: {
          build_id: { label: "Build id", type: "text" },
          qty: { label: "How many to build", type: "number" },
        },
      },
      {
        // NO-PHRASING: a wire target the good print verdict fires; nobody asks for it by name
        group: "make",
        id: "builds:credit-output",
        changes: "records",
        runBy: "member",
        label: "Count a build's output as made",
        description:
          "Add a build's output part to stock for N builds that came out good. The second half of builds:build-one when a fabrication job defers its output to the good verdict (a failed or scrapped print adds nothing). Args: { build_id, qty? }.",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.credit-output",
        argsSchema: {
          build_id: { label: "Which build made the output, defaults to the record this ran on", type: "text" },
          qty: { label: "How many builds came out good, defaults to 1", type: "number" },
        },
        userInvokable: false,
      },
      {
        // NO-PHRASING: a wire target the print verdict fires; nobody asks for it by name
        group: "make",
        id: "builds:record-yield",
        changes: "records",
        runBy: "member",
        label: "Record a print's good and scrap",
        description:
          "Write a judged print's counts (good, scrap) into the build's quantity log, so the build and its work orders read one yield. Fired by digifab.job.outcome; counts once per job. Args: none (reads the event).",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.record-yield",
        argsSchema: {},
        userInvokable: false,
        wireOnly: true,
      },
      {
        // NO-PHRASING: the door behind an order line's "Make this"; people ask the order, not builds
        // UI-REACH: a sales order line's "Make this" button plans it (sales POST /orders/:id/items/:itemId/make)
        group: "make",
        id: "builds:plan-for",
        changes: "records",
        runBy: "member",
        label: "Plan a work order for a part",
        description:
          "Plan the build that makes a part, for a record in another module (a sales order): a work order of qty, which closes by itself when that many good ones have been counted. Refuses when no build makes the part. Asking again for the same record sets the qty. Args: { part_id, qty, source_kind?, source_id?, due_date? }.",
        scope: "workspace" as const,
        invokeHandler: "builds.plan-for",
        argsSchema: {
          part_id: { label: "The part to make", type: "text", required: true },
          qty: { label: "How many", type: "number", required: true },
          source_kind: { label: "The kind of record it is made for", type: "text" },
          source_id: { label: "The record it is made for", type: "text" },
          due_date: { label: "When it is due, ISO date", type: "text" },
        },
        userInvokable: false,
      },
      {
        // NO-PHRASING: a read another module makes of its own work orders; nobody asks for it by name
        // UI-REACH: a sales order's lines show what is being made for them and how many are made (sales GET /orders/:id)
        group: "make",
        id: "builds:work-orders-for",
        changes: "records",
        runBy: "member",
        label: "Work orders made for a record",
        description:
          "The work orders planned for one record, each with its build, qty, how many are made (good parts, handed out oldest order first) and whether it is done. Changes nothing. Args: { source_kind, source_id }.",
        scope: "workspace" as const,
        invokeHandler: "builds.work-orders-for",
        argsSchema: {
          source_kind: { label: "The kind of record", type: "text", required: true },
          source_id: { label: "The record", type: "text", required: true },
        },
        userInvokable: false,
      },
      {
        group: "make",
        id: "builds:reverse-one",
        changes: "records",
        runBy: "member",
        examples: ["that build failed", "undo the last build"],
        undoable: true,
        label: "Reverse a build",
        description:
          "Undo a recorded build of N: put each component back into inventory stock and (if the build has an output part) decrement that. The failure leg of builds:build-one (a scrapped/failed fabrication run). Args: { build_id, qty? }.",
        appliesTo: { kinds: ["builds:build"] },
        invokeHandler: "builds.reverse-one",
        argsSchema: {
          build_id: { label: "Which build to reverse, defaults to the record this ran on", type: "text" },
          qty: { label: "How many to reverse, defaults to 1", type: "number" },
        },
        userInvokable: false,
      },
      {
        // UI-SCREEN: /builds the build's sub-assembly line toggles Use stock first / Always make.
        group: "make",
        id: "builds:set-sub-assembly-source",
        changes: "records",
        runBy: "member",
        examples: ["Always make the controller boards for the printer build", "Use the stocked harnesses first when building the loom"],
        label: "Use stock first or always make",
        description: "Sets whether a build takes a sub-assembly from stock before making more, or always makes it from its parts.",
        scope: "workspace",
        invokeHandler: "builds.set-sub-assembly-source",
        userInvokable: true,
        argsSchema: {
          build: { label: "Build", type: "text", required: true },
          sub_assembly: { label: "Sub-assembly", type: "text", required: true },
          use_stock: { label: "Take it from stock first", type: "boolean", required: true },
        },
      },
    ],
  },

  // A fabrication job that produces this build consumes its components on send
  // (digifab.job.build_committed { buildId, qty }, read by build-one) and
  // counts its output when the plate is judged good (digifab.job.build_output). Belongs to builds: it owns the action. Inert for a
  // workspace without digifab (the event never fires) and for a job with no
  // linked build (the event never fires).
  subscribes: ["digifab.job.build_committed", "digifab.job.build_output", "digifab.job.build_reversed", "digifab.job.outcome"],

  contributes: {
    panels: [{ id: "builds:board-revisions", surface: "entity-detail-panel" as const, target: "projects:project", title: "Board revisions" }],
    wires: [
      {
        source_kind: "digifab:job",
        action_id: "builds:build-one",
        trigger_type: "event",
        trigger_event: "digifab.job.build_committed",
      },
      // The output leg: the plate was judged good, so its output counts as made
      // (#4050). Payload { buildId, qty } is the good count.
      {
        source_kind: "digifab:job",
        action_id: "builds:credit-output",
        trigger_type: "event",
        trigger_event: "digifab.job.build_output",
      },
      // The quality leg: every judged print that produced a build writes its
      // good and scrap into the build's quantity log (#4053), so the plate
      // verdict and the build's own yield are one record, not two.
      {
        source_kind: "digifab:job",
        action_id: "builds:record-yield",
        trigger_type: "event",
        trigger_event: "digifab.job.outcome",
      },
      // The failure leg: a committed build whose job then failed / was cancelled
      // / was scrapped never produced its output — put the components back and
      // remove the output credit. Same payload shape ({ buildId, qty }).
      {
        source_kind: "digifab:job",
        action_id: "builds:reverse-one",
        trigger_type: "event",
        trigger_event: "digifab.job.build_reversed",
      },
    ],
  },
});
