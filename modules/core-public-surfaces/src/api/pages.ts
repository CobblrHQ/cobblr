// /pages: public pages and their links (#4502; docs/design-decisions/share-scope.md).
//
// A page is a scope (which records) and a visibility (what of them), the very
// definitions a share uses (@cobblr/platform-contract/share-scope), stored as
// read through readScope / readVisibility so nothing malformed is kept. It is
// seen only through its links: surfaces with scope_type 'page', each with its
// own unguessable token, label, expiry and visibility, so one page can have a
// bare link and a detailed one. The public read is the platform's
// /api/v1/public/:token.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { readScope, readVisibility, type VisibilityDef } from "@cobblr/platform-contract/share-scope";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { createSurface, metaDb } from "./surfaces.js";
import { platform } from "@cobblr/platform-contract";
import { instantFromInput } from "@cobblr/platform-contract/day";

export const pagesRouter = Router({ mergeParams: true });

const PageBody = z.object({
  name: z.string().min(1).max(160),
  scope: z.unknown().optional(),
  visibility: z.unknown().optional(),
  layout: z.enum(["gallery", "table"]).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  label_door: z.boolean().optional(),
  public_until: z.string().datetime().nullable().optional(),
  contact: z
    .string()
    .max(300)
    .regex(/^(https?:\/\/|mailto:)/i, "a contact is a web address or mailto:")
    .nullable()
    .optional(),
  footer: z.boolean().optional(),
  show_fields: z.array(z.string().min(1).max(120)).max(60).nullable().optional(),
  about: z.string().max(2000).nullable().optional(),
  links: z
    .array(z.object({ label: z.string().min(1).max(80), url: z.string().max(500).regex(/^(https?:\/\/|mailto:)/i, "a link is a web address or mailto:") }))
    .max(10)
    .optional(),
  skin_html: z.string().max(200_000).nullable().optional(),
  indexable: z.boolean().optional(),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i, "an accent is a colour like #3b82f6").nullable().optional(),
  address: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, "an address is 1 to 40 lowercase letters, digits and dashes, like my-printers")
    .nullable()
    .optional(),
});

/** The link a memorable address opens through: one per page, marked
 *  config.named, showing the page's own visibility. */
async function namedLinks(db: ReturnType<typeof tenantDb>, pageId: string) {
  return db
    .selectFrom("core_public_surfaces_surfaces")
    .select(["id", "token", "config"])
    .where("scope_type", "=", "page")
    .where("scope_id", "=", pageId)
    .where("revoked_at", "is", null)
    .execute()
    .then((rows) => rows.filter((r) => (r.config as Record<string, unknown> | null)?.named === true));
}

/** Give a page its memorable address's link, or end it. */
async function settleNamedLink(req: Parameters<typeof tenantDb>[0], pageId: string, on: boolean): Promise<void> {
  const db = tenantDb(req);
  const have = await namedLinks(db, pageId);
  if (on && !have.length) {
    await createSurface(db, tenantContext(req).org.id, sessionUser(req)?.id ?? null, { name: "Memorable address", scope_type: "page", scope_id: pageId, config: { named: true }, expires_at: null });
  }
  if (!on) {
    for (const l of have) await metaDb().deleteFrom("public_surface_tokens").where("token", "=", l.token).execute();
    if (have.length) await db.updateTable("core_public_surfaces_surfaces").set({ revoked_at: new Date(), updated_at: new Date() }).where("id", "in", have.map((l) => l.id)).execute();
  }
}

/** A link's own visibility, or the page's when the link says nothing. Only
 *  keys the link sets override the page's. */
export function linkVisibility(page: unknown, link: unknown): VisibilityDef {
  const p = readVisibility(page);
  const l = (link && typeof link === "object" ? link : null) as Record<string, unknown> | null;
  if (!l) return p;
  return readVisibility({ ...p, ...l });
}

