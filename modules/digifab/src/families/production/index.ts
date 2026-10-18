// The electronics production family, declared to Digital Fabrication's core
// (core/families.ts): the module part it is, its routes (paste reflow profiles
// and production tests), and what it registers when the api loads.
import "./db.js";
import type { DigifabFamily } from "../../core/families.js";
import { productionRouter } from "./api/production.js";
import { reflowProfilesRouter, registerReflowProfiles } from "./api/reflow-profiles.js";
import { registerProductionTest } from "./production-actions.js";
import { registerProductionReconcile } from "./production-reconcile.js";

export const productionFamily: DigifabFamily = {
  part: "production",
  stationKinds: [],
  // The reflow routes sit under /reflow from the module's root, as before.
  routes: [
    { path: "/", router: reflowProfilesRouter },
    { path: "/production", router: productionRouter },
  ],
  register() {
    registerProductionTest();
    registerProductionReconcile();
    registerReflowProfiles();
  },
};
