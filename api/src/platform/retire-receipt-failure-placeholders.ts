// HISTORICAL DATA MIGRATION — not kernel logic.
// DONE WHEN: the boot pass reports rowsRetired=0 on prod + staging + dev
// consistently (every failed receipt session carries its failure as a state
// and no pending placeholder row is left anywhere; core-scan no longer writes
// one); then delete this file and its boot call.
//
// Until 2026-09-13 a receipt whose read failed was kept as a NOTE ITEM under a
// batch labelled "Receipt · not read yet": a row named "Receipt couldn't be
// read - …" with `receipt_parse_failure` in its metadata. The inbox derived
// "1 finishing…" from it, the header's "to review" skipped it, a successful
// re-read left it behind as a third "item" the put-away planner offered a
// destination (#2892, #2898). The failure is now a state on the batch
// (read_state / read_failure, see platform-contract scan-session.ts). This
// pass moves the rows already written: the batch takes the failure with its
// reason as history, the placeholder row is discarded (never deleted: it is
// the record of what the person uploaded and when). A batch that already has
// a read state, or pending receipt lines of its own, is left alone.
//
// Scoped to workspaces with core-scan enabled (a meta query) so a workspace
// that never scanned anything opens no tenant pool. Per-org try/catch, pool
// evicted in a finally. Idempotent: the UPDATE filters on pending placeholders,
// so a second run matches nothing. Skip with COBBLR_SKIP_HISTORICAL_MIGRATIONS=1.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb, evictTenantPool } from "../db/tenant.js";

export async function retireReceiptFailurePlaceholders(opts: { onlyOrgId?: string } = {}): Promise<{ orgsTouched: number; rowsRetired: number }> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1" && !opts.onlyOrgId) return { orgsTouched: 0, rowsRetired: 0 };

  let q = meta
    .selectFrom("org_modules")
    .select("org_id")
    .where("module_name", "=", "core-scan");
  if (opts.onlyOrgId) q = q.where("org_id", "=", opts.onlyOrgId);
  const orgs = await q.execute();

  let orgsTouched = 0;
  let rowsRetired = 0;

  for (const { org_id } of orgs) {
    try {
      const db = await getTenantDb(org_id);
      // 1. The batch takes the failure, from the placeholder's own metadata.
      await sql`
        update core_scan_batches b
           set read_state   = 'failed',
               read_failure = jsonb_build_object(
                 'code',    coalesce(p.suggested_metadata->>'receipt_parse_failure', 'unreadable'),
                 'reason',  coalesce(p.suggested_metadata->>'receipt_parse_reason', ''),
                 'at',      to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                 'history', jsonb_build_array(jsonb_build_object(
                   'at',      to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                   'outcome', 'failed',
                   'code',    coalesce(p.suggested_metadata->>'receipt_parse_failure', 'unreadable'),
                   'reason',  coalesce(p.suggested_metadata->>'receipt_parse_reason', '')
                 ))
               )
          from core_scan_inbox_items p
         where p.scan_batch_id = b.id
           and p.status = 'pending'
           and p.suggested_metadata ? 'receipt_parse_failure'
           and b.read_state is null
           and not exists (
             select 1 from core_scan_inbox_items l
              where l.scan_batch_id = b.id
                and l.source_kind = 'receipt'
                and l.status in ('pending', 'enriching')
           )
      `.execute(db as never);
      // 2. The placeholder row is retired.
      const res = await sql<{ id: string }>`
        update core_scan_inbox_items p
           set status = 'discarded', updated_at = now()
         where p.status = 'pending'
           and p.suggested_metadata ? 'receipt_parse_failure'
        returning p.id
      `.execute(db as never);
      if (res.rows.length) {
        orgsTouched++;
        rowsRetired += res.rows.length;
        console.log(`[reconcile] org ${org_id}: retired ${res.rows.length} receipt-failure placeholder row(s) into the session's read state`);
      }
    } catch (err) {
      // One workspace's failure never blocks the rest.
      console.warn(`[reconcile] org ${org_id}: receipt placeholder retirement failed:`, (err as Error)?.message ?? err);
    } finally {
      evictTenantPool(org_id);
    }
  }

  return { orgsTouched, rowsRetired };
}
