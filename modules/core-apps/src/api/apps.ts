// /apps — WorkspaceApp CRUD + access. Authoring (create/update/delete)
// is admin/owner-only; reading is open to any member who can SEE the
// app (visible_capability). The app DEFINITION is structured data; the
// App Player (web) renders it by calling the existing view/action/
// entity endpoints, each of which independently enforces capability +
// field-read-scope. So this module never needs a privileged data path
// — it stores definitions and decides who may open which app.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const appsRouter = Router({ mergeParams: true });

// ── The structured app definition ────────────────────────────────
// Pages → blocks. Each block binds to an existing primitive (a saved
// view, an entity kind, an action). "Stay structured": blocks stack in
// a page; there is no freeform canvas. Validated on write so a
// hand- or AI-authored definition can't store garbage.
const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("view"), view_id: z.string().min(1), title: z.string().max(160).optional() }),
  z.object({ type: z.literal("record"), kind: z.string().min(1), id_from: z.string().min(1) }),
  z.object({
    type: z.literal("action"),
    action_id: z.string().min(1),
    label: z.string().max(160).optional(),
    kind: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("form"),
    kind: z.string().min(1),
    mode: z.enum(["create", "edit"]),
    fields: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("stat"),
    view_id: z.string().min(1),
    agg: z.enum(["count", "sum"]),
    field: z.string().optional(),
    label: z.string().max(160).optional(),
  }),
  z.object({ type: z.literal("markdown"), body: z.string().max(20_000) }),
  z.object({ type: z.literal("scan") }),
  // Tier B — a custom, author/AI-written frontend bundle (HTML+JS) the
  // App Player renders in a SANDBOXED iframe. The bundle never holds a
  // token nor calls the API directly: it requests reads via postMessage
  // and the Player mediates them with a short-lived capability-scoped
  // token, so the untrusted code can never exceed the member.
  z.object({
    type: z.literal("custom"),
    html: z.string().max(200_000),
    height: z.number().int().min(80).max(2000).optional(),
  }),
]);
const Page = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "page slug must be kebab-case"),
  title: z.string().min(1).max(160),
  blocks: z.array(Block).max(50),
});
const Pages = z.array(Page).max(30);

// ── Per-app theme tokens ─────────────────────────────────────────
// The point of an App is that it can look like the BUILDER'S thing, not
// like Cobblr. The structured blocks render through CSS variables; this
// is the palette that drives them. We store TOKENS, never raw CSS:
// colors are validated hex, `font` is a vetted keyword the Player maps
// to a real family, `radius` is a number — so a hand-/AI-authored theme
// can restyle the app without being able to inject a stylesheet. Every
// field is optional; anything unset falls back to Cobblr's defaults, so
// existing (theme-less) apps are unchanged.
const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "must be a hex color");
// A logo / font reference: either an http(s) URL or an inline `data:` URL
// (image/font/app). `data:` is how an in-app *upload* is stored — no
// auth-gated file fetch, no external CDN, fully self-hosted. Inert in
// <img src> / CSS url() (no script execution), and length-capped so the
// theme JSON stays bounded.
const assetRef = z
  .string()
  .regex(/^(https?:\/\/|data:(image|font|application)\/)/, "must be an http(s) or data: URL");
const Theme = z
  .object({
    bg: hex.optional(),          // page background
    surface: hex.optional(),     // card / block background
    text: hex.optional(),        // primary text
    muted: hex.optional(),       // labels / secondary text
    accent: hex.optional(),      // buttons, active, big numbers
    accent_text: hex.optional(), // text ON the accent
    border: hex.optional(),      // card borders
    font: z.enum(["sans", "serif", "mono", "rounded", "slab"]).optional(),
    radius: z.number().int().min(0).max(36).optional(), // card corner px
    logo: assetRef.max(500_000).optional(),       // wordmark image in the app's top bar
    font_url: assetRef.max(1_200_000).optional(), // a custom font (uploaded → data: URL, or a hosted URL)
    font_name: z.string().max(60).optional(),     // family name for the custom font
  })
  .strict();

const AppCreate = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "app slug must be kebab-case").max(80),
  name: z.string().min(1).max(160),
  icon: z.string().max(80).optional(),
  visible_capability: z.string().min(1).max(120).nullable().optional(),
  pages: Pages.default([]),
  theme: Theme.nullable().optional(),
});
const AppUpdate = z.object({
  name: z.string().min(1).max(160).optional(),
  icon: z.string().max(80).nullable().optional(),
  visible_capability: z.string().min(1).max(120).nullable().optional(),
  pages: Pages.optional(),
  theme: Theme.nullable().optional(),
});

