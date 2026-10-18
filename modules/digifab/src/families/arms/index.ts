// The robot-arms family, declared to Digital Fabrication's core
// (core/families.ts): the module part it is, the station kind its arms
// report, its routes, and what it registers when the api loads.
import { platform } from "@cobblr/platform-contract";
import type { DigifabFamily } from "../../core/families.js";
import { exists, onMachine } from "../../panel-presence.js";
import { armsRouter } from "./api/routes.js";
import { registerArmMonitor } from "./runs.js";
import { registerArmRecordAction } from "./api/arm-record-action.js";
import { registerArmStopAction } from "./api/arm-stop-action.js";

export const armsFamily: DigifabFamily = {
  part: "arms",
  stationKinds: ["robot-arm"],
  routes: [{ path: "/arms", router: armsRouter }],
  onBoot: registerArmMonitor,
  register() {
    registerArmRecordAction();
    registerArmStopAction();
    platform().panels.registerPresence("digifab:arm", (ctx) =>
      onMachine(ctx, (db, id) => exists(db.selectFrom("digifab_arm_units").select("machine_id").where("machine_id", "=", id))),
    );
  },
};
