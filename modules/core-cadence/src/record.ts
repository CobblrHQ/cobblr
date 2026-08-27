// Appending one fact to the ledger. THE write - every door calls this.
//
// Three doors reach the ledger: the HTTP route (a person, or an external
// caller), the record-event action (a wire, or Ask Cobb), and the
// core-scan.stock.observed subscriber (a scan committing a purchase). They used
// to be two separate inserts, and only one of them normalised the kind - see
// the comment inside recordCadenceEvent for what that cost. One insert, one
// schema, three callers.
//
// THE CALLER BRINGS THE DB HANDLE. A request already holds its org's pool via
// the tenant middleware; taking a second handout inside a request trips the
// pool-release rule into scheduling that pool for closure, so the next request
// after a quiet spell pays a fresh TCP + auth handshake. `withDb` is for code
// with no request - the event subscriber - and that is the only door that uses
// it. The route passes tenantDb(req), the action passes getDb(orgId).
//
// AUTHORISATION IS THE CALLER'S JOB. The route checks a role before calling in
// ("a read-only guest must not be able to rewrite the workspace's cadence"),
// the action arrives through the action layer, and the subscriber checks the
// module is enabled for the org and trusts an emitter already past its own
// check. This function does not re-check, and must not be given a door that
// skips one.

import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreCadenceDB } from "./db.js";

/** The shape of one observation, validated identically at every door. */
export const RecordBody = z.object({
  entity_kind: z.string().min(1).max(120),
  entity_id: z.string().uuid(),
  event_type: z.enum(["purchase", "consume", "adjust", "discard"]),
  qty_delta: z.number().finite(),
  context: z.enum(["normal", "one_off", "bulk", "faster"]).optional(),
  source: z.enum(["scan", "list", "manual", "wire", "checkin"]).optional(),
  unit_price: z.number().nonnegative().nullable().optional(),
  /** ISO date. Defaults to now; a receipt should pass its OWN date. */
  occurred_at: z.string().datetime().optional(),
});
export type CadenceObservation = z.infer<typeof RecordBody>;

export async function recordCadenceEvent(
  db: Kysely<CoreCadenceDB>,
  orgId: string,
  userId: string | null,
  b: CadenceObservation,
): Promise<{ id: string; occurred_at: Date }> {
  // NORMALISE THE KIND ON WRITE, once, here.
  //
  // Callers hold the PRESENTATION kind: "inventory:part" for a module's
  // default instance but "<instance>:item" for a skinned one ("tea:item").
  // core-scan passes whatever kind the commit targeted, the bundle wires pass
  // the wire's source_kind, and those are not the same string for the same
  // item - so one tea ended up with a ledger under two identities, four rows
  // under one and one row under the other. Every reader then got a different
  // answer depending on which it asked for, and none of them got the truth.
  //
  // Fixing the readers means every future reader has to remember. Fixing the
  // writers means every future writer has to. There is one insert, so the
  // ledger is normalised here and holds exactly one kind per entity.
  const entityKind = await platform()
    .entities.baseKindOf(orgId, b.entity_kind)
    .catch(() => b.entity_kind);

  return db
    .insertInto("core_cadence_events")
    .values({
      entity_kind: entityKind,
      entity_id: b.entity_id,
      event_type: b.event_type,
      qty_delta: b.qty_delta,
      context: b.context ?? "normal",
      source: b.source ?? "manual",
      unit_price: b.unit_price ?? null,
      ...(b.occurred_at ? { occurred_at: new Date(b.occurred_at) } : {}),
      user_id: userId,
    })
    .returning(["id", "occurred_at"])
    .executeTakeFirstOrThrow();
}

/** Is Cadence switched on for this workspace? The HTTP door gets this for
 *  free from requireModuleEnabled; a bus subscriber does not, and the module
 *  is opt-in (autoEnable: false), so an ungated subscriber would write into a
 *  workspace that never asked for a ledger - or, worse, into one that had it
 *  and switched it off, whose tables are kept on disable. */
export async function cadenceEnabledFor(orgId: string): Promise<boolean> {
  const meta = platform().db.meta as unknown as Kysely<{
    org_modules: { org_id: string; module_name: string };
  }>;
  const row = await meta
    .selectFrom("org_modules")
    .select("org_id")
    .where("org_id", "=", orgId)
    .where("module_name", "=", "core-cadence")
    .executeTakeFirst();
  return !!row;
}
