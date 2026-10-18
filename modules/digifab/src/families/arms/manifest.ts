// What the robot-arms family declares in Digital Fabrication's manifest: its
// module part, its actions and its record panel. Data only: src/module.ts
// spreads it in through families/manifests.ts, and the kernel and the lints
// read it there (scripts/lib/manifest-sources.ts).
import type { ModuleActionInput, ModulePanelInput, ModulePartInput } from "@cobblr/platform-contract";

export interface FamilyManifest { part: ModulePartInput; panels: ModulePanelInput[]; actions: ModuleActionInput[] }

export const armsManifest: FamilyManifest = {
  part: {
    id: "arms",
    label: "Robot arms",
    description: "Robot arms as machines: their controller's state, programs, compatibility, stations and runs.",
    default: "with-collection",
    collections: ["robot-arms"],
    routes: ["/arms"],
  },
  panels: [
    { id: "digifab:arm", part: "arms", surface: "entity-detail-panel", target: "machines:machine", title: "Robot arm", collections: ["robot-arms"], presence: true },
  ],
  actions: [
    {
      // UI-SCREEN: /machines
      part: "arms",
      group: "more",
      id: "digifab:arm-record",
      // ADMIN-ONLY: the page's arm routes POST /arms/:machineId/setup, /refresh, /programs, /control/revoke and PATCH /compatibility, /maintenance, /tooling, /programs/:id gate on owner or admin (families/arms/api/routes.ts)
      runBy: "admin",
      examples: ["the unload program on arm 2 belongs to the unload CNC 3 family", "arm 1 is down for repair", "read arm 3's programs again"],
      label: "Keep robot arm records",
      changes: "workspace",
      description: "Keep a robot arm's records. Requires an admin. Never moves, starts or runs an arm. Operations: setup (id machine id; fields connection_id and device_id of the arm on the shop bridge, or both null), refresh (id machine id; reads model, serial, versions and the controller's program list; a program it no longer lists is kept and marked missing), add_program (id machine id; fields name, revision, family, tool, installation: for a controller that cannot list programs), edit_program (id program id; fields family, tool, installation), compatibility (id machine id; fields controller_generation, firmware, options, interfaces of name/enabled/read/write, simulator_evidence and hardware_evidence each null or tested_on YYYY-MM-DD, by, setup, notes), maintenance (id machine id; fields maintenance in-service or down-for-repair, note), tooling (id machine id; fields tooling, what is installed on the arm; changing it voids every earlier run approval), release_control (id machine id; takes control of the arm away from the station that holds it). Read the arm with read_robot_arm.",
      scope: "workspace",
      invokeHandler: "digifab.arm-record",
      userInvokable: false,
      effect: "writes",
      undoable: false,
      argsSchema: {
        operation: { label: "Operation", type: "text", required: true, choices: ["setup", "refresh", "add_program", "edit_program", "compatibility", "maintenance", "tooling", "release_control"].map(value => ({ value, label: value })) },
        id: { label: "Machine or program id", type: "text", required: true },
        fields: { label: "Arm fields", type: "json" },
      },
  },
    {
      // UI-SCREEN: /machines
      part: "arms",
      group: "more",
      id: "digifab:arm-stop",
      changes: "records",
      runBy: "member",
      examples: ["stop the arm in cell 2", "pause the palletising arm"],
      label: "Pause or stop a robot arm",
      description: "Pause or stop the program on a robot arm's controller now, whatever the arm reports. Requires a member. This is a program stop through the arm's manager, not an emergency stop. It never clears a stop, never loads or starts a program and never moves an arm; Cobblr is not part of any safety chain. Args: machine_id, operation pause or stop.",
      scope: "workspace",
      invokeHandler: "digifab.arm-stop",
      userInvokable: false,
      effect: "stops",
      undoable: false,
      argsSchema: {
        machine_id: { label: "Machine id", type: "text", required: true },
        operation: { label: "Operation", type: "text", required: true, choices: ["pause", "stop"].map(value => ({ value, label: value })) },
      },
  },
  ],
};