// UI-REACH: Settings → Sharing → Public pages
// AI-REACH: exempt what is made public, and to whom, is a person's decision in Settings, Sharing; an assistant never publishes
pagesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const pages = await db.selectFrom("core_public_surfaces_pages").selectAll().orderBy("created_at", "desc").execute();
    const links = await db
      .selectFrom("core_public_surfaces_surfaces as s")
      .leftJoin("core_public_surfaces_views as v", "v.surface_id", "s.id")
      .select(["s.id", "s.name", "s.token", "s.scope_id", "s.config", "s.expires_at", "s.enabled", "s.created_at", (eb) => eb.fn.count<string>("v.id").as("visits")])
      .where("s.scope_type", "=", "page")
      .where("s.revoked_at", "is", null)
      .groupBy("s.id")
      .orderBy("s.created_at")
      .execute();
    const me = sessionUser(req)?.id ?? null;
    const orgSlug = tenantContext(req).org.slug;
    const today = await platform().accounts.dayFor(me);
    const weekStart = await platform().accounts.dayFor(me, { now: new Date(Date.now() - 6 * 86_400_000) });
    // The day as text, never a Date: a date column read into a Date is local
    // midnight, and its ISO form can be the day before.
    const scans = await db
      .selectFrom("core_public_surfaces_label_scans")
      .select(["page_id", sql<string>`day::text`.as("day"), "count"])
      .where("day", ">=", weekStart)
      .execute();
    res.json({
      items: pages.map((p) => ({
        ...p,
        // The page's own addresses for visitors ("Store"); `links` below is
        // its share links.
        out_links: p.links ?? [],
        label_scans_today: scans.filter((s) => s.page_id === p.id && s.day === today).reduce((n, s) => n + Number(s.count), 0),
        label_scans_week: scans.filter((s) => s.page_id === p.id).reduce((n, s) => n + Number(s.count), 0),
        scope: readScope(p.scope),
        visibility: readVisibility(p.visibility),
        links: links
          .filter((l) => l.scope_id === p.id)
          .map((l) => ({
            id: l.id,
            label: l.name,
            // The memorable address's own link reads as the address.
            named: (l.config as Record<string, unknown>)?.named === true,
            url: (l.config as Record<string, unknown>)?.named === true && p.address ? `/p/${orgSlug}/${p.address}` : `/p/${l.token}`,
            visibility: linkVisibility(p.visibility, (l.config as Record<string, unknown>)?.visibility),
            own_visibility: !!(l.config as Record<string, unknown>)?.visibility,
            expires_at: l.expires_at,
            enabled: l.enabled,
            visits: Number(l.visits ?? 0),
            created_at: l.created_at,
          })),
      })),
    });
  }),
);

// UI-REACH: Settings → Sharing → Public pages ("New public page")
// AI-REACH: exempt what is made public, and to whom, is a person's decision in Settings, Sharing; an assistant never publishes
pagesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = PageBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const page = await db
      .insertInto("core_public_surfaces_pages")
      .values({
        name: parsed.data.name,
        scope: JSON.stringify(readScope(parsed.data.scope)) as never,
        visibility: JSON.stringify(readVisibility(parsed.data.visibility)) as never,
        layout: parsed.data.layout ?? "gallery",
        created_by: sessionUser(req)?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(page);
  }),
);

