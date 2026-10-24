// A module's links (platform().pairings.create and createMany), each written
// once. The record page's own links go through createPairing (pairings-ops.ts),
// which refuses a second one; a module asking again gets the one it has.

import { sql } from "kysely";

export interface PairingWrite {
  orgId: string;
  sourceKind: string;
  sourceId: string;
  targetKind: string;
  targetId: string;
  relationshipKind: string;
  createdBy?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}

const pairLockKey = (r: { orgId: string; sourceId: string; targetId: string; relationshipKind: string }) => `${r.orgId}|${r.sourceId}|${r.targetId}|${r.relationshipKind}`;
const exactKey = (r: PairingWrite) => `${r.orgId}|${r.sourceKind}|${r.sourceId}|${r.targetKind}|${r.targetId}|${r.relationshipKind}`;

/** A module's links, each written once. A pairing a module asks for again
 *  (a label received twice, a firing logged then finished) is the one already
 *  there, never a second row: a family read counted a repeated receipt's
 *  package twice (#8040). Taken under the same lock on the pair as
 *  createPairing, so a link made by hand and by a module at once is one row. */
export async function writePairingsOnce(rows: PairingWrite[]): Promise<{ ids: string[]; inserted: number }> {
  if (rows.length === 0) return { ids: [], inserted: 0 };
  const { meta } = await import("../db/meta.js");
  return meta.transaction().execute(async (trx) => {
    for (const lock of [...new Set(rows.map(pairLockKey))].sort()) await sql`select pg_advisory_xact_lock(hashtext(${lock}))`.execute(trx);
    const ids = new Map<string, string>();
    const groups = new Map<string, PairingWrite[]>();
    for (const r of rows) groups.set(`${r.orgId}|${r.relationshipKind}`, [...(groups.get(`${r.orgId}|${r.relationshipKind}`) ?? []), r]);
    for (const group of groups.values()) {
      const found = await trx
        .selectFrom("entity_pairings")
        .select(["id", "source_kind", "source_id", "target_kind", "target_id"])
        .where("org_id", "=", group[0]!.orgId)
        .where("relationship_kind", "=", group[0]!.relationshipKind)
        .where("source_id", "in", [...new Set(group.map((r) => r.sourceId))])
        .where("target_id", "in", [...new Set(group.map((r) => r.targetId))])
        .execute();
      for (const f of found) {
        const key = exactKey({ orgId: group[0]!.orgId, sourceKind: f.source_kind, sourceId: f.source_id, targetKind: f.target_kind, targetId: f.target_id, relationshipKind: group[0]!.relationshipKind });
        if (!ids.has(key)) ids.set(key, f.id);
      }
    }
    const fresh = [...new Map(rows.filter((r) => !ids.has(exactKey(r))).map((r) => [exactKey(r), r])).values()];
    if (fresh.length) {
      const made = await trx
        .insertInto("entity_pairings")
        .values(fresh.map((r) => ({
          org_id: r.orgId,
          source_kind: r.sourceKind,
          source_id: r.sourceId,
          target_kind: r.targetKind,
          target_id: r.targetId,
          relationship_kind: r.relationshipKind,
          created_by: r.createdBy ?? null,
          ...(r.notes ? { notes: r.notes.slice(0, 500) } : {}),
          ...(r.metadata ? { metadata: r.metadata } : {}),
        })))
        .returning(["id", "source_kind", "source_id", "target_kind", "target_id"])
        .execute();
      for (const [i, m] of made.entries()) ids.set(exactKey({ ...fresh[i]!, sourceKind: m.source_kind, sourceId: m.source_id, targetKind: m.target_kind, targetId: m.target_id }), m.id);
    }
    return { ids: rows.map((r) => ids.get(exactKey(r))!), inserted: fresh.length };
  });
}
