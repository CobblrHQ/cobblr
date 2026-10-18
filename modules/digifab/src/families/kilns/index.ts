// The kilns family, declared to Digital Fabrication's core (core/families.ts):
// the module part it is, its routes, how the core knows a kiln starts at its
// station (its telemetry), and what it registers when the api loads and boots.
import "./db.js";
import { platform } from "@cobblr/platform-contract";
import type { DigifabFamily } from "../../core/families.js";
import { exists, onMachine } from "../../panel-presence.js";
import { kilnsRouter } from "./api/kilns.js";
import { registerKilnActions } from "./actions.js";
import { TelemetrySchema } from "./model.js";

export const kilnsFamily: DigifabFamily = {
  part: "kilns",
  stationKinds: [],
  routes: [{ path: "/kilns", router: kilnsRouter }],
  register() {
    registerKilnActions();
    platform().panels.registerPresence("digifab:kiln", (ctx) =>
      onMachine(ctx, async (db, id) =>
        (await exists(db.selectFrom("digifab_kiln_profiles").select("machine_id").where("machine_id", "=", id))) ||
        exists(db.selectFrom("digifab_firings").select("machine_id").where("machine_id", "=", id).limit(1)),
      ),
    );
  },
  async onBoot() {
    const { registerKilnMonitor } = await import("./monitor.js");
    registerKilnMonitor();
  },
  startsAtStation: (raw) => TelemetrySchema.safeParse(raw?.kiln).success,
};
