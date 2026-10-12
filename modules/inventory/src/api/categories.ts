// /categories — list + create for now. Update + delete come when
// the UI needs them.

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, slugify } from "./util.js";
import { optionalField } from "@cobblr/platform-contract/optional-fields";

export const categoriesRouter = Router({ mergeParams: true });

const CategoryCreate = z.object({
  name: z.string().min(1).max(120),
  color: optionalField(z.string().regex(/^#[0-9a-fA-F]{3,8}$/)),
  parent_id: z.string().uuid().nullable().optional(),
});

categoriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("inventory_categories")
      .select(["id", "name", "slug", "color", "parent_id", "created_at"])
      .orderBy("name")
      .execute();
    res.json({ items: rows });
  }),
);

// AI-ACTION: inventory:add-category
categoriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "inventory:add-category"))) return;
    const parsed = CategoryCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const slug = slugify(parsed.data.name) || `cat-${Date.now()}`;

    // Slug must be unique within the org's tenant DB. If it
    // collides we suffix with a short random — keeps the create
    // request idempotent-ish without a retry loop.
    const existing = await db
      .selectFrom("inventory_categories")
      .select("id")
      .where("slug", "=", slug)
      .executeTakeFirst();
    const finalSlug = existing
      ? `${slug}-${Math.random().toString(36).slice(2, 6)}`
      : slug;

    // Two creates of one name at once both found the slug free: the second
    // takes a suffixed one, as the check above would have given it.
    const insertWith = (slugToUse: string) =>
      db
        .insertInto("inventory_categories")
        .values({
          name: parsed.data.name,
          slug: slugToUse,
          color: parsed.data.color ?? null,
          parent_id: parsed.data.parent_id ?? null,
        })
        .onConflict((oc) => oc.doNothing())
        .returning(["id", "name", "slug", "color", "parent_id", "created_at"])
        .executeTakeFirst();
    const inserted =
      (await insertWith(finalSlug)) ??
      (await insertWith(`${slug}-${Math.random().toString(36).slice(2, 6)}`)) ??
      (() => {
        throw new Error("could not find a free slug for the category");
      })();

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "category_created",
      ref: { module: "inventory", entityType: "category", entityId: inserted.id },
      diff: { name: inserted.name, slug: inserted.slug },
    });
    platform().events.emit("inventory.category.created", {
      orgId: ctx.org.id,
      categoryId: inserted.id,
    });

    res.status(201).json(inserted);
  }),
);
