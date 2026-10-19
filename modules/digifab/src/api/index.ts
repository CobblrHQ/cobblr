import { registerPanelPresence } from "../panel-presence.js";
import {largeFormatRouter} from "./large-format.js";
import {registerLargeFormatActions} from "../large-format/actions.js";

import { registerStopAction } from "./stop-action.js";
import { registerRevokeStationAction } from "./stations.js";
import { registerStationRunAction } from "./station-run-action.js";
// digifab router. Mounted at
//   /api/v1/orgs/:slug/modules/digifab/.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { benchRouter } from "./bench.js";
import { registerBench } from "../bench.js";
import { connectionsRouter } from "./connections.js";
import { jobsRouter, registerSendAction } from "./jobs.js";
import { linksRouter } from "./links.js";
import { driversRouter } from "./drivers.js";
import { fleetRouter } from "./fleet.js";
import { careRouter } from "./machine-care.js";
import { poolsRouter } from "./pools.js";
import { runsRouter } from "./runs.js";
import { makesRouter } from "./makes.js";
import { importRouter } from "./import.js";
import { bulkRouter } from "./bulk.js";
import { edgeRelayRouter } from "./edge-relay.js";
import { edgeSharesRouter } from "./edge-shares.js";
import { historyRouter } from "./history.js";
import { libraryRouter } from "./library.js";
import { registerMachineStationVerifier } from "./machine-stations.js";
import { stationsRouter } from "./stations.js";
import { registerFarmResolvers } from "./resolvers.js";
import { registerFloorManager } from "../floor-manager.js";
import { floorRouter } from "./floor.js";
import { registerMakeActions } from "../make-actions.js";
import { registerDeviceSeam } from "./device-provider.js";
import { asyncHandler } from "./util.js";
import { tenantContext } from "../db.js";
import { extractPlateMetadata } from "../library/extract-metadata.js";



import { registerPrioritizeJobAction } from "./prioritize-job-action.js";
import { registerRefreshJobAction } from "./refresh-job-action.js";
import { registerDeleteJobAction } from "./delete-job-action.js";
import { registerRenamePrintFileAction } from "./rename-print-file-action.js";
import { registerDeletePrintFileAction } from "./delete-print-file-action.js";

registerDeletePrintFileAction();

registerRenamePrintFileAction();

registerDeleteJobAction();

registerRefreshJobAction();

registerPrioritizeJobAction();
import { registerMakePoolAction } from "./make-pool-action.js";
import { registerRemovePoolAction } from "./remove-pool-action.js";
import { registerRemoveFromPoolAction } from "./remove-from-pool-action.js";
import { registerHoldRunAction } from "./hold-run-action.js";
import { registerArrangeFloorAction } from "./arrange-floor-action.js";

registerArrangeFloorAction();

registerHoldRunAction();

registerRemoveFromPoolAction();

registerRemovePoolAction();

registerMakePoolAction();
import { registerTestConnectionAction } from "./test-connection-action.js";

registerTestConnectionAction();
import { registerFamilies } from "../core/families.js";
import { FAMILIES } from "../families/index.js";
import { registerAlarmAckAction } from "./alarm-ack-action.js";
import { registerAlarmEscalationAction } from "./alarm-escalation-action.js";

registerAlarmEscalationAction();

registerAlarmAckAction();
import { registerSetMachineHourRateAction } from "./set-machine-hour-rate-action.js";

registerSetMachineHourRateAction();

registerFamilies(FAMILIES);


registerMachineStationVerifier();
registerBench();
registerFarmResolvers();
registerMakeActions();
registerStationRunAction();
registerLargeFormatActions();
registerStopAction();
registerPanelPresence();
registerRevokeStationAction();
registerFloorManager();
registerDeviceSeam(); // back platform().devices.getDriver + the digifab:run-command alias
registerSendAction(); // digifab:send, the one door a job reaches a machine by (effect: physical)

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

const router = Router({ mergeParams: true });
router.use("/bench",benchRouter);
router.use("/connections", connectionsRouter);
router.use("/stations", stationsRouter);
// Each family's routes, at the paths its module part owns (core/families.ts).
for (const family of FAMILIES) for (const r of family.routes) router.use(r.path, r.router);
router.use("/large-format",largeFormatRouter);
router.use("/jobs", jobsRouter);
router.use("/links", linksRouter);
router.use("/drivers", driversRouter);
router.use("/fleet", fleetRouter);
router.use("/care", careRouter);
router.use("/floor", floorRouter);
router.use("/pools", poolsRouter);
router.use("/runs", runsRouter); // quantity-driven production runs (mint-to-ceiling on pools)
router.use("/makes", makesRouter); // Makes: one fabrication run, request to outcome (services.md §13)
router.use("/import", importRouter);
router.use("/bulk", bulkRouter);
router.use("/edge", edgeRelayRouter); // cloud↔on-site bridge tunnel (register/poll/respond)
router.use("/edge-shares", edgeSharesRouter); // owner-side: grant machines to another workspace
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

export default router;
