// One-time, idempotent self-heal for the entity ref stored on discussion-mention
// notifications.
// DONE WHEN: no `notifications` row with event_type 'core-discussion.comment.posted'
// has module_name = 'core-discussion', on prod + staging + dev consistently; then
// delete this file and its boot call.
//
// A notification stores what it is ABOUT as three columns, and the Discord
// interactions endpoint rebuilds `${module_name}:${entity_type}` to decide where
// a typed reply goes. Discussion filled two of the three from the conversation's
// source triple and hardcoded the third as "core-discussion" — the module
// raising the notification rather than the thing it was about.
//
// Fixed at the source, but a fix at dispatch only helps notifications dispatched
// AFTER it. Every DM already sitting in somebody's Discord still carries the old
// ref, so pressing its Reply button still posts into a second, invisible
// conversation. That is exactly the shape §8.1 exists for: it was found by
// pressing Reply on yesterday's DM and watching it fail again, on a build that
// contained the fix.
//
// The conversation is the authority. `entity_type`/`entity_id` are already its
// source_type/source_id, so the correct module_name is that same conversation's
// source_module — read from the tenant rather than guessed. A row whose
// conversation has since been deleted is left alone: there is nothing to point
// it at, and inventing a triple would be worse than a stale one.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb, evictTenantPool } from "../db/tenant.js";

const STALE_MODULE = "core-discussion";
const EVENT = "core-discussion.comment.posted";

/** Rows that still carry the raising module instead of the entity's, grouped by
 *  org so each tenant is opened at most once. */
async function staleByOrg(): Promise<Map<string, Array<{ id: string; entity_type: string; entity_id: string }>>> {
  const rows = await meta
    .selectFrom("notifications")
    .select(["id", "org_id", "entity_type", "entity_id"])
    .where("event_type", "=", EVENT)
    .where("module_name", "=", STALE_MODULE)
    .where("entity_type", "is not", null)
    .where("entity_id", "is not", null)
    .execute();
  const byOrg = new Map<string, Array<{ id: string; entity_type: string; entity_id: string }>>();
  for (const r of rows) {
    const list = byOrg.get(r.org_id) ?? [];
    list.push({ id: r.id, entity_type: r.entity_type as string, entity_id: r.entity_id as string });
    byOrg.set(r.org_id, list);
  }
  return byOrg;
}

/** @returns how many notification rows were corrected. */
export async function healMentionEntityRef(): Promise<number> {
  // The happy path is ONE query against cobblr_meta and no tenant pool at all.
  // Once every install is healed this costs a single indexed count per boot,
  // which is the bar §8.1 sets for a reconcile that stays in the chain.
  const byOrg = await staleByOrg();
  if (byOrg.size === 0) return 0;

  let healed = 0;
  for (const [orgId, rows] of byOrg) {
    let healedHere = 0;
    try {
      const db = await getTenantDb(orgId);
      // One lookup for the whole org: every conversation these rows could name.
      const convos = await sql<{
        source_module: string;
        source_type: string;
        source_id: string;
      }>`select source_module, source_type, source_id from core_discussion_conversations`.execute(
        db as never,
      );
      // A LIST per source pair, not a single value. (source_type, source_id) is
      // NOT unique - only the full triple is - and this very bug is what breaks
      // the tie: a workspace that has been replied to from Discord now has TWO
      // conversations on that pair, the real one and the stray one the bad ref
      // created. Keyed as a single value, the stray can win the overwrite, the
      // owner reads as `core-discussion`, and the row is skipped as
      // "already correct" - the heal running to completion having healed
      // nothing. Found by predicting the outcome on real data before shipping
      // it: the lookup errored with "more than one row returned".
      const bySource = new Map<string, string[]>();
      for (const c of convos.rows) {
        const key = `${c.source_type}::${c.source_id}`;
        bySource.set(key, [...(bySource.get(key) ?? []), c.source_module]);
      }

      for (const row of rows) {
        // The stray conversation is the thing being routed AWAY from, so it is
        // never the answer. Exactly one real candidate is required: none means
        // nothing to point at, several means a genuine ambiguity this pass has
        // no business guessing at.
        const owners = (bySource.get(`${row.entity_type}::${row.entity_id}`) ?? []).filter(
          (m) => m !== STALE_MODULE,
        );
        if (owners.length !== 1) continue;
        const owner = owners[0]!;
        await meta
          .updateTable("notifications")
          .set({ module_name: owner })
          .where("id", "=", row.id)
          .execute();
        healed++;
        healedHere++;
      }
      // Log the corrections made in THIS org, not the global running total nor
      // the candidate count — the old `if (healed) … ${rows.length}` fired for an
      // org that corrected nothing and reported the wrong number (audit L-HEALLOG).
      if (healedHere) console.log(`[reconcile] mention entity ref: org ${orgId} corrected ${healedHere} row(s)`);
    } catch (err) {
      // One workspace's failure must never block the rest — a tenant whose DB is
      // down simply heals on the next boot.
      console.error(`[reconcile] mention entity ref failed for org ${orgId}:`, (err as Error)?.message ?? err);
    } finally {
      // Boot-time passes must not hold a pool per tenant; Postgres runs out of
      // connections long before the orgs run out.
      await evictTenantPool(orgId).catch(() => {});
    }
  }
  return healed;
}
