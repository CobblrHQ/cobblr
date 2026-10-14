// Links between two records (entity_pairings): make one, change what it says,
// take it away. One implementation for every door, so the record page's Links
// panel (routes/pairings.ts) and the assistant's actions (platform:link-records,
// platform:edit-link, platform:unlink-records) link and unlink the same way
// (#6528).

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import * as activity from "./activity.js";
import { linkWords, recordKindSpellings } from "./record-kind-spellings.js";
import { familiesOf } from "./families.js";

export interface PairingInput {
  source_kind: string;
  source_id: string;
  target_kind: string;
  target_id: string;
  relationship_kind: string;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}

export type PairingRow = Awaited<ReturnType<typeof readPairing>> & {};
type Refused = { ok: false; status: number; code: string; message: string; existing_id?: string };

export async function readPairing(orgId: string, id: string) {
  return meta.selectFrom("entity_pairings").selectAll().where("id", "=", id).where("org_id", "=", orgId).executeTakeFirst();
}

/** Link two records. The same two, the same meaning, the same way round,
 *  once: checked under a lock on the pair, so a double tap cannot slip two in. */
export async function createPairing(orgId: string, userId: string | null, d: PairingInput): Promise<{ ok: true; row: NonNullable<PairingRow> } | Refused> {
  const [sourceKinds, targetKinds] = await Promise.all([recordKindSpellings(orgId, d.source_kind), recordKindSpellings(orgId, d.target_kind)]);
  if (d.source_id === d.target_id && sourceKinds.includes(d.target_kind)) {
    return { ok: false, status: 400, code: "self_link", message: "A thing cannot be linked to itself." };
  }
  const pairKey = `${orgId}|${d.source_id}|${d.target_id}|${d.relationship_kind}`;
  const outcome = await meta.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${pairKey}))`.execute(trx);
    const already = await trx
      .selectFrom("entity_pairings")
      .select("id")
      .where("org_id", "=", orgId)
      .where("source_id", "=", d.source_id)
      .where("target_id", "=", d.target_id)
      .where("relationship_kind", "=", d.relationship_kind)
      .where("source_kind", "in", sourceKinds)
      .where("target_kind", "in", targetKinds)
      .executeTakeFirst();
    if (already) return { already: already.id } as const;
    const row = await trx
      .insertInto("entity_pairings")
      .values({
        org_id: orgId,
        source_kind: d.source_kind,
        source_id: d.source_id,
        target_kind: d.target_kind,
        target_id: d.target_id,
        relationship_kind: d.relationship_kind,
        notes: d.notes ?? null,
        metadata: d.metadata ? (sql`${JSON.stringify(d.metadata)}::jsonb` as unknown as Record<string, unknown>) : ({} as Record<string, unknown>),
        created_by: userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { row } as const;
  });
  if ("already" in outcome) {
    return { ok: false, status: 409, code: "already_linked", message: `These two are already linked (${linkWords(d.relationship_kind)}).`, existing_id: outcome.already };
  }
  await activity.log({
    orgId,
    action: "pairing_created",
    ref: { module: null, entityType: "pairing", entityId: outcome.row.id },
    diff: {
      source_kind: d.source_kind,
      target_kind: d.target_kind,
      relationship_kind: d.relationship_kind,
      // What the link is about, so every feed names and opens the record.
      subject: { kind: d.source_kind, id: d.source_id },
    },
  });
  return { ok: true, row: outcome.row };
}

/** Change what a link says (its note, its details). */
export async function updatePairing(orgId: string, id: string, patch: { notes?: string | null; metadata?: Record<string, unknown> }): Promise<{ ok: true; row: NonNullable<PairingRow>; before: NonNullable<PairingRow> } | Refused> {
  const before = await readPairing(orgId, id);
  if (!before) return { ok: false, status: 404, code: "not_found", message: "pairing not found" };
  const row = await meta
    .updateTable("entity_pairings")
    .set({
      ...(patch.notes !== undefined && { notes: patch.notes }),
      ...(patch.metadata && { metadata: sql`${JSON.stringify(patch.metadata)}::jsonb` as unknown as Record<string, unknown> }),
    })
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .returningAll()
    .executeTakeFirst();
  if (!row) return { ok: false, status: 404, code: "not_found", message: "pairing not found" };
  return { ok: true, row, before };
}

/** Take a link away. A thing's link to its type is the family's to change,
 *  not a Links row's: taken away here, a spool would be left with no type
 *  (#3990). Returns the link as it was, so an undo can make it again. */
export async function deletePairing(orgId: string, id: string): Promise<{ ok: true; before: NonNullable<PairingRow> } | Refused> {
  const before = await readPairing(orgId, id);
  if (!before) return { ok: false, status: 404, code: "not_found", message: "pairing not found" };
  const fixedRels = new Set((await familiesOf(orgId)).map((f) => f.rel));
  if (fixedRels.has(before.relationship_kind)) {
    return { ok: false, status: 409, code: "family_link", message: "This is its type. Change the type where the types are kept, not here." };
  }
  const deleted = await meta.deleteFrom("entity_pairings").where("id", "=", id).where("org_id", "=", orgId).returning(["id"]).executeTakeFirst();
  if (!deleted) return { ok: false, status: 404, code: "not_found", message: "pairing not found" };
  await activity.log({
    orgId,
    action: "pairing_deleted",
    ref: { module: null, entityType: "pairing", entityId: deleted.id },
    // The link is gone by the time a feed reads this row: say its record now.
    diff: { subject: { kind: before.source_kind, id: before.source_id } },
  });
  return { ok: true, before };
}
