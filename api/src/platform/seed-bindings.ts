// Default wires seeded at signup. Re-creates the cross-module
// behaviour the old hardcoded subscribers gave us, but now as
// user-editable rows in entity_action_bindings.
//
// As more modules land, add their defaults here. Eventually this
// could move into per-module manifests ("recommendedBindings") so
// the seeding is co-located with the module that triggers it.

import { sql } from "kysely";
import { meta } from "../db/meta.js";

interface DefaultBinding {
  source_kind: string;
  action_id: string;
  trigger_type: "user-invoked" | "event" | "on-create" | "on-update" | "on-delete";
  trigger_event?: string;
  template?: string;
}

const DEFAULTS: DefaultBinding[] = [
  // When inventory.stock.changed fires, ask projects to flip any
  // task dep that referenced this part. Replaces the old hardcoded
  // subscription in projects/src/api/subscribers.ts.
  {
    source_kind: "inventory:part",
    action_id: "projects:set-dep-satisfied",
    trigger_type: "event",
    trigger_event: "inventory.stock.changed",
  },
  // D9 from BACKLOG: order arrival auto-bumps part stock via a
  // user-editable wire instead of a hardcoded handler. The orders
  // route emits one purchases.order_item.received per line item
  // (with partId + delta); this wire fires inventory.adjust-stock
  // on each. End-users can swap action_id, edit the wire, or
  // disable it entirely.
  {
    source_kind: "purchases:order_item",
    action_id: "inventory:adjust-stock",
    trigger_type: "event",
    trigger_event: "purchases.order_item.received",
  },
];

export async function seedDefaultBindings(orgId: string): Promise<number> {
  let inserted = 0;
  for (const b of DEFAULTS) {
    // Idempotent — skip if a binding for this (kind, action,
    // trigger_event) already exists for the org.
    const existing = await meta
      .selectFrom("entity_action_bindings")
      .select("id")
      .where("org_id", "=", orgId)
      .where("source_kind", "=", b.source_kind)
      .where("action_id", "=", b.action_id)
      .where("trigger_event", b.trigger_event ? "=" : "is", b.trigger_event ?? null)
      .executeTakeFirst();
    if (existing) continue;
    await meta
      .insertInto("entity_action_bindings")
      .values({
        org_id: orgId,
        source_kind: b.source_kind,
        action_id: b.action_id,
        trigger_type: b.trigger_type,
        trigger_event: b.trigger_event ?? null,
        template: b.template ?? null,
      })
      .execute();
    inserted++;
  }
  void sql;
  return inserted;
}

/** Backfill: for every existing org, top up missing default bindings.
 *  Called once at boot so accounts that pre-date a new default get
 *  it without manual intervention. Cheap — one query + N idempotent
 *  inserts per org. */
export async function backfillDefaultBindings(): Promise<number> {
  const orgs = await meta.selectFrom("orgs").select("id").execute();
  let total = 0;
  for (const o of orgs) {
    try {
      total += await seedDefaultBindings(o.id);
    } catch (err) {
      console.error(`[seed-bindings] backfill failed for org ${o.id}:`, err);
    }
  }
  return total;
}
