// Food moved into the fridge or the freezer is re-dated by its cold shelf life,
// and by its warm one when it comes out (kitchen-participation.md section 2).
// Rides core-placement.placed: it costs nothing at rest and fires at the
// moment the shelf life changes.
//
// What it will not do: touch an item that states no number for where it now
// is, or a lot whose date is not provably on one of the item's clocks
// (cold-shelf-life.ts). Moving food is a daily thing; a date guessed on every
// move would teach a household to ignore the dates.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { requirementImpliedByPlace, type StorageRequirement } from "@cobblr/platform-contract/storage-requirement";
import type { InventoryDB } from "./db.js";
import { batchesFrom, earliestExpiry } from "./batches.js";
import { clockFor, clockNumbers, restateLots, type Clock } from "./cold-shelf-life.js";

const LOCATION_KIND = "core-locations:location";

/** How the place keeps food, from its own name or the nearest place around it
 *  that has one ("Shelf 2" in the Fridge is the fridge). Null when none says. */
async function coldnessOfPlace(orgId: string, container: { kind: string; id: string }): Promise<StorageRequirement | null> {
  let ref: { kind: string; id: string } | null = container;
  for (let hop = 0; hop < 8 && ref; hop++) {
    const resolved = await platform().entities.lookup(orgId, ref.kind, ref.id);
    const implied = requirementImpliedByPlace(resolved?.title);
    if (implied) return implied;
    const up = await platform().placement.containerOf({ orgId, containee: ref });
    const parentId = typeof resolved?.fields?.parent_id === "string" ? resolved.fields.parent_id : null;
    ref = up && up.kind === LOCATION_KIND ? { kind: up.kind, id: up.id } : parentId ? { kind: LOCATION_KIND, id: parentId } : null;
  }
  return null;
}

const WORDS: Record<Clock, string> = { refrigerated: "moved to the fridge", frozen: "moved to the freezer", warm: "taken out of the cold" };

let registered = false;

export function registerColdRedate(): void {
  if (registered) return;
  registered = true;
  platform().events.on("core-placement.placed", "inventory", async (raw: unknown) => {
    const p = (raw ?? {}) as { orgId?: string; containeeKind?: string; containeeId?: string; containerKind?: string; containerId?: string };
    if (!p.orgId || !p.containeeKind || !p.containeeId || !p.containerKind || !p.containerId) return;
    try {
      if ((await platform().entities.baseKindOf(p.orgId, p.containeeKind)) !== "inventory:part") return;
      const db = (await platform().tenants.getDb(p.orgId)) as Kysely<InventoryDB>;
      const row = await db.selectFrom("inventory_parts").select(["qty", "metadata"]).where("id", "=", p.containeeId).executeTakeFirst();
      if (!row) return;
      const md = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const numbers = clockNumbers(md);
      // States no cold number: nothing for a move to say.
      if (numbers.refrigerated === null && numbers.frozen === null) return;

      const clock = clockFor(await coldnessOfPlace(p.orgId, { kind: p.containerKind, id: p.containerId }));
      const kind = await platform().entities.resolvedKindForEntity(p.orgId, "inventory:part", p.containeeId).catch(() => "inventory:part");
      const roles = await platform().entities.roledFieldsFor(p.orgId, kind).catch(() => []);
      const expiryField = roles.find((f) => f.field_role === "expiry")?.name ?? "expires_on";
      const acquiredField = roles.find((f) => f.field_role === "acquired-on")?.name ?? "acquired_on";

      const kept = Array.isArray(md.batches) && md.batches.length > 0;
      const visible = typeof md[expiryField] === "string" ? (md[expiryField] as string) : null;
      const received = typeof md[acquiredField] === "string" ? (md[acquiredField] as string) : "";
      // A record with no lots of its own is the one lot it effectively is, as
      // far as its arrival day is told (the day it was bought).
      const lots = kept ? batchesFrom(md, Number(row.qty), visible) : visible ? [{ received_on: received, expires_on: visible, qty: Number(row.qty) }] : [];
      const restated = restateLots(lots, numbers, clock);
      if (!restated.changed) return;

      const to = earliestExpiry(restated.batches);
      const patch: Record<string, unknown> = { ...(kept ? { batches: restated.batches } : {}), ...(to ? { [expiryField]: to } : {}) };
      await db
        .updateTable("inventory_parts")
        .set({ metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updated_at: new Date() })
        .where("id", "=", p.containeeId)
        .execute();
      await platform().activity.log({
        orgId: p.orgId,
        userId: null,
        action: "part_redated",
        ref: { module: "inventory", entityType: "part", entityId: p.containeeId },
        diff: { said: `${WORDS[clock]}: good until ${to ?? "no date"}`, from: visible, to, clock },
      });
    } catch (err) {
      // A subscriber must never be able to fail a move.
      console.warn("[inventory] a cold move did not re-date its lots:", (err as Error).message);
    }
  });
}