// UI-REACH: Settings → Sharing → Public pages (a page's "What it shows", Save)
// AI-REACH: exempt what is made public, and to whom, is a person's decision in Settings, Sharing; an assistant never publishes
pagesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = PageBody.partial().safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) set.name = parsed.data.name;
    if (parsed.data.scope !== undefined) set.scope = sql`${JSON.stringify(readScope(parsed.data.scope))}::jsonb`;
    if (parsed.data.visibility !== undefined) set.visibility = sql`${JSON.stringify(readVisibility(parsed.data.visibility))}::jsonb`;
    if (parsed.data.layout !== undefined) set.layout = parsed.data.layout;
    if (parsed.data.label_door !== undefined) set.label_door = parsed.data.label_door;
    if (parsed.data.public_until !== undefined) set.public_until = instantFromInput(parsed.data.public_until, null, "end");
    if (parsed.data.contact !== undefined) set.contact = parsed.data.contact || null;
    if (parsed.data.footer !== undefined) set.footer = parsed.data.footer;
    if (parsed.data.show_fields !== undefined) set.show_fields = parsed.data.show_fields === null ? null : sql`${JSON.stringify(parsed.data.show_fields)}::jsonb`;
    if (parsed.data.about !== undefined) set.about = parsed.data.about?.trim() || null;
    if (parsed.data.links !== undefined) set.links = sql`${JSON.stringify(parsed.data.links)}::jsonb`;
    if (parsed.data.skin_html !== undefined) set.skin_html = parsed.data.skin_html?.trim() || null;
    if (parsed.data.indexable !== undefined) set.indexable = parsed.data.indexable;
    if (parsed.data.accent !== undefined) set.accent = parsed.data.accent?.toLowerCase() ?? null;
    if (parsed.data.address !== undefined) set.address = parsed.data.address || null;
    const page = await tenantDb(req)
      .updateTable("core_public_surfaces_pages")
      .set(set as never)
      .where("id", "=", String(req.params.id))
      .returningAll()
      .executeTakeFirst()
      .catch((err: { code?: string }) => {
        if (err?.code === "23505") return "taken" as const;
        throw err;
      });
    if (page === "taken") {
      res.status(409).json({ error: { code: "address_taken", message: "Another page here already has that address." } });
      return;
    }
    if (!page) {
      res.status(404).json({ error: { code: "not_found", message: "No such page." } });
      return;
    }
    if (parsed.data.address !== undefined) await settleNamedLink(req, page.id, !!page.address);
    res.json(page);
  }),
);

const LinkBody = z.object({
  label: z.string().min(1).max(160),
  /** The link's own "what's shown"; absent, it shows what the page does. */
  visibility: z.unknown().optional(),
  expires_at: z.string().datetime().nullable().optional(),
});

// UI-REACH: Settings → Sharing → Public pages → a page → Links ("New link")
// AI-REACH: exempt what is made public, and to whom, is a person's decision in Settings, Sharing; an assistant never publishes
pagesRouter.post(
  "/:id/links",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = LinkBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const page = await db.selectFrom("core_public_surfaces_pages").select("id").where("id", "=", String(req.params.id)).executeTakeFirst();
    if (!page) {
      res.status(404).json({ error: { code: "not_found", message: "No such page." } });
      return;
    }
    const row = await createSurface(db, tenantContext(req).org.id, sessionUser(req)?.id ?? null, {
      name: parsed.data.label,
      scope_type: "page",
      scope_id: page.id,
      config: parsed.data.visibility !== undefined ? { visibility: readVisibility(parsed.data.visibility) } : {},
      expires_at: parsed.data.expires_at ?? null,
    });
    res.status(201).json({ id: row.id, label: row.name, url: `/p/${row.token}`, expires_at: row.expires_at });
  }),
);

// UI-REACH: Settings → Sharing → Public pages (Delete page)
// AI-REACH: exempt deleting a public page ends every link to it, a person's decision in Settings, Sharing
pagesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const id = String(req.params.id);
    // Every link to it dies at once; then the page.
    const links = await db.selectFrom("core_public_surfaces_surfaces").select(["id", "token"]).where("scope_type", "=", "page").where("scope_id", "=", id).where("revoked_at", "is", null).execute();
    for (const l of links) await metaDb().deleteFrom("public_surface_tokens").where("token", "=", l.token).execute();
    await db.updateTable("core_public_surfaces_surfaces").set({ revoked_at: new Date(), updated_at: new Date() }).where("scope_type", "=", "page").where("scope_id", "=", id).where("revoked_at", "is", null).execute();
    await db.deleteFrom("core_public_surfaces_pages").where("id", "=", id).execute();
    res.status(204).end();
  }),
);
