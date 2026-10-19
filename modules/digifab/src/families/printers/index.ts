// The printers family (FDM and resin), declared to Digital Fabrication's core
// (core/families.ts): the module part it is, its routes, its resin printers'
// own controls, its print failure detection, and what it registers when the
// api loads and at boot.
// docs/modules/digifab-families.md says what has moved here and what is next.
import type { DigifabFamily } from "../../core/families.js";
import { bambuRouter } from "./api/bambu.js";
import { loadedRouter } from "./api/loaded.js";
import { printingProfilesRouter, registerPickPrinter } from "./api/printing-profiles.js";
import { registerMaterialRecovery } from "./loaded-spools.js";
import { registerMakeRecovery } from "./make-recovery.js";
import { registerPrintThis } from "./print-this.js";
import { printing } from "./printing.js";
import { bambuLanCameras, readBambuLanAccess, removeBambuLanAccess, writeBambuLanAccess } from "./api/bambu-lan-access.js";
import { bambuLanDriverFor } from "./bambu/bambu-lan.js";
import { failureRouter } from "./api/failure.js";
import { printRulesRouter } from "./api/print-rules.js";
import { BambuCloudDriver } from "./bambu/bambu-cloud-driver.js";
import { startBambuPump } from "./bambu/bambu-pump.js";
import { getBambuStatusMap } from "./bambu/bambu-status-store.js";
import { bambuTelemetry } from "./bambu/bambu-telemetry.js";
import { registerCheckForFailureAction } from "./api/check-for-failure-action.js";
import { resinRouter } from "./api/resin.js";
import { registerSetFailureDetectionAction } from "./api/set-failure-detection-action.js";
import { registerTestDetectorAction } from "./api/test-detector-action.js";
import { snapmakerRouter } from "./api/snapmaker.js";
import { registerDetectorAdapters } from "./detectors/adapters.js";
import { ownedDeviceRefs } from "./detectors/owned.js";
import { registerDetectorServices } from "./detectors/services.js";
import { ensureFailureWatch, registerFailureWatcher } from "./failure-detect.js";
import { registerDetectorsToConnectionsHeal } from "./heal-detectors-to-connections.js";
import { controlResinPrinter, registerResinControlAction } from "./resin-controls.js";
import { registerResinPostprocessAction } from "./resin-postprocess.js";
import { resinProcess } from "./resin-process.js";
import "./db.js";
import { registerSnapmakerDiscovery } from "./snapmaker.js";

export const printersFamily: DigifabFamily = {
  part: "printers",
  stationKinds: [],
  routes: [
    { path: "/resin", router: resinRouter },
    { path: "/snapmaker", router: snapmakerRouter },
    { path: "/failure", router: failureRouter },
    { path: "/bambu", router: bambuRouter },
    // configurable print-update notifications (channels and rules)
    { path: "/print-rules", router: printRulesRouter },
    // a machine's Printing profile (Services §14.3)
    { path: "/printing-profiles", router: printingProfilesRouter },
    // spools loaded on a printer, by slot
    { path: "/loaded", router: loadedRouter },
  ],
  register() {
    registerSnapmakerDiscovery();
    registerResinControlAction();
    registerResinPostprocessAction();
    registerTestDetectorAction();
    registerCheckForFailureAction();
    registerSetFailureDetectionAction();
    registerDetectorServices(); // the in-process print checks as inspect.print built-ins
    registerDetectorAdapters(); // PrintGuard, Obico, a LAN box: adapters on a person's connection
    registerPickPrinter(); // digifab:pick-printer (Services §14.3)
    registerPrintThis(); // digifab:print-this, and the slice's completion into the one yes
  },
  onBoot() {
    // One-shot heal: detectors onto adapter connections (see
    // heal-detectors-to-connections.ts for the retirement condition).
    registerDetectorsToConnectionsHeal();
    // AI print-failure watch: samples each printing device's camera, folds a
    // failure score, auto-pauses and alerts when it crosses the threshold.
    registerFailureWatcher();
    // Live Bambu cloud telemetry: holds an MQTT subscription per cloud Bambu
    // account and writes real-time temps and progress into digifab_bambu_status.
    startBambuPump();
    // A completed print whose spools could not be drawn is drawn again.
    registerMaterialRecovery();
    // Print this and batches pick up where a restart left them.
    registerMakeRecovery();
  },
  // The farm's printers and their material, and a Make's prints (core/printing.ts).
  printing,
  // A Bambu Lab account: telemetry and light, pause and stop over Bambu's cloud.
  connectionDriver: { type: "bambu", build: (cfg, connectionId) => new BambuCloudDriver(cfg, connectionId) },
  // The cloud stream's reading wins on the fleet card while it is fresh.
  fleetLive: (db, connection) => (connection.type === "bambu" ? getBambuStatusMap(db, connection.id) : Promise.resolve(null)),
  deviceTelemetry: (db, connectionId, deviceId) => bambuTelemetry(db, connectionId, deviceId),
  // A Bambu printer with LAN access: files, control and the camera go over the bridge first.
  preferredDriver: (orgId, connectionId, deviceId) => bambuLanDriverFor(orgId, connectionId, deviceId),
  lanCameras: (orgId, connection) => bambuLanCameras(orgId, connection),
  deviceLan: { read: readBambuLanAccess, write: writeBambuLanAccess, remove: removeBambuLanAccess },
  // A detector marked `owns` runs its printers' watch and camera (the single-owner rule).
  managedDevices: (db) => ownedDeviceRefs(db),
  // A live print: make sure its failure watch is running (a no-op when detection is off).
  onPrinting: (db, orgId, connectionId, deviceId) => ensureFailureWatch(db, orgId, connectionId, deviceId),
  // A resin print: its stock from review to outcome, behind the core's Start.
  process: resinProcess,
  control: {
    noun: "resin printer",
    operations: ["stop", "pause", "resume"],
    stopsWithoutJob: true,
    exclusive: true,
    drives: (driver) => driver.printProcess === "resin",
    run: (db, orgId, driver, deviceId, operation, _params, connectionId) => controlResinPrinter(db, orgId, driver, deviceId, operation, connectionId),
  },
};
