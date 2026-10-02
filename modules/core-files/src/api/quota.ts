// How much a workspace may keep in files: a server setting
// (COBBLR_FILES_QUOTA_MB), generous by the owner's call (#3753), measured
// before it is ever priced. Unset means no limit, which is every self-hosted
// instance that never set it. A plan's own limit, where the hosted service
// has one, is the entitlement guard's, fed the same running total.
//
// Kept here rather than as an entitlement guard on purpose: the platform
// holds one guard (the last registered wins), and the hosted service
// registers its own, which would silently replace a quota written as one.

import { sql, type Kysely } from "kysely";
import type { CoreFilesDB } from "../db.js";

const MB = 1024 * 1024;

/** The setting, read once. Blank is unset (compose passes an unset variable
 *  as ""); anything that is not a positive whole number of MB refuses boot
 *  with the value it got, never a quiet "no limit" (docs/architecture/platform-spec.md §14.6). */
export function parseQuota(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`COBBLR_FILES_QUOTA_MB must be a whole number of megabytes above 0, or unset for no limit; got "${raw}".`);
  }
  return n * MB;
}
export const QUOTA_BYTES = parseQuota(process.env.COBBLR_FILES_QUOTA_MB);

/** The bytes a workspace keeps: its files that are not deleted. */
export async function bytesUsed(db: Kysely<CoreFilesDB>): Promise<number> {
  const row = await db
    .selectFrom("core_files_files")
    .select(sql<string>`coalesce(sum(size_bytes), 0)`.as("n"))
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

const human = (n: number) => (n >= 1024 * MB ? `${(n / (1024 * MB)).toFixed(1)} GB` : `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`);

/** Whether `adding` more bytes fits under the quota. Pure. */
export function quotaDecision(used: number, adding: number, quota: number | null): { allow: boolean; reason?: string } {
  if (quota === null || used + adding <= quota) return { allow: true };
  return {
    allow: false,
    reason: `This workspace keeps up to ${human(quota)} of files and holds ${human(used)}; that would need ${human(adding)} more. Delete files you no longer need to make room.`,
  };
}
