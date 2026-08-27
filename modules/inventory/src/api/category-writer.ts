// In-process entity writer for inventory:category.
//
// The isolation-clean way for another module to create, update or delete a
// category without touching inventory's table (module-isolation) or looping
// through the HTTP route. core-integrations' sync engine uses it to MIRROR a
// source's category tree: a category is a parent-to-child row exactly like a
// location, so the engine's parent id-map lands `parent_id` here unchanged.
//
// Two things the HTTP route knows that a writer must not forget:
//   • `slug` is NOT NULL and unique PER INSTANCE (inventory_categories_instance_slug_idx).
//     Two mirrored categories named "Passive" under different parents collide,
//     so the slug is derived here and de-collided the same way the route does.
//   • `instance` scopes the tree. A category lands in the instance its parts
//     are routed to (fields.instance, as the parts writer does), or a part's
//     category_id would point at a row its own list never shows.
//
// Silent by design, like the parts writer: no `inventory.category.*` emit, so
// a mirror of 200 categories does not fire 200 reactors.

import { platform, restoreRow, snapshotRow } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { InventoryDB } from "../db.js";
import { slugify } from "./util.js";

const TABLE = "inventory_categories";
let registered = false;

export function registerCategoryWriter(): void {
  if (registered) return;
  registered = true;

  platform().entities.registerWriter("inventory:category", {
    async create(orgId, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const name = String(fields.name ?? "Untitled");
      const instance = asStr(fields.instance) ?? "inventory";
      const slug = await freeSlug(db, instance, name);
      const inserted = await db
        .insertInto(TABLE)
        .values({
          name,
          slug,
          instance,
          color: asStr(fields.color),
          parent_id: asStr(fields.parent_id),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return inserted.id;
    },

    async update(orgId, id, fields) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const patch: Record<string, unknown> = { updated_at: new Date() };
      if (fields.name !== undefined) patch.name = String(fields.name);
      if (fields.color !== undefined) patch.color = asStr(fields.color);
      if (fields.parent_id !== undefined) patch.parent_id = asStr(fields.parent_id);
      if (fields.instance !== undefined) {
        const i = asStr(fields.instance);
        if (i != null) patch.instance = i;
      }
      await db.updateTable(TABLE).set(patch as never).where("id", "=", id).execute();
    },

    async delete(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      await db.deleteFrom(TABLE).where("id", "=", id).execute();
    },

    async read(orgId, id) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const row = await db
        .selectFrom(TABLE)
        .select(["name", "slug", "color", "parent_id", "instance"])
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? { ...row } : null;
    },

    /** Same-name merge targets for a one-time import, so a source's "Resistors"
     *  links onto the workspace's existing "Resistors" instead of a duplicate. */
    async listForMatch(orgId) {
      const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
      const rows = await db.selectFrom(TABLE).select(["id", "name", "parent_id"]).execute();
      return rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }));
    },

    /** Put the row back exactly as it was, id and all (EntityWriter.restore). */
    async restore(orgId, image) {
      await restoreRow(await platform().tenants.getDb(orgId), TABLE, image);
    },

    /** Every column of one row, the state an undo has to put back (EntityWriter.snapshot). */
    async snapshot(orgId, id) {
      return snapshotRow(await platform().tenants.getDb(orgId), TABLE, id);
    },
  });
}

/** A slug for `name` that is free within `instance`. Mirrors the HTTP route's
 *  rule (a random four-char suffix on collision, `cat-<ts>` for a name that
 *  slugifies to nothing) but RE-CHECKS after suffixing, since a mirror creates
 *  many rows in one pass and two same-named siblings can race the same suffix. */
export async function freeSlug(db: Kysely<InventoryDB>, instance: string, name: string): Promise<string> {
  const base = slugify(name) || `cat-${Date.now()}`;
  let candidate = base;
  for (let attempt = 0; attempt < 8; attempt++) {
    const taken = await db
      .selectFrom(TABLE)
      .select("id")
      .where("instance", "=", instance)
      .where("slug", "=", candidate)
      .executeTakeFirst();
    if (!taken) return candidate;
    candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function asStr(v: unknown): string | null {
  if (typeof v === "string") return v.length > 0 ? v : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}
