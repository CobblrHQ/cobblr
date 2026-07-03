// digifab router. Mounted at
//   /api/v1/orgs/:slug/modules/digifab/.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { connectionsRouter } from "./connections.js";
import { jobsRouter } from "./jobs.js";
import { linksRouter } from "./links.js";
import { driversRouter } from "./drivers.js";
import { fleetRouter } from "./fleet.js";
import { poolsRouter } from "./pools.js";
import { runsRouter } from "./runs.js";
import { importRouter } from "./import.js";
import { bulkRouter } from "./bulk.js";
import { bambuRouter } from "./bambu.js";
import { edgeRelayRouter } from "./edge-relay.js";
import { edgeSharesRouter } from "./edge-shares.js";
import { historyRouter } from "./history.js";
import { libraryRouter } from "./library.js";
import { printRulesRouter } from "./print-rules.js";
import { failureRouter } from "./failure.js";
import { registerFarmResolvers } from "./resolvers.js";
import { registerDeviceSeam } from "./device-provider.js";

registerFarmResolvers();
registerDeviceSeam(); // back platform().devices.getDriver + the digifab:run-command alias

// Edge-bridge consumer: the generic Edge-bridges page renders this card, so a
// user who already has a bridge connected sees "attach machine managers"
// without the page hardcoding digifab.
platform().edge.registerConsumer({
  module: "digifab",
  label: "Machine managers",
  description:
    "Attach the software that runs your machines — Klipper, PrusaLink, Duet, a LAN Bambu, LightBurn — through your bridge as edge-adapter connections.",
  href: "/digifab",
});

const router = Router({ mergeParams: true });
router.use("/connections", connectionsRouter);
router.use("/jobs", jobsRouter);
router.use("/links", linksRouter);
router.use("/drivers", driversRouter);
router.use("/fleet", fleetRouter);
router.use("/pools", poolsRouter);
router.use("/runs", runsRouter); // quantity-driven production runs (mint-to-ceiling on pools)
router.use("/import", importRouter);
router.use("/bulk", bulkRouter);
router.use("/bambu", bambuRouter);
  router.use("/failure", failureRouter);
router.use("/edge", edgeRelayRouter); // cloud↔on-site bridge tunnel (register/poll/respond)
router.use("/edge-shares", edgeSharesRouter); // owner-side: grant machines to another workspace
router.use("/history", historyRouter); // print history + at-a-glance stats
router.use("/library", libraryRouter); // stored 3MF/gcode files + send-to-machine
router.use("/print-rules", printRulesRouter); // configurable print-update notifications (channels + rules)

export default router;
