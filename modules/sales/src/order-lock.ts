import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { SalesDB } from "./db.js";
import { recoverStockDraws } from "./stock-draw.js";

export async function withOrderLock<T>(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, work: () => Promise<T>): Promise<T> {
  return platform().exclusive.serial(`sales:order:${orgId}:${orderId}`, async () => {
    await recoverStockDraws(db, orgId, userId, orderId);
    return work();
  });
}
