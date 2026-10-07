import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import type { DigifabDB } from "./db.js";
import type { PlateMetadata } from "./library/extract-metadata.js";
import { ReviewRequired } from "./drivers/job-review.js";
import { planResinPrint, readLoadedResinStock, readResinItem, resinActionContext, type ResinStock, type ResinAllocation } from "./resin-stock.js";
export interface ResinSnapshot { metadata: PlateMetadata; loaded: ResinStock[]; allocations: ResinAllocation[]; lcdSeconds?: number }
const signature = (loaded: ResinStock[]) => JSON.stringify(loaded.map(item => [item.id, item.kind, item.slot, item.revision]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
export async function reservedResin(db: Kysely<DigifabDB>, exceptJob?: string): Promise<Record<string, number>> {
  let query = db.selectFrom("digifab_resin_prints").select("snapshot").where("phase", "in", ["reserved", "started"]);
  if (exceptJob) query = query.where("job_id", "!=", exceptJob);
  const reserved: Record<string, number> = {};
  for (const row of await query.execute()) for (const draw of row.snapshot.allocations ?? []) if (draw.purpose === "resin") reserved[draw.id] = (reserved[draw.id] ?? 0) + draw.amount;
  return reserved;
}
export async function prepareResinPrint(db: Kysely<DigifabDB>, orgId: string, jobId: string, connectionId: string, deviceId: string, reviewFileId: string, metadata: PlateMetadata, lcdSeconds?: number) {
  const loaded = await readLoadedResinStock(orgId, connectionId, deviceId);
  const plan = planResinPrint(metadata, loaded, await reservedResin(db, jobId));
  if (!plan.canStart) throw new ReviewRequired(plan.warning);
  const snapshot: ResinSnapshot = { metadata, loaded, allocations: plan.allocations, lcdSeconds };
  const saved = await db.insertInto("digifab_resin_prints").values({ job_id: jobId, connection_id: connectionId, device_id: deviceId, review_file_id: reviewFileId, phase: "reviewed", snapshot, stock_error: null })
    .onConflict(oc => oc.column("job_id").doUpdateSet({ review_file_id: reviewFileId, phase: "reviewed", snapshot, stock_error: null, updated_at: new Date() }).where("digifab_resin_prints.phase", "in", ["reviewed", "released"])).returning("job_id").executeTakeFirst();
  if (!saved) throw new ReviewRequired("This resin print is already starting. Stop it before preparing another review.");
}
export async function reserveResinPrint(db: Kysely<DigifabDB>, orgId: string, jobId: string, reviewFileId: string) {
  await db.transaction().execute(async trx => {
    await sql`select pg_advisory_xact_lock(hashtext('resin-stock-reservations'))`.execute(trx);
    const row = await trx.selectFrom("digifab_resin_prints").selectAll().where("job_id", "=", jobId).forUpdate().executeTakeFirst();
    if (!row || row.phase !== "reviewed" || row.review_file_id !== reviewFileId) throw new ReviewRequired("Review this print and its loaded resin before Start.");
    const loaded = await readLoadedResinStock(orgId, row.connection_id, row.device_id);
    if (signature(loaded) !== signature(row.snapshot.loaded)) throw new ReviewRequired("The loaded resin or tools changed. Review the print again before Start.");
    const plan = planResinPrint(row.snapshot.metadata, loaded, await reservedResin(trx, jobId));
    if (!plan.canStart) throw new ReviewRequired(plan.warning);
    await trx.updateTable("digifab_resin_prints").set({ phase: "reserved", snapshot: { ...row.snapshot, allocations: plan.allocations }, updated_at: new Date() }).where("job_id", "=", jobId).execute();
  });
}
export async function checkResinStart(db: Kysely<DigifabDB>, orgId: string, jobId: string) {
  const row = await db.selectFrom("digifab_resin_prints").selectAll().where("job_id", "=", jobId).executeTakeFirst();
  if (!row || !["reserved", "started"].includes(row.phase)) throw new ReviewRequired("Review this print and its loaded resin again before Start.");
  const loaded = await readLoadedResinStock(orgId, row.connection_id, row.device_id);
  if (signature(loaded) !== signature(row.snapshot.loaded)) throw new ReviewRequired("The loaded resin or tools changed. Review the print again before Start.");
  const plan = planResinPrint(row.snapshot.metadata, loaded, await reservedResin(db, jobId));
  if (!plan.canStart) throw new ReviewRequired(plan.warning);
}
export async function setResinPhase(db: Kysely<DigifabDB>, jobId: string, phase: "started" | "released") {
  await db.updateTable("digifab_resin_prints").set({ phase, updated_at: new Date() }).where("job_id", "=", jobId).where("phase", "=", "reserved").execute();
}
export async function consumeResinSnapshot(orgId: string, jobId: string, snapshot: ResinSnapshot, verdict: "good" | "scrap", userId: string | null, lcdSeconds?: number) {
  for (const allocation of snapshot.allocations) {
    const stock = await readResinItem(orgId, allocation.kind, allocation.id);
    if (stock.shape !== (allocation.purpose === "resin" ? "liquid" : "wearing-tool") || stock.unit !== allocation.unit) throw new Error("The print's stock shape or unit changed. Check its original stock record.");
    const elapsed = lcdSeconds != null && snapshot.lcdSeconds != null ? lcdSeconds - snapshot.lcdSeconds : undefined;
    const amount = allocation.purpose === "lcd" && elapsed != null && Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed / 3600 * 1e9) / 1e9 : allocation.amount;
    const result = normaliseActionResult(await platform().actions.invoke("inventory:consume-stock", resinActionContext(orgId, userId, { fields: { source: `resin:${jobId}:${allocation.purpose}:${allocation.id}`, verdict, amount, unit: allocation.unit } }, { kind: allocation.kind, id: allocation.id })), "inventory.consume-stock");
    if (!result.ok) throw new Error(typeof result.error === "string" ? result.error : "The print's stock use could not be recorded. Check its stock record.");
  }
}
export async function settleResinPrint(db: Kysely<DigifabDB>, orgId: string, jobId: string, verdict: "good" | "scrap", userId: string | null, lcdSeconds?: number) {
  const row = await db.selectFrom("digifab_resin_prints").selectAll().where("job_id", "=", jobId).executeTakeFirst();
  if (!row || row.phase !== "started") return;
  try {
    await consumeResinSnapshot(orgId, jobId, row.snapshot, verdict, userId, lcdSeconds);
    await db.updateTable("digifab_resin_prints").set({ phase: "settled", stock_error: null, updated_at: new Date() }).where("job_id", "=", jobId).execute();
  } catch (error) {
    await db.updateTable("digifab_resin_prints").set({ stock_error: error instanceof Error ? error.message : "Check this print's stock use.", updated_at: new Date() }).where("job_id", "=", jobId).execute();
    throw error;
  }
}
