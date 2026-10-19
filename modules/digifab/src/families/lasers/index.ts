// The lasers family, declared to Digital Fabrication's core (core/families.ts):
// the module part it is, its routes, its own controls, what the fleet card
// shows for its machines, and what it registers when the api loads.
// docs/modules/digifab-families.md says what has moved here and what is next.
import type { DigifabFamily } from "../../core/families.js";
import { ReviewRequired } from "../../drivers/job-review.js";
import { laserRouter } from "./api/laser.js";
import { cutterRouter } from "./api/cutter.js";
import { recordCutterOutcome, registerCutterActions } from "./cutter-actions.js";
import { cutterControl } from "./cutter-controls.js";
import { DirectLaserDriver } from "./direct-laser.js";
import { registerLaserActions } from "./laser-actions.js";
import { registerLaserDispatchAction } from "./laser-dispatch.js";
import { controlDirectLaser, registerLaserControlAction } from "./laser-controls.js";
import { registerLaserSetupAction } from "./laser-setup.js";
import { readLightBurnReadiness } from "./lightburn-readiness.js";

const OPERATIONS = ["stop", "pause", "resume", "frame"] as const;

export const lasersFamily: DigifabFamily = {
  part: "lasers",
  stationKinds: [],
  routes: [{ path: "/laser", router: laserRouter }, { path: "/cutter", router: cutterRouter }],
  register() {
    registerLaserActions();
    registerLaserDispatchAction();
    registerCutterActions();
    registerLaserControlAction();
    registerLaserSetupAction();
  },
  control: {
    noun: "laser",
    operations: OPERATIONS,
    stopsWithoutJob: true,
    drives: (driver) => !!driver.laserBackend,
    run: (db, orgId, driver, deviceId, operation, params, connectionId) => controlDirectLaser(db, orgId, driver, deviceId, operation, params, connectionId),
  },
  // A cutter's Stop and Pause, for the core's Stop action; its station page and fleet card keep their own path.
  stopControl: {
    noun: "cutter",
    operations: ["stop", "pause"],
    stopsWithoutJob: true,
    drives: async (driver) => (await driver.jobReviewKind?.()) === "cutter",
    run: async (db, orgId, _driver, deviceId, operation, _params, connectionId) => {
      try {
        const r = (await cutterControl(db, orgId, { connection_id: connectionId, device_id: deviceId, operation: operation as "stop" | "pause" })) as { ok?: boolean; error?: string };
        return r?.ok === false ? { ok: false, detail: r.error ?? "The cutter did not confirm." } : { ok: true };
      } catch (err) {
        // The cutter's own refusal (a ReviewRequired) is a sentence for a person.
        return { ok: false, detail: (err as Error).message || "The cutter did not confirm." };
      }
    },
  },
  stationRun: {
    prefix: "cutter",
    run: async (db, orgId, userId, operation, id, fields) => {
      if (operation !== "outcome") throw new ReviewRequired("Record this cutter job's outcome.");
      return await recordCutterOutcome(db, orgId, id, userId, fields);
    },
  },
  manifestDriver: { section: "laser", build: (manifest, cfg) => new DirectLaserDriver(manifest, cfg) },
  fleetFields: (device) => ({ lightburn_readiness: readLightBurnReadiness((device.raw as { lightburnReadiness?: unknown } | null | undefined)?.lightburnReadiness) }),
};
