// What the CNC family declares in Digital Fabrication's manifest: its module
// part and its actions. Data only: src/module.ts spreads it in through
// families/manifests.ts. The part is on everywhere, as CNC was before it had a
// folder of its own; its one route (POST /jobs/:id/place) sits under the core's
// job paths, so the part names no route prefix of its own.
import type { FamilyManifest } from "../../core/families.js";

export const cncManifest: FamilyManifest = {
  part: {
    id: "cnc",
    label: "CNC",
    description: "CNC machines: their own controls, programs placed on stock, and the outcome and bit time of each job.",
    default: "on",
  },
  panels: [],
  actions: [
    {
      part: "cnc",
      // UI-SCREEN: /station/machine/:connectionId/:deviceId
      id: "digifab:machine-control", changes: "records", label: "Control a machine", scope: "workspace", group: "more", userInvokable: false,
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
      part: "cnc",
      // UI-SCREEN: /station/machine/:connectionId/:deviceId
      id: "digifab:machine-outcome", changes: "records", label: "Record a CNC outcome", group: "more", scope: "workspace", userInvokable: false,
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
      part: "cnc",
      // UI-SCREEN: /digifab
      id: "digifab:place-program", changes: "records", label: "Find free CNC sheet area", group: "more", scope: "workspace", userInvokable: false,
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
  ],
};
