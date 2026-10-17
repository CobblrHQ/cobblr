// Keeping a card's other places in step with the source.
//
// A source record that is kept in several places (Part-DB's lots) arrives as a
// card plus `holdings`: one more place each. Each place is a record of the
// card's kind, paired `holding-of` to the card, remembered in the id-map under
// the section's `<key>:holdings` entity type so the section's own delete
// detection never mistakes it for a part. It is looked up by the source's id
// of the place's oldest row, so a row that moves is the same record updated, a
// place that appears is added, and a place that empties is retired.
// See docs/design-decisions/holdings-and-units.md.

import { createHash } from "node:crypto";
import { HOLDING_IDENTITY_FIELDS, HOLDING_OF } from "@cobblr/platform-contract/holdings";
import { platform, type EntityWriter, type SyncHolding } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { deleteMirror } from "./delete-mirror.js";

export const holdingsSectionOf = (typeKey: string): string => `${typeKey}:holdings`;

/** The id-map key of one place of one card. */
export const holdingKey = (cardExternalId: string, h: Pick<SyncHolding, "externalId">): string => `${cardExternalId}#${h.externalId}`;

export interface HoldingsRef {
  orgId: string;
  connectorRowId: string;
}

export interface HoldingsOutcome {
  added: number;
  moved: number;
  retired: number;
  /** Places whose location is not mirrored yet; the next run adds them. */
  unmapped: Array<{ section: string; externalId: string }>;
}

/** The card's identity as it stands now (not as the source says), so a place
 *  never reads differently from the card it belongs to. */
function identityOf(card: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!card) return out;
  for (const k of HOLDING_IDENTITY_FIELDS) if (card[k] !== undefined && card[k] !== null) out[k] = card[k];
  return out;
}

async function locationOf(db: Kysely<CoreIntegrationsDB>, ref: HoldingsRef, loc: SyncHolding["location"]): Promise<string | null> {
  if (!loc) return null;
  const row = await db
    .selectFrom("core_integrations_synced_records")
    .select("cobblr_entity_id")
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", loc.section)
    .where("external_id", "=", loc.externalId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row?.cobblr_entity_id ?? null;
}

async function unpair(ref: HoldingsRef, kind: string, holdingId: string, cardId: string): Promise<void> {
  await platform().pairings.remove({ orgId: ref.orgId, sourceKind: kind, sourceId: holdingId, targetKind: kind, targetId: cardId, relationshipKind: HOLDING_OF });
}

/** Make the card's places exactly `holdings`. Idempotent: a place whose figures
 *  and card identity are unchanged is not written. */
export async function reconcileHoldings(args: {
  db: Kysely<CoreIntegrationsDB>;
  ref: HoldingsRef;
  writer: EntityWriter;
  targetKind: string;
  typeKey: string;
  cardExternalId: string;
  cardId: string;
  card: Record<string, unknown> | null;
  holdings: readonly SyncHolding[];
}): Promise<HoldingsOutcome> {
  const { db, ref, writer, targetKind, cardId } = args;
  const section = holdingsSectionOf(args.typeKey);
  const out: HoldingsOutcome = { added: 0, moved: 0, retired: 0, unmapped: [] };
  const mine = await db
    .selectFrom("core_integrations_synced_records")
    .selectAll()
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", section)
    .where("external_id", "like", `${args.cardExternalId.replace(/[\\%_]/g, "\\$&")}#%`)
    .where("deleted_at", "is", null)
    .execute();
  const have = new Map(mine.map((m) => [m.external_id, m]));
  const wanted = new Set(args.holdings.map((h) => holdingKey(args.cardExternalId, h)));

  for (const m of mine) {
    if (wanted.has(m.external_id)) continue;
    await deleteMirror(writer, ref.orgId, m.cobblr_entity_id);
    await unpair(ref, targetKind, m.cobblr_entity_id, cardId);
    await db.updateTable("core_integrations_synced_records").set({ deleted_at: new Date(), updated_at: new Date() }).where("id", "=", m.id).execute();
    out.retired++;
  }

  const identity = identityOf(args.card);
  for (const h of args.holdings) {
    const key = holdingKey(args.cardExternalId, h);
    const locationId = await locationOf(db, ref, h.location);
    if (h.location && !locationId) {
      out.unmapped.push(h.location);
      continue;
    }
    const figures = { qty: h.qty, location_id: locationId };
    const hash = createHash("sha1").update(JSON.stringify({ figures, identity })).digest("hex");
    const existing = have.get(key);
    if (existing) {
      if (existing.source_hash === hash) continue;
      await writer.update(ref.orgId, existing.cobblr_entity_id, { ...identity, ...figures });
      await db.updateTable("core_integrations_synced_records").set({ source_hash: hash, updated_at: new Date() }).where("id", "=", existing.id).execute();
      out.moved++;
      continue;
    }
    const id = await writer.create(ref.orgId, { ...identity, ...figures, metadata: { sync_holding: { rows: h.rows } } });
    await platform().pairings.create({ orgId: ref.orgId, sourceKind: targetKind, sourceId: id, targetKind, targetId: cardId, relationshipKind: HOLDING_OF });
    // First writer wins, and a tombstoned map row of the same key (a place that
    // came back) is revived rather than doubled.
    const revived = await db
      .updateTable("core_integrations_synced_records")
      .set({ cobblr_entity_id: id, source_hash: hash, target_kind: targetKind, deleted_at: null, updated_at: new Date() })
      .where("connector_row_id", "=", ref.connectorRowId)
      .where("entity_type", "=", section)
      .where("external_id", "=", key)
      .returning("id")
      .executeTakeFirst();
    if (!revived) {
      await db
        .insertInto("core_integrations_synced_records")
        .values({ connector_row_id: ref.connectorRowId, entity_type: section, target_kind: targetKind, external_id: key, cobblr_entity_id: id, source_hash: hash, synced_fields: null as never })
        .onConflict((oc) => oc.columns(["connector_row_id", "entity_type", "external_id"]).doNothing())
        .execute();
    }
    out.added++;
  }
  return out;
}

/** The card is going away: so are the places the source gave it. */
export async function retireHoldingsOf(args: { db: Kysely<CoreIntegrationsDB>; ref: HoldingsRef; writer: EntityWriter; targetKind: string; typeKey: string; cardExternalId: string; cardId: string }): Promise<number> {
  const { cardExternalId, ...rest } = args;
  const out = await reconcileHoldings({ ...rest, cardExternalId, card: null, holdings: [] });
  return out.retired;
}