interface AppRow {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  visible_capability: string | null;
  pages: unknown;
  theme: unknown;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** May the caller open this app? owner/admin always; otherwise the
 *  app's visible_capability must be null (open to all members) or one
 *  the member holds. Mirrors the dashboard's capability checks so the
 *  worker surface and the management surface agree. */
async function canOpen(req: Parameters<typeof tenantContext>[0], app: { visible_capability: string | null }): Promise<boolean> {
  const ctx = tenantContext(req);
  if (ctx.role === "owner" || ctx.role === "admin") return true;
  if (!app.visible_capability) return true;
  const user = sessionUser(req);
  if (!user) return false;
  return platform().auth.userHasCapability({
    orgId: ctx.org.id,
    userId: user.id,
    role: ctx.role,
    actionId: app.visible_capability,
  });
}

function toMeta(r: AppRow) {
  // `theme` rides along on the list so the member portal can resolve its
  // launcher skin (default-app's / sole-app's theme) without a second
  // round-trip per app. See web PortalLayout. Page bodies stay omitted.
  return { id: r.id, slug: r.slug, name: r.name, icon: r.icon, visible_capability: r.visible_capability, theme: r.theme ?? null };
}
function toFull(r: AppRow) {
  return { ...toMeta(r), pages: r.pages ?? [], theme: r.theme ?? null, created_at: r.created_at, updated_at: r.updated_at };
}

// GET /apps — apps the caller can open. Members see only the ones
// their capabilities grant; owner/admin see all. Metadata only (the
// nav doesn't need page bodies).
appsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = (await db
      .selectFrom("core_apps_apps")
      .selectAll()
      .orderBy("name")
      .execute()) as unknown as AppRow[];
    const visible: ReturnType<typeof toMeta>[] = [];
    for (const r of rows) {
      if (await canOpen(req, r)) visible.push(toMeta(r));
    }
    res.json({ items: visible });
  }),
);

// GET /apps/:slug — full definition for the App Player. 404 if the
// caller can't open it (don't leak existence of restricted apps).
appsRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const row = (await db
      .selectFrom("core_apps_apps")
      .selectAll()
      .where("slug", "=", req.params.slug!)
      .executeTakeFirst()) as unknown as AppRow | undefined;
    if (!row || !(await canOpen(req, row))) {
      res.status(404).json({ error: { code: "not_found", message: "App not found" } });
      return;
    }
    res.json(toFull(row));
  }),
);

// POST /apps/:slug/token — mint a short-lived, capability-scoped token
// (Tier B) for the App Player to mediate a sandboxed custom frontend's
// reads. Only if the caller can open the app. The token acts AS the
// member, so it's bounded by their capabilities + field-read-scope; it
// can never exceed them.
appsRouter.post(
  "/:slug/token",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const row = (await db
      .selectFrom("core_apps_apps")
      .selectAll()
      .where("slug", "=", req.params.slug!)
      .executeTakeFirst()) as unknown as AppRow | undefined;
    if (!row || !(await canOpen(req, row))) {
      res.status(404).json({ error: { code: "not_found", message: "App not found" } });
      return;
    }
    const user = sessionUser(req);
    if (!user) {
      res.status(401).json({ error: { code: "unauthenticated", message: "Auth required" } });
      return;
    }
    const minted = await platform().auth.mintAppToken({ userId: user.id, appSlug: row.slug });
    res.json(minted);
  }),
);

// POST /apps — author a new app (admin/owner only).
appsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = AppCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const user = sessionUser(req);
    const dupe = await db
      .selectFrom("core_apps_apps")
      .select("id")
      .where("slug", "=", parsed.data.slug)
      .executeTakeFirst();
    if (dupe) {
      res.status(409).json({ error: { code: "slug_taken", message: `An app with slug "${parsed.data.slug}" already exists.` } });
      return;
    }
    const created = (await db
      .insertInto("core_apps_apps")
      .values({
        slug: parsed.data.slug,
        name: parsed.data.name,
        icon: parsed.data.icon ?? null,
        visible_capability: parsed.data.visible_capability ?? null,
        pages: JSON.stringify(parsed.data.pages) as unknown as object,
        theme: parsed.data.theme ? (JSON.stringify(parsed.data.theme) as unknown as object) : null,
        created_by: user?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as unknown as AppRow;
    res.status(201).json(toFull(created));
  }),
);

// PATCH /apps/:slug — edit (admin/owner only).
appsRouter.patch(
  "/:slug",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = AppUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.icon !== undefined) patch.icon = parsed.data.icon;
    if (parsed.data.visible_capability !== undefined) patch.visible_capability = parsed.data.visible_capability;
    if (parsed.data.pages !== undefined) patch.pages = JSON.stringify(parsed.data.pages);
    if (parsed.data.theme !== undefined) patch.theme = parsed.data.theme ? JSON.stringify(parsed.data.theme) : null;
    const updated = (await db
      .updateTable("core_apps_apps")
      .set(patch)
      .where("slug", "=", req.params.slug!)
      .returningAll()
      .executeTakeFirst()) as unknown as AppRow | undefined;
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "App not found" } });
      return;
    }
    res.json(toFull(updated));
  }),
);

// DELETE /apps/:slug — remove (admin/owner only).
appsRouter.delete(
  "/:slug",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const r = await db
      .deleteFrom("core_apps_apps")
      .where("slug", "=", req.params.slug!)
      .executeTakeFirst();
    if (Number(r.numDeletedRows ?? 0) === 0) {
      res.status(404).json({ error: { code: "not_found", message: "App not found" } });
      return;
    }
    res.status(204).end();
  }),
);
