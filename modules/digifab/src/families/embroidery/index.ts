// The embroidery family, declared to Digital Fabrication's core
// (core/families.ts): the module part it is, its routes, the station-run
// operations it answers, and the check before an embroidery job's outcome.
import "./db.js";
import type { DigifabFamily } from "../../core/families.js";
import { ReviewRequired } from "../../drivers/job-review.js";
import { embroideryRouter } from "./api/embroidery.js";
import { embroideryMutation, registerEmbroideryActions } from "./embroidery-actions.js";

export const embroideryFamily: DigifabFamily = {
  part: "embroidery",
  stationKinds: [],
  routes: [{ path: "/embroidery", router: embroideryRouter }],
  register() {
    registerEmbroideryActions();
  },
  stationRun: { prefix: "embroidery", run: (db, orgId, userId, operation, id, fields) => embroideryMutation(db, orgId, userId, operation, id, fields) },
  // An embroidery run is judged once the station recorded its thread use and
  // verdict.
  async checkJobOutcome(db, jobId, outcome) {
    const run = await db.selectFrom("digifab_embroidery_runs").select(["stock_recorded_at", "report"]).where("job_id", "=", jobId).executeTakeFirst();
    if (!run?.stock_recorded_at || run.report?.verdict !== outcome) throw new ReviewRequired("Record the measured thread use and original verdict at the embroidery station first.");
  },
};
