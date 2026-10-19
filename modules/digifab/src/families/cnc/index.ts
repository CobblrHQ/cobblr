// The CNC family, declared to Digital Fabrication's core (core/families.ts):
// the module part it is, its routes, its reviewed Start (the stock and bits it
// claims), what it keeps of each poll, its station screen's stock, its own
// controls, how it records a finished job's outcome, and what it registers
// when the api loads.
// docs/modules/digifab-families.md says what has moved here and what is next.
import type { DigifabFamily } from "../../core/families.js";
import { ReviewRequired } from "../../drivers/job-review.js";
import { cncJobsRouter } from "./api/routes.js";
import { controlCnc, registerMachineControlAction } from "./cnc-controls.js";
import { CncOutcomeBody, recordCncOutcome, registerCncOutcomeAction } from "./cnc-outcome-recording.js";
import { CncOutcomeRefusal } from "./cnc-outcomes.js";
import { registerCncPlacementAction } from "./cnc-placement-service.js";
import { persistCncRuntime } from "./cnc-runtime.js";
import { claimCncStock, releaseUnstartedCncStock, validateCncStock } from "./cnc-start.js";
import { cncStationStock } from "./cnc-stock.js";

export const cncFamily: DigifabFamily = {
  part: "cnc",
  stationKinds: [],
  routes: [{ path: "/jobs", router: cncJobsRouter }],
  register() {
    registerMachineControlAction();
    registerCncOutcomeAction();
    registerCncPlacementAction();
  },
  start: {
    reviewKinds: ["cnc"],
    authorize: ({ db, orgId, job, approval, review, stationId }) => claimCncStock(db, orgId, job, approval, review, stationId),
    recheck: async ({ orgId, job, approval, review, stationId }) => { await validateCncStock(orgId, job, approval, review, stationId); },
    release: releaseUnstartedCncStock,
  },
  async recordPoll(db, job, raw) {
    if (job.cnc_setup) await persistCncRuntime(db, job.id, raw && typeof raw === "object" ? (raw as Record<string, unknown>).toolSeconds : undefined);
  },
  stationScreen: async (orgId, { q }) => ({ cncStock: await cncStationStock(orgId, q) }),
  control: {
    noun: "CNC machine",
    operations: ["stop", "pause", "resume", "frame"],
    // A CNC is stopped through its job, as before it had a folder of its own.
    stopsWithoutJob: false,
    drives: async (driver) => (await driver.jobReviewKind?.()) === "cnc",
    run: (db, orgId, driver, deviceId, operation, params, connectionId) => controlCnc(db, orgId, driver, deviceId, operation, params, connectionId),
  },
  async outcome({ db, orgId, connectionId, deviceId, attentionJobId, body, userId }) {
    const requested = CncOutcomeBody.safeParse(body);
    const ids = [...new Set([attentionJobId, requested.success ? requested.data.job_id : undefined].filter((id): id is string => !!id))];
    const jobs = ids.length ? await db.selectFrom("digifab_jobs").select("cnc_setup").where("id", "in", ids).where("connection_id", "=", connectionId).where("target_device", "=", deviceId).execute() : [];
    if (!jobs.some((job) => job.cnc_setup)) return null;
    if (!requested.success) return { status: 400, body: { error: { code: "bad_body", message: "Choose this CNC job's outcome and actual tool seconds when requested." } } };
    try {
      await recordCncOutcome(db, orgId, connectionId, deviceId, requested.data, userId);
      return { status: 200, body: { ok: true } };
    } catch (e) {
      if (!(e instanceof CncOutcomeRefusal) && !(e instanceof ReviewRequired)) throw e;
      return { status: 409, body: { error: { code: e instanceof CncOutcomeRefusal ? e.code : "stock_not_recorded", message: e.message, ...(e instanceof CncOutcomeRefusal && e.details ? { details: e.details } : {}) } } };
    }
  },
};
