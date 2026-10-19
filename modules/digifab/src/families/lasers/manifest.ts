// What the lasers family declares in Digital Fabrication's manifest: its module
// part and its actions. Data only: src/module.ts spreads it in through
// families/manifests.ts. The part is on everywhere, as lasers were before they
// had a folder of their own.
import type { FamilyManifest } from "../../core/families.js";

export const lasersManifest: FamilyManifest = {
  part: {
    id: "lasers",
    label: "Lasers",
    description: "Lasers as machines: their setup at the station, their own controls, and batches of parts nested onto sheets.",
    default: "on",
    routes: ["/laser", "/cutter"],
  },
  panels: [],
  actions: [
    {
      part: "lasers",
      // UI-SCREEN: /station/machine/:connectionId/:deviceId
      id: "digifab:laser-setup", changes: "records", label: "Set up a laser at its station", scope: "workspace", group: "more", userInvokable: false,
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
      part: "lasers",
      // UI-SCREEN: /station/machine/:connectionId/:deviceId
      id: "digifab:laser-control", changes: "records", label: "Control a direct laser", scope: "workspace", group: "more", userInvokable: false,
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
      part: "lasers",
      // UI-SCREEN: /digifab
      id: "digifab:laser-batch", changes: "records", label: "Prepare a laser batch", group: "more", scope: "workspace", userInvokable: false,
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
      part: "lasers",
      // UI-SCREEN: /digifab/manager
      id: "digifab:dispatch-material", changes: "records", label: "Dispatch a laser batch by material", scope: "workspace", group: "more", userInvokable: false,
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
      part: "lasers",
      // UI-SCREEN: /station/machine/:connectionId/:deviceId
      id: "digifab:cutter-batch", changes: "records", label: "Prepare a cutter job", group: "more", scope: "workspace", userInvokable: false,
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
      part: "lasers",
      // UI-SCREEN: /station/machine/:connectionId/:deviceId
      id: "digifab:cutter-control", changes: "records", runBy: "member", label: "Control a cutter", group: "more", scope: "workspace", userInvokable: false,
      description: "Stop, pause or resume cutter streaming. Any member may stop or pause a cutter without a station credential; resuming, framing and confirming idle need an admin or an operator. Frame requires its reviewed queued job, loaded roll and authorized station token. Confirm idle requires that token and physical idle and blade-up confirmation. Never starts a new cut. Use the machine's physical Stop in an emergency.",
      invokeHandler: "digifab.cutter-control", effect: "physical", undoable: false,
      argsSchema: {
        connection_id:{label:"Connection",type:"text",required:true},device_id:{label:"Device",type:"text",required:true},operation:{label:"Control",type:"text",required:true,choices:["stop","pause","resume","frame","confirm-idle"].map(value=>({value,label:value}))},
        job_id:{label:"Queued job",type:"text"},file_id:{label:"Reviewed file",type:"text"},project_hash:{label:"Review hash",type:"text"},station_token:{label:"Authorized station token",type:"text"},idle_confirmed:{label:"Machine is idle",type:"boolean"},blade_up_confirmed:{label:"Blade is up",type:"boolean"},
      },
    },
  ],
};
