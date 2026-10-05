import { reflowProfilesRouter, registerReflowProfiles } from "./reflow-profiles.js";
// digifab router. Mounted at
//   /api/v1/orgs/:slug/modules/digifab/.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { connectionsRouter } from "./connections.js";
import { jobsRouter, registerSendAction } from "./jobs.js";
import { linksRouter } from "./links.js";
import { driversRouter } from "./drivers.js";
import { fleetRouter } from "./fleet.js";
import { poolsRouter } from "./pools.js";
import { runsRouter } from "./runs.js";
import { makesRouter } from "./makes.js";
import { importRouter } from "./import.js";
import { bulkRouter } from "./bulk.js";
import { bambuRouter } from "./bambu.js";
import { edgeRelayRouter } from "./edge-relay.js";
import { edgeSharesRouter } from "./edge-shares.js";
import { historyRouter } from "./history.js";
import { libraryRouter } from "./library.js";
import { printRulesRouter } from "./print-rules.js";
import { failureRouter } from "./failure.js";
import { loadedRouter } from "./loaded.js";
import { laserRouter } from "./laser.js";
import { registerMachineStationVerifier } from "./machine-stations.js";
import { stationsRouter } from "./stations.js";
import { registerFarmResolvers } from "./resolvers.js";
import { registerFloorManager } from "../floor-manager.js";
import { floorRouter } from "./floor.js";
import { registerLaserControlAction } from "../laser-controls.js";
import { registerLaserActions } from "../laser-actions.js";
import { registerMakeActions } from "../make-actions.js";
import { registerDeviceSeam } from "./device-provider.js";
import { registerDetectorServices } from "../detectors/services.js";
import { registerDetectorAdapters } from "../detectors/adapters.js";
import { printingProfilesRouter, registerPickPrinter } from "./printing-profiles.js";
import { registerPrintThis } from "../print-this.js";
import { asyncHandler } from "./util.js";
import { tenantContext } from "../db.js";
import { extractPlateMetadata } from "../library/extract-metadata.js";

registerMachineStationVerifier();
registerFarmResolvers();
registerMakeActions();
registerLaserActions();
registerLaserControlAction();
registerFloorManager();
registerDeviceSeam(); // back platform().devices.getDriver + the digifab:run-command alias
registerDetectorServices(); // the in-process print checks as inspect.print built-ins
registerDetectorAdapters(); // PrintGuard, Obico, a LAN box: adapters on a person's connection
registerSendAction(); // digifab:send, the one door a job reaches a machine by (effect: physical)
registerPickPrinter(); // digifab:pick-printer (Services §14.3)
registerPrintThis(); // digifab:print-this, and the slice's completion into the one yes

// Edge-bridge consumer: the generic Edge-bridges page renders this card, so a
// user who already has a bridge connected sees "attach machine managers"
// without the page hardcoding digifab.
platform().edge.registerConsumer({
  module: "digifab",
  label: "Machine managers",
  description:
    "Attach the software that runs your machines (Klipper, PrusaLink, Duet, a LAN Bambu, LightBurn) through your bridge as edge-adapter connections.",
  href: "/digifab",
});

registerReflowProfiles();
const router = Router({ mergeParams: true });
router.use("/", reflowProfilesRouter);
router.use("/connections", connectionsRouter);
router.use("/stations", stationsRouter);
router.use("/laser", laserRouter);
router.use("/jobs", jobsRouter);
router.use("/links", linksRouter);
router.use("/drivers", driversRouter);
router.use("/fleet", fleetRouter);
router.use("/floor", floorRouter);
router.use("/pools", poolsRouter);
router.use("/printing-profiles", printingProfilesRouter); // a machine's Printing profile (Services §14.3)
router.use("/runs", runsRouter); // quantity-driven production runs (mint-to-ceiling on pools)
router.use("/makes", makesRouter); // Makes: one fabrication run, request to outcome (services.md §13)
router.use("/import", importRouter);
router.use("/bulk", bulkRouter);
router.use("/bambu", bambuRouter);
  router.use("/failure", failureRouter);
router.use("/edge", edgeRelayRouter); // cloud↔on-site bridge tunnel (register/poll/respond)
router.use("/edge-shares", edgeSharesRouter); // owner-side: grant machines to another workspace
router.use("/loaded", loadedRouter); // spools loaded on a printer, by slot
router.use("/history", historyRouter); // print history + at-a-glance stats
router.use("/library", libraryRouter); // stored 3MF/gcode files + send-to-machine

// GET /files/:fileId/slicer-meta — read a stored file's bytes and pull the
// slicer's filament material + grams (+ time estimate) out of it, so the New-job
// modal can PRE-FILL what the slicer already computed instead of asking the
// operator to retype it. Read-only; a file with no slicer metadata returns nulls.
router.get(
  "/files/:fileId/slicer-meta",
  asyncHandler(async (req, res) => {
    const orgId = tenantContext(req).org.id;
    const f = await platform().files.read(orgId, req.params.fileId!).catch(() => null);
    if (!f) { res.json({ material: null, filament_g: null, filament_g_by_tool: null, estimated_sec: null }); return; }
    const meta = extractPlateMetadata(f.filename, Buffer.from(f.bytes));
    res.json({
      material: meta.material ?? null,
      filament_g: meta.filament_g ?? null,
      filament_g_by_tool: meta.filament_g_by_tool ?? null,
      estimated_sec: meta.estimated_sec ?? null,
    });
  }),
);
router.use("/print-rules", printRulesRouter); // configurable print-update notifications (channels + rules)

export default router;
