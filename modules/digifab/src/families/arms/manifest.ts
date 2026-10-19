// What the robot-arms family declares in Digital Fabrication's manifest: its
// module part, its actions and its record panel. Data only: src/module.ts
// spreads it in through families/manifests.ts, and the kernel and the lints
// read it there (scripts/lib/manifest-sources.ts).
import type { FamilyManifest } from "../../core/families.js";

export const armsManifest: FamilyManifest = {
  part: {
    id: "arms",
    label: "Robot arms",
    description: "Robot arms as machines: their controller's state, programs, compatibility, stations and runs, and cells of machines run as one job.",
    default: "with-collection",
    collections: ["robot-arms"],
    routes: ["/arms", "/cells"],
  },
  notifications: [
    { eventType: "digifab.cell.paused", label: "A cell paused its job", description: "A cell's job stopped at a step that failed or took too long, and its machines were paused. Its operators, or whoever started it, are told." },
  ],
  panels: [
    { id: "digifab:arm", part: "arms", surface: "entity-detail-panel", target: "machines:machine", title: "Robot arm", collections: ["robot-arms"], presence: true },
    { id: "digifab:cell", part: "arms", surface: "entity-detail-panel", target: "machines:machine", title: "Cell", collections: ["robot-arms"], presence: true },
  ],
  actions: [
    {
      // UI-SCREEN: /machines
      part: "arms",
      group: "more",
      id: "digifab:arm-record",
      // ADMIN-ONLY: the page's arm routes POST /arms/:machineId/setup, /refresh, /programs, /control/revoke, /backups, /arms/programs/:id/release, /copy, /arms/copies/:id/check, /cancel, /arms/backups/:id/test-restore, /arms/:machineId/updates, /arms/updates/:id/check, /verify, /cancel and PATCH /compatibility, /maintenance, /tooling, /backup-schedule, /programs/:id gate on owner or admin (families/arms/api/routes.ts)
      runBy: "admin",
      examples: ["the unload program on arm 2 belongs to the unload CNC 3 family", "arm 1 is down for repair", "read arm 3's programs again"],
      label: "Keep robot arm records",
      changes: "workspace",
      description: "Keep a robot arm's records. Requires an admin. Never moves, starts or runs an arm. Operations: setup (id machine id; fields connection_id and device_id of the arm on the shop bridge, or both null), refresh (id machine id; reads model, serial, versions and the controller's program list; a program it no longer lists is kept and marked missing), add_program (id machine id; fields name, revision, family, tool, installation: for a controller that cannot list programs), edit_program (id program id; fields family, tool, installation), compatibility (id machine id; fields controller_generation, firmware, options, interfaces of name/enabled/read/write, simulator_evidence and hardware_evidence each null or tested_on YYYY-MM-DD, by, setup, notes), maintenance (id machine id; fields maintenance in-service or down-for-repair, note), tooling (id machine id; fields tooling, what is installed on the arm; changing it voids every earlier run approval), release_control (id machine id; takes control of the arm away from the station that holds it), release_program (id program id; a person's OK for this revision to run in production, after reading what changed), copy_program (id program id; fields target_machine_id; copies the revision onto another arm as a re-teach checklist, never a silent copy), check_copy (id copy id; fields item index, done true or false; ticking the last item releases the copy on its arm), cancel_copy (id copy id), backup (id machine id; every program and the installation, kept as a file), backup_schedule (id machine id; fields every_hours null or 1 to 720, keep 1 to 100), test_restore (id backup id; fields target_machine_id, a spare arm or simulator; restores the backup there and reads its programs back), start_update (id machine id; fields file_id of the update file in Files or null, target_version; lists the vendor's update steps), check_update (id update id; fields item index, done), verify_update (id update id; reads the controller's versions back and says whether the target took), cancel_update (id update id). Cobblr never installs software on a controller. Restoring the arm's own programs is at its station. Read the arm with read_robot_arm.",
      scope: "workspace",
      invokeHandler: "digifab.arm-record",
      userInvokable: false,
      effect: "writes",
      undoable: false,
      argsSchema: {
        operation: { label: "Operation", type: "text", required: true, choices: ["setup", "refresh", "add_program", "edit_program", "compatibility", "maintenance", "tooling", "release_control", "release_program", "copy_program", "check_copy", "cancel_copy", "backup", "backup_schedule", "test_restore", "start_update", "check_update", "verify_update", "cancel_update"].map(value => ({ value, label: value })) },
        id: { label: "Machine, program, copy or backup id", type: "text", required: true },
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
    {
      // UI-SCREEN: /machines
      part: "arms",
      group: "more",
      id: "digifab:cell-record",
      changes: "workspace",
      // ADMIN-ONLY: the page's cell routes POST /cells/:machineId/setup and PATCH /definition, /operators, /output gate on owner or admin (families/arms/api/cell-routes.ts)
      runBy: "admin",
      examples: ["cell 2 is the CNC and the unloading arm", "make Sam an operator of cell 2", "cell 2's parts go to the brackets"],
      label: "Keep cell records",
      description: "Keep a cell's records. Requires an admin. Never starts, resumes or runs a cell. Operations: setup (id the cell's machine id; fields connection_id and device_id of the cell on the shop bridge, and members: each role, kind arm, machine or sensor, machine_id for an arm or machine, connection_id and device_id for a machine or sensor), definition (id; fields label, steps, cycles null to run until stopped, parts_per_cycle; each step machine-job role file timeout_s, arm-program role program name and revision timeout_s, wait-machine role timeout_s, or wait-input role min max timeout_s), operators (id; fields operators, the people who run it and are told when it pauses), output (id; fields output_part_id, the inventory part its parts are added to, or null). Read the cell with read_robot_cell.",
      scope: "workspace",
      invokeHandler: "digifab.cell-record",
      userInvokable: false,
      effect: "writes",
      undoable: false,
      argsSchema: {
        operation: { label: "Operation", type: "text", required: true, choices: ["setup", "definition", "operators", "output"].map(value => ({ value, label: value })) },
        id: { label: "The cell's machine id", type: "text", required: true },
        fields: { label: "Cell fields", type: "json" },
      },
  },
    {
      // UI-SCREEN: /machines
      part: "arms",
      group: "more",
      id: "digifab:cell-stop",
      changes: "records",
      runBy: "member",
      examples: ["stop cell 2", "stop the CNC cell's job"],
      label: "Stop a cell's job",
      description: "Stop the job a cell is running and every machine in it, now, whatever the cell reports. Requires a member. A program stop through the cell's bridge, not an emergency stop. It only stops, and Cobblr is not part of any safety chain. Args: machine_id, the cell's machine id.",
      scope: "workspace",
      invokeHandler: "digifab.cell-stop",
      userInvokable: false,
      effect: "stops",
      undoable: false,
      argsSchema: {
        machine_id: { label: "The cell's machine id", type: "text", required: true },
      },
  },
  ],
};
