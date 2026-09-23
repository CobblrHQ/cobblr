// Move scan-category values into inventory's own tree (#3223).
//
// The platform's scan routing grew a choice field on `inventory:part` before
// inventory's tree could answer for it, so a part filed from a scan carried
// "Electrical" in `metadata.category` and nothing in `category_id`: the thing
// was categorised and the list's category filter never saw it. The platform
// orders this move before it removes that field; the move itself is here
// because only inventory may read inventory's table.
//
// The rules, each the one a person would expect:
// - a value finds the category that already exists under its normalised key
//   (the same key the seam ranks by, so "electrical" joins "Electrical"),
//   else a new one is created, in the PART's own instance, because a
//   category is per-instance and a part must point at one its list shows;
// - a part that already has a `category_id` keeps it (somebody chose it) and
//   loses only the stale metadata key;
// - a value that normalises to nothing ("unknown", "n/a") is a placeholder,
//   not a category: the key is dropped and nothing is created.
//
// Idempotent. `remaining` counts parts still holding the key afterwards, and
// the platform removes the field only at zero.

import { sql, type Kysely } from "kysely";
import { dedupeByKey } from "@cobblr/platform-contract/category-axis";
import { isJunkCategory, normaliseCategory } from "@cobblr/platform-contract/category-reconcile";
import type { InventoryDB } from "../db.js";
import { freeSlug } from "./category-writer.js";

export async function adoptAxisValuesInto(
  db: Kysely<InventoryDB>,
  args: { field: string; column: string },
): Promise<{ moved: number; remaining: number }> {
  if (args.column !== "category_id") return { moved: 0, remaining: await countHolding(db, args.field) };
  const field = args.field;
  const rows = await db
    .selectFrom("inventory_parts")
    .select(["id", "instance", "category_id", sql<unknown>`metadata -> ${field}`.as("value")])
    .where(sql<boolean>`metadata ? ${field}`)
    .execute();

  // Per instance: the categories that exist, by normalised key.
  const byInstance = new Map<string, Map<string, string>>();
  const categoriesIn = async (instance: string): Promise<Map<string, string>> => {
    const cached = byInstance.get(instance);
    if (cached) return cached;
    const existing = await db
      .selectFrom("inventory_categories")
      .select(["id", "name", "parent_id"])
      .where("instance", "=", instance)
      .execute();
    const map = new Map<string, string>();
    for (const c of dedupeByKey(existing.map((e) => ({ id: e.id, name: e.name, parentId: e.parent_id })))) {
      const key = normaliseCategory(c.name);
      if (key) map.set(key, c.id);
    }
    byInstance.set(instance, map);
    return map;
  };

  let moved = 0;
  for (const r of rows) {
    const raw = typeof r.value === "string" ? r.value.trim() : "";
    // "unknown", "n/a", a stringified "undefined": a placeholder, not a
    // category. The key is dropped and nothing is created for it.
    const key = raw && !isJunkCategory(raw) ? normaliseCategory(raw) : null;
    let categoryId = r.category_id;
    if (!categoryId && raw && key) {
      const cats = await categoriesIn(r.instance);
      categoryId = cats.get(key) ?? null;
      if (!categoryId) {
        const created = await db
          .insertInto("inventory_categories")
          .values({ name: raw, slug: await freeSlug(db, r.instance, raw), instance: r.instance, color: null, parent_id: null } as never)
          .returning("id")
          .executeTakeFirstOrThrow();
        categoryId = created.id;
        cats.set(key, categoryId);
      }
    }
    await db
      .updateTable("inventory_parts")
      .set({
        ...(categoryId && !r.category_id ? { category_id: categoryId } : {}),
        metadata: sql`metadata - ${field}`,
        updated_at: new Date(),
      } as never)
      .where("id", "=", r.id)
      .execute();
    if (categoryId && !r.category_id) moved++;
  }
  return { moved, remaining: await countHolding(db, field) };
}

async function countHolding(db: Kysely<InventoryDB>, field: string): Promise<number> {
  const r = await db
    .selectFrom("inventory_parts")
    .select(sql<number>`count(*)::int`.as("n"))
    .where(sql<boolean>`metadata ? ${field}`)
    .executeTakeFirst();
  return r?.n ?? 0;
}
