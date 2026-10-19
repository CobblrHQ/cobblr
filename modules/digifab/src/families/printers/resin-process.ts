// The resin print process (core/families.ts FamilyProcess): what a resin print
// uses, from its review at the station to its outcome. The core's send keeps the
// Start's order and asks here at each step.
import type { FamilyProcess } from "../../core/families.js";
import { buildDriverById } from "../../jobs-core.js";
import { extractPlateMetadata } from "../../library/extract-metadata.js";
import { checkResinStart, prepareResinPrint, reserveResinPrint, reservedResin, setResinPhase, settleResinPrint } from "./resin-prints.js";
import { planResinPrint, readLoadedResinStock, resinStationKey } from "./resin-stock.js";

/** The printer's LCD exposure counter, in seconds, when it reports one. */
const lcdSecondsOf = (raw: Record<string, unknown> | null | undefined) => (typeof raw?.PrintScreen === "number" ? raw.PrintScreen : undefined);

export const resinProcess: FamilyProcess = {
  printProcess: "resin",
  prepare: ({ db, orgId, jobId, connectionId, deviceId, reviewFileId, filename, bytes, raw }) =>
    prepareResinPrint(db, orgId, jobId, connectionId, deviceId, reviewFileId, extractPlateMetadata(filename, Buffer.from(bytes)), lcdSecondsOf(raw)),
  reserve: (db, orgId, jobId, reviewFileId) => reserveResinPrint(db, orgId, jobId, reviewFileId),
  check: (db, orgId, jobId) => checkResinStart(db, orgId, jobId),
  started: (db, jobId) => setResinPhase(db, jobId, "started"),
  release: (db, jobId) => setResinPhase(db, jobId, "released"),
  async settle(db, orgId, jobId, verdict, userId, at) {
    let lcdSeconds: number | undefined;
    if (at) {
      try {
        const driver = await buildDriverById(db, orgId, at.connectionId);
        lcdSeconds = lcdSecondsOf((await driver?.listDevices())?.find((item) => item.id === at.deviceId)?.raw);
      } catch { /* The sliced estimate remains available when counters cannot be read. */ }
    }
    await settleResinPrint(db, orgId, jobId, verdict, userId, lcdSeconds);
  },
  async stationScreen({ db, orgId, connectionId, deviceId, job, metadata, attentionJobId }) {
    let loaded: Awaited<ReturnType<typeof readLoadedResinStock>> = [];
    let canStart = false, warning = "";
    try {
      loaded = await readLoadedResinStock(orgId, connectionId, deviceId);
      const plan = planResinPrint(metadata ?? {}, loaded, await reservedResin(db, job?.id));
      canStart = plan.canStart && job?.status === "queued" && !job.send_token && !job.remote_job_id; warning = job ? plan.warning : "";
    } catch (error) { warning = error instanceof Error ? error.message : "Check the loaded resin stock."; }
    const postprocess = await db.selectFrom("digifab_resin_prints as p").innerJoin("digifab_jobs as j", "j.id", "p.job_id")
      .select(["p.job_id", "p.wash_done", "p.cure_done", "j.file_ref", "j.metadata"])
      .where("p.connection_id", "=", connectionId).where("p.device_id", "=", deviceId).where("p.phase", "=", "settled").where("j.outcome", "=", "good")
      .where(eb => eb.or([eb("p.wash_done", "=", false), eb("p.cure_done", "=", false)])).orderBy("p.created_at", "asc").limit(50).execute();
    const accounting = attentionJobId ? await db.selectFrom("digifab_resin_prints").select("stock_error").where("job_id", "=", attentionJobId).executeTakeFirst() : null;
    return { resin: { station: resinStationKey(connectionId, deviceId), loaded, canStart, warning, stockError: accounting?.stock_error ?? null, postprocess } };
  },
};
