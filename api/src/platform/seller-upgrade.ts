// The automatic seller upgrade (#4518): when the seller noted beside where
// things came from has earned a field of its own, offer it once.
//
// Default unchanged: a seller rides as the note beside the place ("eBay ·
// detroitaxle"), display and search only (arrivals.md). Once the same seller is
// noted a third time, or under two different places, the person is asked,
// once per workspace and kind: "You buy from Detroit Axle through several
// places. Track sellers as their own field?" (a notification when they are next
// working with that field, and a notice on the Fields page; never a blocking
// dialog). Yes makes a Seller field on the kind (meaning `seller`, a list that
// learns) and moves every note into it, in one undo; from then on the picker's
// second column writes that field. No is never asked again for that kind; the
// Fields page still offers it. A kind that already has a seller field starts
// upgraded.

import { platform, type EntityViewer } from "@cobblr/platform-contract";
import { fieldNoteKey } from "@cobblr/platform-contract";
import { sellerUpgradeDue, type SellerUpgrade } from "@cobblr/platform-contract/seller-upgrade";
import { meta } from "../db/meta.js";
import { createFieldDef, deleteFieldDef, kindFieldsWithMeaning, resolveFieldDefsForKind } from "./field-defs.js";
import { fieldValuesUsed } from "./field-values-used.js";
import { moveFieldValues, unmoveFieldValues, type FieldMove } from "./move-field-values.js";

export const SELLER_OFFER = "seller-field";

export interface SellerOffer extends SellerUpgrade {
  entity_kind: string;
  /** The field the notes sit beside ("Acquired from"). */
  host: { name: string; label: string };
  state: "offered" | "declined" | "accepted" | null;
}

const key = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The kind's where-it-came-from field whose notes would move, or null when
 *  the kind has none, or already tracks sellers as a field. */
export async function sellerHost(orgId: string, kind: string): Promise<{ name: string; label: string } | null> {
  const fields = await kindFieldsWithMeaning(orgId, kind);
  if (fields.some((f) => f.field_role === "seller")) return null;
  const host = fields.find((f) => f.field_role === "acquired-from" && f.source !== "built-in");
  return host ? { name: host.name, label: host.label } : null;
}

async function stateOf(orgId: string, kind: string): Promise<SellerOffer["state"]> {
  const row = await meta
    .selectFrom("field_upgrade_offers")
    .select("state")
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", kind)
    .where("offer", "=", SELLER_OFFER)
    .executeTakeFirst();
  return row?.state ?? null;
}

/** Whether this kind's sellers have earned a field, and the offer's state. */
export async function sellerOffer(orgId: string, kind: string, viewer?: EntityViewer): Promise<SellerOffer | null> {
  const host = await sellerHost(orgId, kind);
  if (!host) return null;
  const used = await fieldValuesUsed(orgId, kind, host.name, { withNote: true, viewer });
  const names = Object.fromEntries(used.values.map((v) => [key(v.value), v.value]));
  const due = sellerUpgradeDue(used.details ?? {}, names);
  if (!due) return null;
  return { entity_kind: kind, host, ...due, state: await stateOf(orgId, kind) };
}

/** Say it once: the first time an offer is due for this workspace and kind,
 *  record it and tell the person working with the field. */
export async function offerOnce(orgId: string, offer: SellerOffer, userId: string | null): Promise<void> {
  if (offer.state) return;
  const inserted = await meta
    .insertInto("field_upgrade_offers")
    .values({ org_id: orgId, entity_kind: offer.entity_kind, offer: SELLER_OFFER, state: "offered" })
    .onConflict((c) => c.columns(["org_id", "entity_kind", "offer"]).doNothing())
    .returning("org_id")
    .executeTakeFirst();
  if (!inserted || !userId) return;
  const where = offer.places.length > 1 ? `through ${offer.places.length} places (${offer.places.join(", ")})` : `${offer.times} times on ${offer.places[0]}`;
  try {
    await platform().notifications.dispatch({
      orgId,
      userId,
      eventType: "platform.field.seller_upgrade",
      message: `You buy from ${offer.seller} ${where}. Track sellers as their own field?`,
      // PAGE-LINK: the offer is about a kind's fields, answered on the Fields page
      link_url: `/fields?kind=${encodeURIComponent(offer.entity_kind)}`,
      card: {
        heading: "Track sellers as their own field?",
        body: `Then "everything from ${offer.seller}" is a filter, across ${offer.places.join(" and ")}. Every seller you noted moves into it, in one undo.`,
      },
      payload: { entity_kind: offer.entity_kind, seller: offer.seller },
    });
  } catch (e) {
    console.error("[seller-upgrade] offer card failed:", (e as Error).message);
  }
}

async function setState(orgId: string, kind: string, state: SellerOffer["state"]): Promise<void> {
  if (state === null) {
    await meta.deleteFrom("field_upgrade_offers").where("org_id", "=", orgId).where("entity_kind", "=", kind).where("offer", "=", SELLER_OFFER).execute();
    return;
  }
  await meta
    .insertInto("field_upgrade_offers")
    .values({ org_id: orgId, entity_kind: kind, offer: SELLER_OFFER, state })
    .onConflict((c) => c.columns(["org_id", "entity_kind", "offer"]).doUpdateSet({ state, at: new Date() }))
    .execute();
}

export type TrackSellersResult =
  | { ok: true; field: { id: string; name: string; label: string }; host: string; moves: FieldMove[]; previous: SellerOffer["state"] }
  | { ok: false; error: string };

/** Yes: a Seller field on the kind, and every note moved into it. */
export async function trackSellers(orgId: string, kind: string): Promise<TrackSellersResult> {
  const host = await sellerHost(orgId, kind);
  if (!host) {
    const fields = await kindFieldsWithMeaning(orgId, kind);
    return {
      ok: false,
      error: fields.some((f) => f.field_role === "seller")
        ? "This kind already tracks sellers as a field."
        : "This kind has no field for where things came from, so there are no sellers noted beside one.",
    };
  }
  const previous = await stateOf(orgId, kind);
  const taken = new Set((await resolveFieldDefsForKind(orgId, kind)).map((d) => d.name));
  const name = ["seller", "sold_by", "seller_name"].find((n) => !taken.has(n)) ?? `seller_${Date.now().toString(36)}`;
  const made = await createFieldDef(orgId, {
    entity_kind: kind,
    name,
    display_label: "Seller",
    type: "text",
    field_role: "seller",
    learns: true,
    help: "Who sold it: a shop's own name, or a person. Where it came from stays beside it.",
  });
  if (!made.ok) return { ok: false, error: made.message };
  const moves = await moveFieldValues(orgId, kind, fieldNoteKey(host.name), made.def.name);
  await setState(orgId, kind, "accepted");
  return { ok: true, field: { id: made.def.id, name: made.def.name, label: made.def.display_label }, host: host.name, moves, previous };
}

/** Undo of yes: the notes back beside the place, the field gone, the offer as
 *  it was. */
export async function untrackSellers(orgId: string, kind: string, a: { field_id: string; field_name: string; host: string; moves: FieldMove[]; previous: SellerOffer["state"] }): Promise<number> {
  const back = await unmoveFieldValues(orgId, kind, fieldNoteKey(a.host), a.field_name, a.moves);
  await deleteFieldDef(orgId, a.field_id);
  await setState(orgId, kind, a.previous);
  return back;
}

/** No: never asked again for this kind. */
export async function declineSellers(orgId: string, kind: string): Promise<void> {
  await setState(orgId, kind, "declined");
}
