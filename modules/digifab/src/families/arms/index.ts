// The robot-arms family, declared to Digital Fabrication's core
// (core/families.ts): the module part it is, the station kind its arms
// report, its routes, and what it registers when the api loads. Cells
// (./cells) live here too: a cell is mostly arms, and it reads their records.
import { platform } from "@cobblr/platform-contract";
import type { DigifabFamily } from "../../core/families.js";
import { exists, onMachine } from "../../panel-presence.js";
import { armsRouter } from "./api/routes.js";
import { registerArmMonitor } from "./runs.js";
import { registerArmRecordAction } from "./api/arm-record-action.js";
import { registerArmStopAction } from "./api/arm-stop-action.js";
import { registerMachineHold } from "../../core/holds.js";
import { cellsRouter } from "./api/cell-routes.js";
import { registerCellRecordAction } from "./api/cell-record-action.js";
import { registerCellStopAction } from "./api/cell-stop-action.js";
import { cellHoldRefusal, registerCellMonitor } from "./cells/run.js";
import { registerArmBackups } from "./programs.js";
import { armDriver } from "./store.js";

export const armsFamily: DigifabFamily = {
  part: "arms",
  stationKinds: ["robot-arm", "cell"],
  routes: [{ path: "/arms", router: armsRouter }, { path: "/cells", router: cellsRouter }],
  onBoot: () => { registerArmMonitor(); registerCellMonitor(); registerArmBackups(); },
  /** An arm is running, idle, in fault (any stop or fault), or not seen. */
  async machineStates(db, orgId) {
    const units = await db.selectFrom("digifab_arm_units").select(["machine_id", "connection_id", "device_id"]).where("connection_id", "is not", null).execute();
    return Promise.all(units.map(async (u) => {
      try {
        const s = await (await armDriver(db, orgId, u.connection_id!)).state(u.device_id!);
        const state = s.connectivity !== "online" ? "unknown" as const : s.safety !== "normal" ? "fault" as const : s.execution === "running" ? "run" as const : s.execution === "unknown" ? "unknown" as const : "idle" as const;
        return { machine_id: u.machine_id, state, detail: s.safety !== "normal" ? s.safety.replace(/-/g, " ") : s.execution };
      } catch { return { machine_id: u.machine_id, state: "unknown" as const, detail: "not answering" }; }
    }));
  },
  register() {
    registerArmRecordAction();
    registerArmStopAction();
    registerCellRecordAction();
    registerCellStopAction();
    registerMachineHold(cellHoldRefusal);
    platform().panels.registerPresence("digifab:cell", (ctx) =>
      onMachine(ctx, (db, id) => exists(db.selectFrom("digifab_cells").select("machine_id").where("machine_id", "=", id))),
    );
    platform().panels.registerPresence("digifab:arm", (ctx) =>
      onMachine(ctx, (db, id) => exists(db.selectFrom("digifab_arm_units").select("machine_id").where("machine_id", "=", id))),
    );
  },
};
