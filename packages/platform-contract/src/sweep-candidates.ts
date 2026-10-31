import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract/platform-runtime";
import type { TenantSweepPass, TenantSweepVisit } from "./sweeps.js";

export const EMPTY_RECHECK_MS = 60 * 60_000;
type Fingerprints = Map<string, string>;

/** PostgreSQL keeps these counters across database connections, including
 * writes from other API processes. Only writes invalidate an empty result:
 * counting commits would make each read-only discovery invalidate itself.
 * Read before discovery, never after: a write racing the empty read must
 * invalidate it when its statistics arrive. */
export async function workspaceWriteFingerprints(orgIds: string[]): Promise<Fingerprints> {
  if (!orgIds.length) return new Map();
  const meta = platform().db.meta as Kysely<unknown>;
  const { rows } = await sql<{ id: string; fingerprint: string | null }>`
    select o.id,
      case when current_setting('track_counts') = 'on' and s.datid is not null then
        concat_ws('/', s.datid, pg_postmaster_start_time(), s.stats_reset,
          s.tup_inserted, s.tup_updated, s.tup_deleted)
      end as fingerprint
    from orgs o left join pg_stat_database s on s.datname = o.db_name
    where o.id = any(${orgIds})
  `.execute(meta);
  return new Map(rows.flatMap(r => r.fingerprint === null ? [] : [[r.id, r.fingerprint] as const]));
}

/** Remember only an empty visit. Work that can finish later (a pending
 * delivery, a connected device, a future escalation) must return true even
 * when this round cannot advance it. Unknown workspaces get a discovery
 * visit under the scheduler's normal pool budget. The hourly safety check
 * bounds a missed invalidation; a named run always gets its requested visit. */
export function narrowSweep(
  pass: Omit<TenantSweepPass, "candidates" | "everyWorkspace">,
  hasWork: (ctx: TenantSweepVisit) => Promise<boolean>,
  read: (orgIds: string[]) => Promise<Fingerprints> = workspaceWriteFingerprints,
): TenantSweepPass {
  const empty = new Map<string, { fingerprint: string; at: number }>();
  let before = new Map<string, string>();
  return {
    ...pass,
    candidates: async (orgIds, { named }) => {
      if (named) {
        for (const id of orgIds) empty.delete(id);
        before = new Map();
        return orgIds;
      }
      before = await read(orgIds);
      const scope = new Set(orgIds);
      for (const id of empty.keys()) if (!scope.has(id)) empty.delete(id);
      const now = Date.now();
      return orgIds.filter(id => {
        const seen = empty.get(id);
        return !seen || !before.has(id) || seen.fingerprint !== before.get(id) || now - seen.at >= EMPTY_RECHECK_MS;
      });
    },
    visit: async ctx => {
      const fingerprint = before.get(ctx.orgId);
      empty.delete(ctx.orgId);
      if (fingerprint === undefined) return pass.visit(ctx);
      const work = await hasWork(ctx);
      const result = await pass.visit(ctx);
      if (!work) empty.set(ctx.orgId, { fingerprint, at: Date.now() });
      return result;
    },
  };
}
