// Un-authenticated public read endpoint for core-public-surfaces.
//
// Mounted at /api/v1/public/:token. Looks up the token in
// cobblr_meta.public_surface_tokens → resolves to (org_id,
// surface_id) → opens the tenant DB → reads the surface row →
// resolves the scope through platform.entities.lookup / list →
// returns the projected data (exposableFields-filtered, since the
// "caller" is anonymous, no module).
//
// Why this lives at the platform layer rather than inside the
// core-public-surfaces module: the URL has no slug. Modules' own
// routers are mounted at /api/v1/orgs/:slug/modules/<name>/... and
// require auth. We need a route OUTSIDE that scope. Today that's
// platform code; if a second module ever wants a similar
// no-slug-no-auth URL pattern we generalize this into a primitive.

import { productName } from "../platform/product-name.js";
import { Router } from "express";
import type { Kysely } from "kysely";
import { createHmac, timingSafeEqual } from "node:crypto";
import { platform, viewQuery, type EntityListQuery, type EntityListResult } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { FrameDocTooLarge, putFrameDoc } from "../platform/frame-docs.js";
import { FrameDocBody } from "./frame-docs.js";
import { env } from "../env.js";
import { ttlCache } from "../lib/ttl-cache.js";
import { statKey, statValue } from "@cobblr/platform-contract/stat-value";
import { classifyField, fieldVisible, projectRecord, readVisibility } from "@cobblr/platform-contract/share-scope";
import { fieldsOf } from "../platform/share-mirror.js";
import { hiddenFieldsFor } from "../platform/entities.js";
import { fieldsNamedBy } from "../platform/field-scope-projection.js";
import { countLabelScan, labelPublicRecord, pageFrame, pageIsLive, publicPageRecord, publicPageRecords, skinDocument } from "../platform/public-page.js";
import { resolveQrToken } from "./qr-scan.js";

import { z } from "zod";
import { answerReply, readReply, readStopToken, stopMessages } from "../platform/external-messages.js";
export const publicRouter = Router();

// What a public address answers is data for the page that shows it, never a
// result of its own; whether a page may be listed is said by the page.
publicRouter.use((_req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex");
  next();
});

// Verify a scan-export photo token → { orgId, fileId } (or null). Byte-compatible
// mirror of modules/core-scan/src/services/export-token.ts `verifyExportToken` —
// keep the two in lockstep (same payload shape, same HMAC over JWT_SECRET).
// A token carries `f` (the one file it authorises); a legacy token without `f`
// grants org-wide image read so in-flight pre-per-file exports keep working.
function verifyScanExportToken(token: string): { orgId: string; fileId: string | null } | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const expected = createHmac("sha256", env.JWT_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    // b64-lenient-ok: the signature was checked over the payload string as given, so only its one spelling reaches here.
    const { o, f, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { o?: unknown; f?: unknown; e?: unknown };
    if (typeof o !== "string" || typeof e !== "number" || Date.now() > e) return null;
    return { orgId: o, fileId: typeof f === "string" ? f : null };
  } catch {
    return null;
  }
}

interface SurfaceRow {
  id: string;
  name: string;
  scope_type: "view" | "entity" | "collection" | "board" | "app" | "page";
  scope_id: string;
  config: Record<string, unknown>;
  enabled: boolean;
  expires_at: Date | null;
  revoked_at: Date | null;
}

interface PageRow {
  id: string;
  name: string;
  scope: unknown;
  visibility: unknown;
  layout: string;
  public_until: Date | null;
  contact: string | null;
  footer: boolean;
  show_fields: string[] | null;
  about: string | null;
  links: Array<{ label: string; url: string }> | null;
  skin_html: string | null;
  indexable: boolean;
  accent: string | null;
}

/** What one link to a page shows: the page's visibility, with whatever the
 *  link sets for itself over it. */
function pageLinkVisibility(page: PageRow, surface: SurfaceRow) {
  const own = (surface.config as { visibility?: unknown } | null)?.visibility;
  const base = readVisibility(page.visibility);
  return own && typeof own === "object" ? readVisibility({ ...base, ...(own as Record<string, unknown>) }) : base;
}

interface ViewRow {
  id: string;
  entity_kind: string;
  view_type: string;
  config: Record<string, unknown>;
  name: string;
}

interface AppRow {
  slug: string;
  name: string;
  pages: unknown;
  theme: unknown;
}

// Minimal block shape — we only read the fields the public render needs.
interface AppBlock {
  type: string;
  view_id?: string;
  agg?: "count" | "sum";
  field?: string;
  times?: string;
  label?: string;
  title?: string;
  html?: string;
  height?: number;
  body?: string;
}
interface AppPage {
  slug?: string;
  title?: string;
  blocks?: AppBlock[];
}

// Resolve + validate a surface token against the meta index. Shared by
// the data route and the public file route so the gate is identical.
async function resolveToken(token: string | undefined): Promise<
  | { ok: true; orgId: string; surfaceId: string }
  | { ok: false; status: number; code: string; message: string }
> {
  if (!token || token.length < 16) {
    return { ok: false, status: 404, code: "not_found", message: "no such surface" };
  }
  const tokenRow = await meta
    .selectFrom("public_surface_tokens")
    .selectAll()
    .where("token", "=", token)
    .executeTakeFirst();
  if (!tokenRow || tokenRow.revoked_at !== null || !tokenRow.enabled) {
    return { ok: false, status: 404, code: "not_found", message: "no such surface" };
  }
  if (tokenRow.expires_at && tokenRow.expires_at < new Date()) {
    return { ok: false, status: 410, code: "expired", message: "this surface has expired" };
  }
  return { ok: true, orgId: tokenRow.org_id, surfaceId: tokenRow.surface_id };
}

// Image fields resolve to an authed member URL (/api/v1/orgs/<slug>/…
// /files/<id>/raw or a bare /files/<id>/raw). The public page holds no
// token, so rewrite to the no-auth, token-gated public file route below.
const FILE_ID_RE = /\/files\/([0-9a-fA-F-]{36})\/raw/;
function publicImg(p: unknown, token: string): unknown {
  if (typeof p !== "string") return p;
  const m = p.match(FILE_ID_RE);
  return m ? `/api/v1/public/${token}/files/${m[1]}/raw` : p;
}
function curateItem(it: unknown, token: string): unknown {
  if (!it || typeof it !== "object") return it;
  const src = it as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  if (out.image_path) out.image_path = publicImg(out.image_path, token);
  if (out.fields && typeof out.fields === "object") {
    const f = { ...(out.fields as Record<string, unknown>) };
    if (f.image_path) f.image_path = publicImg(f.image_path, token);
    out.fields = f;
  }
  return out;
}
function curateItems(items: unknown, token: string): unknown {
  return Array.isArray(items) ? items.map((i) => curateItem(i, token)) : items;
}
/** The rows a saved view shows to a public reader: the view's own query
 *  (filter, where and sort) read the one way every surface reads it
 *  (viewQuery), on the day that has arrived everywhere, since a public
 *  reader has no zone of their own. A public view used to pass only filter
 *  and sort, so a "Status is not Draft" view published its drafts (#7126).
 *  It fails closed: a list that failed, or that could not run one of the
 *  view's conditions, shows nothing rather than more than the owner chose. */
export async function publicViewRows(orgId: string, view: { entity_kind: string; config: unknown }, limit: number): Promise<EntityListResult["items"]> {
  const today = await platform().accounts.dayFor(null);
  return publicList(orgId, view.entity_kind, { ...viewQuery((view.config as Record<string, unknown> | null) ?? {}, today), today, limit });
}

/** How a public page looks, the only part of a surface's configuration it
 *  is sent. A query, a board's columns or a page's visibility name fields
 *  and the values the owner looked for: a collection filtered on a private
 *  diary sent the diary to every visitor inside its filter (#8041). Anything
 *  else a configuration holds stays with the owner. */
const PUBLIC_LOOK = ["theme", "layout", "banner_image", "footer", "refresh_seconds", "epaper"] as const;
export function publicSurfaceConfig(config: unknown): Record<string, unknown> {
  const own = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  return Object.fromEntries(PUBLIC_LOOK.filter((k) => own[k] !== undefined && (typeof own[k] !== "object" || own[k] === null)).map((k) => [k, own[k]]));
}

/** The fields of a kind a signed-out reader may not read: what
 *  publicFieldsOnly takes out of a record, asked of a field's name. */
async function publicHides(orgId: string, kind: string): Promise<(field: string) => boolean> {
  const [defs, gated] = await Promise.all([fieldsOf(orgId, kind), hiddenFieldsFor(orgId, kind, {})]);
  const byName = new Map(defs.map((d) => [d.name, d]));
  return (field) => {
    const name = field.replace(/^metadata\./, "");
    return !fieldVisible(classifyField(byName.get(name) ?? { name }, gated), name, PUBLIC_SURFACE_VISIBILITY);
  };
}

/** Every string a record shows, for a search to be held to. */
function shownText(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v.toLowerCase());
  else if (typeof v === "number") out.push(String(v));
  else if (Array.isArray(v)) for (const x of v) shownText(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) shownText(x, out);
  return out;
}

/** The records a public surface lists, read the way a signed-out visitor
 *  reads them: the owner's query asked only of fields a visitor may read.
 *  A condition on any other field (a private diary, a scoped description, a
 *  price) shows nothing rather than answering, by which records came back,
 *  what that field holds; an order by one is left out; a search keeps only
 *  the records it found in what the visitor is shown. It fails closed: a
 *  list that failed, or could not run one of its conditions, shows nothing
 *  rather than more than the owner chose. */
export async function publicList(orgId: string, kind: string, query: EntityListQuery): Promise<EntityListResult["items"]> {
  const hides = await publicHides(orgId, kind);
  if (fieldsNamedBy({ filter: query.filter, where: query.where }).some(hides)) return [];
  const asked = { ...query, sort: query.sort?.filter((f) => !hides(f.replace(/^-/, ""))), dropUnreadable: true };
  const result = await platform().entities.list(orgId, kind, asked, { publicRead: true });
  const shown = await publicFieldsOnly(orgId, kind, publicRows(result));
  const needle = query.q?.trim().toLowerCase();
  if (!needle) return shown;
  return shown.filter((r) => shownText([(r as { title?: unknown }).title, r.fields]).some((t) => t.includes(needle)));
}

/** What a signed-out reader may see of a public surface's records: never a
 *  field the owner marked private, a field behind a read scope, a secret, or
 *  a price, on any surface, as a public page shows them by default (#7830).
 *  Hiding them in the page's drawing was not enough: the answer carried
 *  them. Places stay, as these surfaces always showed them. */
const PUBLIC_SURFACE_VISIBILITY = { prices: false, private_notes: false, places: true, restricted: [] as string[] };
export async function publicFieldsOnly<T extends { fields?: unknown }>(orgId: string, kind: string, items: T[]): Promise<T[]> {
  if (!items.length) return items;
  const [defs, gated] = await Promise.all([fieldsOf(orgId, kind), hiddenFieldsFor(orgId, kind, {})]);
  return items.map((it) => {
    const fields = it?.fields;
    if (!fields || typeof fields !== "object") return it;
    const shown = projectRecord({ fields: fields as Record<string, unknown> }, defs, gated, PUBLIC_SURFACE_VISIBILITY);
    return { ...it, fields: { ...shown.fields, metadata: shown.metadata } };
  });
}

/** A public list's rows, or none when the list cannot vouch for them. */
export function publicRows(result: EntityListResult): EntityListResult["items"] {
  if (result.failed || (result.unapplied?.length ?? 0) > 0) return [];
  return result.items;
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

// The public twin of POST /frame-docs, for the anonymous page that renders a
// custom block and holds no session. Gated on the same surface token as the
// page itself: whoever can read the surface can already see this HTML, so
// handing it back on a one-shot URL adds no capability (#3300). Registered
// ABOVE /:token so the literal path is reachable (lint:route-shadowing).
// AI-REACH: exempt — the same rendering detail, for the anonymous page.
publicRouter.post("/:token/frame-docs", (req, res, next) => {
  void (async () => {
    const tok = await resolveToken(String(req.params.token ?? ""));
    if (!tok.ok) {
      res.status(tok.status).json({ error: { code: tok.code, message: tok.message } });
      return;
    }
    const parsed = FrameDocBody.safeParse(req.body);
    // A public surface renders app blocks and nothing else, so the kind is not
    // the caller's to choose here.
    if (!parsed.success || parsed.data.kind !== "app-block") {
      res.status(400).json({ error: { code: "invalid_body", message: "html and kind:app-block are required." } });
      return;
    }
    try {
      const id = putFrameDoc(parsed.data.html, "app-block");
      res.status(201).json({ url: `/api/v1/frame-docs/${id}`, expires_in: 60 });
    } catch (e) {
      if (e instanceof FrameDocTooLarge) {
        res.status(413).json({ error: { code: "too_large", message: "That frame document is too large to render." } });
        return;
      }
      throw e;
    }
  })().catch(next);
});

// A record's printed label, scanned by a stranger: its public view, through
// the live page that opens its labels (#4502). Answers only to the label's
// long random token (the short code printed beside it is not a token), and
// says nothing of a record no page opens.
// AI-REACH: exempt — an anonymous visitor's read of a label they scanned
publicRouter.get("/label", (req, res, next) => {
  void (async () => {
    const t = typeof req.query.t === "string" ? req.query.t : "";
    const qr = t ? await resolveQrToken(t) : null;
    const view = qr?.ok && qr.mode === "navigate" ? await labelPublicRecord(qr.org_id!, qr.entity_kind!, qr.entity_id!, t) : null;
    if (!view) {
      res.status(404).json({ error: { code: "not_public", message: `This belongs to someone else's ${productName()}.` } });
      return;
    }
    if (req.get(/* PRODUCT-NAME: A wire protocol header shared by existing clients and servers. */ "X-Cobblr-Visit") === "1") {
      await countLabelScan(qr!.org_id!, view.pageId, view.ownerId).catch((err) => console.error("[public] label scan count failed:", (err as Error).message));
    }
    res.json({ page: view.page, record: view.record });
  })().catch(next);
});

// The page's custom look for this label's record: a one-shot sandboxed
// document handed only what the page shows (#4502, Tier B).
publicRouter.get("/label/skin", (req, res, next) => {
  void (async () => {
    const t = typeof req.query.t === "string" ? req.query.t : "";
    const qr = t ? await resolveQrToken(t) : null;
    const view = qr?.ok && qr.mode === "navigate" ? await labelPublicRecord(qr.org_id!, qr.entity_kind!, qr.entity_id!, t) : null;
    if (!view || !view.skinHtml) {
      res.status(404).json({ error: { code: "not_found", message: "no custom look" } });
      return;
    }
    res.json({ url: skinDocument(view.skinHtml, { record: view.record, page: view.page }) });
  })().catch(next);
});

// That view's photo, and only that record's: the label's token is the gate.
publicRouter.get("/label/photo/:id", (req, res, next) => {
  void (async () => {
    const t = typeof req.query.t === "string" ? req.query.t : "";
    const qr = t ? await resolveQrToken(t) : null;
    const view = qr?.ok && qr.mode === "navigate" ? await labelPublicRecord(qr.org_id!, qr.entity_kind!, qr.entity_id!, t) : null;
    if (!view || !view.photoFileId || view.photoFileId !== req.params.id) {
      res.status(404).json({ error: { code: "not_found", message: "no such image" } });
      return;
    }
    const file = (await platform().files.read(qr!.org_id!, view.photoFileId, "medium")) ?? (await platform().files.read(qr!.org_id!, view.photoFileId, "original"));
    if (!file || !file.mimeType.startsWith("image/")) {
      res.status(404).json({ error: { code: "not_found", message: "no such image" } });
      return;
    }
    res.type(file.mimeType);
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(Buffer.from(file.bytes));
  })().catch(next);
});

// A page's memorable address, /p/<workspace>/<address>: the token of the link
// it opens through, or nothing. The same answer for a workspace that does
// not exist, a page without that address, and one whose address was turned
// off, so a guess learns nothing.
publicRouter.get("/named/:org/:address", (req, res, next) => {
  void (async () => {
    const none = (): void => {
      res.status(404).json({ error: { code: "not_found", message: "no such page" } });
    };
    const org = await meta.selectFrom("orgs").select("id").where("slug", "=", String(req.params.org ?? "")).executeTakeFirst();
    if (!org) return none();
    const db = (await platform().tenants.getDb(org.id)) as Kysely<{ core_public_surfaces_surfaces: SurfaceRow & { token: string }; core_public_surfaces_pages: PageRow & { address: string | null } }>;
    const page = await db.selectFrom("core_public_surfaces_pages").select(["id"]).where("address", "=", String(req.params.address ?? "")).executeTakeFirst().catch(() => undefined);
    if (!page) return none();
    const links = await db.selectFrom("core_public_surfaces_surfaces").selectAll().where("scope_type", "=", "page").where("scope_id", "=", page.id).where("revoked_at", "is", null).execute();
    const named = links.find((l) => (l.config as { named?: unknown } | null)?.named === true && l.enabled);
    if (!named) return none();
    res.json({ token: named.token });
  })().catch(next);
});

// One record of a public page, by the opaque ref the page gave it, and only
// while the page's scope still selects it.
publicRouter.get("/:token/records/:ref", (req, res, next) => {
  void (async () => {
    const token = String(req.params.token ?? "");
    const tok = await resolveToken(token);
    if (!tok.ok) {
      res.status(tok.status).json({ error: { code: tok.code, message: tok.message } });
      return;
    }
    const tenantDb = (await platform().tenants.getDb(tok.orgId)) as Kysely<{ core_public_surfaces_surfaces: SurfaceRow; core_public_surfaces_pages: PageRow }>;
    const surface = await tenantDb.selectFrom("core_public_surfaces_surfaces").selectAll().where("id", "=", tok.surfaceId).executeTakeFirst();
    if (!surface || surface.revoked_at !== null || !surface.enabled || surface.scope_type !== "page") {
      res.status(404).json({ error: { code: "not_found", message: "no such surface" } });
      return;
    }
    const found = await tenantDb.selectFrom("core_public_surfaces_pages").selectAll().where("id", "=", surface.scope_id).executeTakeFirst();
    if (found && !pageIsLive(found)) {
      res.status(410).json({ error: { code: "expired", message: "this surface has expired" } });
      return;
    }
    const page = found;
    const record = page ? await publicPageRecord(tok.orgId, surface.id, token, page.scope, pageLinkVisibility(page, surface), String(req.params.ref ?? ""), page.show_fields) : null;
    if (!record) {
      res.status(404).json({ error: { code: "not_found", message: "no such record" } });
      return;
    }
    const frame = await pageFrame(tok.orgId, page!);
    // ?skin=1: the page's custom look for this record instead of the record.
    if (req.query.skin === "1") {
      if (!page!.skin_html) {
        res.status(404).json({ error: { code: "not_found", message: "no custom look" } });
        return;
      }
      res.json({ url: skinDocument(page!.skin_html, { record, page: frame }) });
      return;
    }
    res.json({ page: frame, record });
  })().catch(next);
});

/** What a surface's link shows right now, built the one way: the data route
 *  answers with it, and the image route serves a photo only when it names it
 *  (#7127). Not ok: the status and body to refuse with. */
async function surfacePayload(token: string | undefined): Promise<
  | { ok: true; payload: Record<string, unknown>; orgId: string; surface: SurfaceRow; tenantDb: Kysely<{ core_public_surfaces_surfaces: SurfaceRow }> }
  | { ok: false; status: number; body: unknown }
> {
  // 1. Meta-side token lookup (shared with the public file route).
  const tok = await resolveToken(token);
  if (!tok.ok) {
    return { ok: false, status: tok.status, body: { error: { code: tok.code, message: tok.message } } };
  }

  // 2. Open the tenant DB + read the surface config.
  const tenantDb = (await platform().tenants.getDb(
    tok.orgId,
  )) as Kysely<{
    core_public_surfaces_surfaces: SurfaceRow;
    core_views_views: ViewRow;
    core_apps_apps: AppRow;
  }>;
  const surface = await tenantDb
    .selectFrom("core_public_surfaces_surfaces")
    .selectAll()
    .where("id", "=", tok.surfaceId)
    .executeTakeFirst();
  if (!surface || surface.revoked_at !== null || !surface.enabled) {
    return { ok: false, status: 404, body: { error: { code: "not_found", message: "no such surface" } } };
  }

  // 3. Resolve scope → data.
  const payload: Record<string, unknown> = {
    surface: {
      name: surface.name,
      scope_type: surface.scope_type,
      config: publicSurfaceConfig(surface.config),
    },
  };

  if (surface.scope_type === "entity") {
    // scope_id is "<kind>:<entityId>"
    const sep = surface.scope_id.indexOf(":");
    if (sep < 0) {
      return { ok: false, status: 500, body: { error: { code: "malformed_scope", message: "bad scope_id" } } };
    }
    const lastSep = surface.scope_id.lastIndexOf(":");
    const kind = surface.scope_id.slice(0, lastSep);
    const entityId = surface.scope_id.slice(lastSep + 1);
    const entity = await platform().entities.lookup(tok.orgId, kind, entityId, { publicRead: true });
    payload.entity = curateItem(entity ? (await publicFieldsOnly(tok.orgId, kind, [entity]))[0] : entity, token!);
  } else if (surface.scope_type === "view") {
    // scope_id is a core_views_views row id. Read the view, then
    // call platform.entities.list with its persisted config.
    const view = await tenantDb
      .selectFrom("core_views_views")
      .selectAll()
      .where("id", "=", surface.scope_id)
      .executeTakeFirst();
    if (!view) {
      return { ok: false, status: 404, body: { error: { code: "view_missing", message: "surface points at a deleted view" } } };
    }
    payload.view = {
      name: view.name,
      entity_kind: view.entity_kind,
      view_type: view.view_type,
    };
    payload.items = curateItems(await publicViewRows(tok.orgId, view, 50), token!);
    } else if (surface.scope_type === "collection") {
    // scope_id is the entity kind; surface.config.query holds the
    // EntityListQuery (filter / where / sort / limit). Lets a
    // builder share an ad-hoc filter without first carving a saved
    // view out of it.
    const kind = surface.scope_id;
    const cfg = (surface.config ?? {}) as Record<string, unknown>;
    const query = (cfg.query as Record<string, unknown> | undefined) ?? {};
    payload.collection = { kind };
    payload.items = curateItems(await publicList(tok.orgId, kind, {
      q: typeof query.q === "string" ? query.q : undefined,
      filter: (query.filter as Record<string, unknown> | undefined) ?? undefined,
      where: (query.where as never) ?? undefined,
      sort: (query.sort as string[] | undefined) ?? undefined,
      limit: Math.min(Number(query.limit) || 50, 200),
    }), token!);
  } else if (surface.scope_type === "board") {
    // Multi-column TV board: config.sections = [{ title, view_id }].
    // Each column resolves a saved view (same path as scope_type
    // 'view'), capped small so a wall display stays glanceable. This
    // is the recently-done / in-progress / coming-up display.
    const cfg = (surface.config ?? {}) as Record<string, unknown>;
    const sections = Array.isArray(cfg.sections) ? cfg.sections : [];
    const perColumn = Math.min(Number(cfg.per_column) || 8, 30);
    const resolved: Array<Record<string, unknown>> = [];
    for (const raw of sections) {
      const s = (raw ?? {}) as Record<string, unknown>;
      const viewId = typeof s.view_id === "string" ? s.view_id : null;
      if (!viewId) continue;
      const view = await tenantDb
        .selectFrom("core_views_views")
        .selectAll()
        .where("id", "=", viewId)
        .executeTakeFirst();
      if (!view) continue;
      resolved.push({
        title: typeof s.title === "string" && s.title ? s.title : view.name,
        entity_kind: view.entity_kind,
        view_type: view.view_type,
        items: curateItems(await publicViewRows(tok.orgId, view, perColumn), token!),
      });
    }
    payload.sections = resolved;
  } else if (surface.scope_type === "page") {
    // scope_id is a public page (core_public_surfaces_pages): its scope and
    // default visibility; this link's config.visibility overrides it.
    const page = await (tenantDb as unknown as Kysely<{ core_public_surfaces_pages: PageRow }>)
      .selectFrom("core_public_surfaces_pages")
      .selectAll()
      .where("id", "=", surface.scope_id)
      .executeTakeFirst();
    if (!page) {
      return { ok: false, status: 404, body: { error: { code: "not_found", message: "no such surface" } } };
    }
    // Booth mode: past its end, every link to it is ended too.
    if (!pageIsLive(page)) {
      return { ok: false, status: 410, body: { error: { code: "expired", message: "this surface has expired" } } };
    }
    payload.page = { ...(await pageFrame(tok.orgId, page)), layout: page.layout };
    payload.items = await publicPageRecords(tok.orgId, surface.id, token!, page.scope, pageLinkVisibility(page, surface), page.show_fields);
  } else if (surface.scope_type === "app") {
    // scope_id is a core_apps_apps slug. Render the whole composed app
    // read-only + no-login: keep markdown / stat / view / custom blocks,
    // DROP everything that writes or needs a member context (form /
    // action / scan / record). All data the blocks need is RESOLVED HERE
    // (curated, identity-less projection) and injected — the public page
    // never holds a token and never hits a live member endpoint.
    const appRow = await tenantDb
      .selectFrom("core_apps_apps")
      .selectAll()
      .where("slug", "=", surface.scope_id)
      .executeTakeFirst();
    if (!appRow) {
      return { ok: false, status: 404, body: { error: { code: "app_missing", message: "surface points at a deleted app" } } };
    }
    const pages = (Array.isArray(appRow.pages) ? appRow.pages : []) as AppPage[];

    // Build the allowlist of views this app references: structured
    // view_id on stat/view blocks + any view-id literal embedded in a
    // custom block's html (the SVG/widget reads it via cobblr.viewData).
    const allViews = await tenantDb
      .selectFrom("core_views_views")
      .selectAll()
      .execute();
    const viewById = new Map(allViews.map((v) => [v.id, v]));
    const wanted = new Set<string>();
    for (const page of pages) {
      for (const b of page.blocks ?? []) {
        if ((b.type === "stat" || b.type === "view") && b.view_id) wanted.add(b.view_id);
        if (b.type === "custom" && typeof b.html === "string") {
          for (const id of b.html.match(UUID_RE) ?? []) {
            if (viewById.has(id)) wanted.add(id);
          }
        }
      }
    }

    // Resolve each wanted view once (curated), build viewsById +
    // precomputed stats so the public player needs zero live calls.
    const viewsById: Record<string, unknown[]> = {};
    const statsById: Record<string, number> = {};
    for (const vid of wanted) {
      const view = viewById.get(vid);
      if (!view) continue;
      viewsById[vid] = curateItems(await publicViewRows(tok.orgId, view, 200), token!) as unknown[];
    }
    // Precompute every stat block's number (count / sum of a field).
    for (const page of pages) {
      for (const b of page.blocks ?? []) {
        if (b.type !== "stat" || !b.view_id) continue;
        const rows = (viewsById[b.view_id] ?? []) as Array<{ fields?: Record<string, unknown> }>;
        // The same number the member's own App Player shows (stat-value.ts).
        const spec = { agg: b.agg ?? "count", field: b.field, times: b.times } as const;
        statsById[statKey(b.view_id, spec)] = statValue(rows, spec);
      }
    }

    // Strip the page tree to only the public-safe blocks.
    const PUBLIC_BLOCKS = new Set(["markdown", "stat", "view", "custom"]);
    const publicPages = pages.map((p) => ({
      slug: p.slug,
      title: p.title,
      blocks: (p.blocks ?? []).filter((b) => PUBLIC_BLOCKS.has(b.type)),
    }));

    payload.app = { name: appRow.name, theme: appRow.theme ?? null, pages: publicPages };
    payload.data = { viewsById, statsById };
  } else {
    return { ok: false, status: 500, body: { error: { code: "unknown_scope", message: `unsupported scope_type ${surface.scope_type}` } } };
  }

  return { ok: true, payload, orgId: tok.orgId, surface, tenantDb: tenantDb as unknown as Kysely<{ core_public_surfaces_surfaces: SurfaceRow }> };
}

publicRouter.get("/:token", (req, res, next) => {
  void (async () => {
    const token = req.params.token;

    const built = await surfacePayload(token);
    if (!built.ok) {
      res.status(built.status).json(built.body);
      return;
    }
    const { payload, surface, tenantDb } = built;
    const tok = { orgId: built.orgId };

    // Only an explicit page opening is a visit. Public screens also refresh
    // this data on timers and focus changes without another visitor arriving.
    if (req.get(/* PRODUCT-NAME: A wire protocol header shared by existing clients and servers. */ "X-Cobblr-Visit") === "1") {
      void platform().events.emit("core-public-surfaces.surface.viewed", {
        orgId: tok.orgId,
        surfaceId: surface.id,
        scope_type: surface.scope_type,
      });
      const ua = req.headers["user-agent"];
      const referer = req.headers.referer ?? req.headers.referrer;
      // DETACHED: a page-view count; the page is served without it
      void tenantDb
        .insertInto("core_public_surfaces_views" as never)
        .values({
          surface_id: surface.id,
          ua_hint: typeof ua === "string" ? ua.slice(0, 200) : null,
          referer: typeof referer === "string" ? referer.slice(0, 200) : null,
        } as never)
        .execute()
        .catch((err) => {
          console.error("[public] view-log insert failed:", (err as Error).message);
        });
    }

    res.json(payload);
  })().catch(next);
});

// No-auth, token-gated image serve. The public render payload rewrites
// every image_path to this route so a logged-out page (no Bearer token)
// can still show photos. It serves a photo only while the link shows it:
// the surface's payload, built now, must name this file. A valid token used
// to serve any image of the workspace by its id, so a photo stayed public
// after its record left the page, was replaced, or the page ended (#7127).
// Images only (no docs/gcode leak). Bytes come through the platform files
// seam (org-scoped); we never touch disk or the core-files router here.
publicRouter.get("/:token/files/:id/raw", (req, res, next) => {
  void (async () => {
    const id = req.params.id;
    const built = await shownNow(req.params.token);
    if (!built.ok) {
      res.status(built.status).json(built.body);
      return;
    }
    if (!id || !showsFile(built.payload, req.params.token, id)) {
      res.status(404).json({ error: { code: "not_found", message: "no such image" } });
      return;
    }
    const file =
      (await platform().files.read(built.orgId, id, "medium")) ??
      (await platform().files.read(built.orgId, id, "original"));
    // Images only on the public path — never serve documents / gcode / etc.
    if (!file || !file.mimeType.startsWith("image/")) {
      res.status(404).json({ error: { code: "not_found", message: "no such image" } });
      return;
    }
    res.type(file.mimeType);
    // As the label's photo: a photo taken off the page stops being served
    // from a cache within minutes, not an hour.
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(Buffer.from(file.bytes));
  })().catch(next);
});

/** The payload a page's photos are checked against, built at most once per
 *  link every few seconds: a page of fifty photos asks fifty times in one
 *  load, and a photo taken off the page stops within those seconds. */
const shown = ttlCache<Awaited<ReturnType<typeof surfacePayload>>>(10_000);
const shownNow = (token: string | undefined) => shown.get(token ?? "", () => surfacePayload(token));

/** Does this payload show the file, as this link's own image address? */
export function showsFile(payload: unknown, token: string, fileId: string): boolean {
  return JSON.stringify(payload).includes(`/api/v1/public/${token}/files/${fileId}/raw`);
}

// No-auth, signed-token image serve for scan-inbox EXPORT (cross-instance
// import). A scan export mints a short-lived org-scoped token and bakes this URL
// into each item's photo_urls; the importing instance's best-effort photo fetch
// GETs it with no credentials — exactly like an external producer's unauthenticated
// image endpoint the interop contract assumes. Same guardrails as the surface
// file route: images only (no docs/gcode), org-scoped via the token, bytes
// through the platform files seam. The token expires (default 14d) and grants
// read only.
publicRouter.get("/scan-export/:token/files/:id/raw", (req, res, next) => {
  void (async () => {
    const verdict = verifyScanExportToken(req.params.token ?? "");
    if (!verdict) {
      res.status(403).json({ error: { code: "bad_token", message: "invalid or expired export token" } });
      return;
    }
    const { orgId, fileId } = verdict;
    const id = req.params.id;
    if (!id) {
      res.status(404).json({ error: { code: "not_found", message: "no such file" } });
      return;
    }
    // Per-file token: it only unlocks the ONE file it was minted for. (A legacy
    // token has fileId=null and stays org-wide for backward compatibility.)
    if (fileId && fileId !== id) {
      res.status(403).json({ error: { code: "scope", message: "token not valid for this file" } });
      return;
    }
    const file =
      (await platform().files.read(orgId, id, "medium")) ??
      (await platform().files.read(orgId, id, "original"));
    if (!file || !file.mimeType.startsWith("image/")) {
      res.status(404).json({ error: { code: "not_found", message: "no such image" } });
      return;
    }
    res.type(file.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(file.bytes));
  })().catch(next);
});

// ── stop an automation's messages (#6070) ──────────────────────────────────
// The link at the foot of every message an automation emails someone outside
// a workspace. Opening it asks; only the press stops, so a mail scanner that
// follows links does not stop anything by itself. The token is signed and
// names one workspace, one automation and one person; nothing else of the
// workspace is shown.

publicRouter.get("/external-stop/:token", async (req, res, next) => {
  try {
    const claim = readStopToken(req.params.token ?? "");
    if (!claim) return void res.status(404).json({ error: { code: "not_found", message: `This link is not one ${productName()} made, or it was changed.` } });
    const org = await meta.selectFrom("orgs").select("name").where("id", "=", claim.o).executeTakeFirst();
    const stopped = await meta
      .selectFrom("external_message_stops")
      .select("person_id")
      .where("org_id", "=", claim.o)
      .where("binding_id", "=", claim.w)
      .where("person_id", "=", claim.p)
      .executeTakeFirst();
    res.json({ workspace: org?.name ?? "A workspace", stopped: !!stopped });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt: the recipient's own stop, from a link in an email, with
// no account; there is nobody for the assistant to act for.
publicRouter.post("/external-stop/:token", async (req, res, next) => {
  try {
    const claim = readStopToken(req.params.token ?? "");
    if (!claim) return void res.status(404).json({ error: { code: "not_found", message: `This link is not one ${productName()} made, or it was changed.` } });
    await stopMessages(claim);
    res.json({ stopped: true });
  } catch (err) {
    next(err);
  }
});

// ── answer an automation's message (#6070, slice 3b) ────────────────────────
// The reply link a wire may add: the item and two answers, nothing else of
// the workspace. Signed, for one message, for 14 days.

publicRouter.get("/external-reply/:token", async (req, res, next) => {
  try {
    const r = await readReply(req.params.token ?? "");
    if (!r.ok) {
      const status = r.why === "expired" ? 410 : 404;
      return void res.status(status).json({ error: { code: r.why, message: r.why === "expired" ? "This link has expired." : `This link is not one ${productName()} made, or it was changed.` } });
    }
    res.json({ workspace: r.workspace, item: r.item, answered: r.answered });
  } catch (err) {
    next(err);
  }
});

const ReplyBody = z.object({ answer: z.enum(["got", "bought"]) });
// AI-REACH: exempt: the answer of someone outside the workspace, from a link in
// an email, with no account; there is nobody for the assistant to act for.
publicRouter.post("/external-reply/:token", async (req, res, next) => {
  try {
    const body = ReplyBody.safeParse(req.body ?? {});
    if (!body.success) return void res.status(400).json({ error: { code: "invalid_body", message: "Answer got or bought." } });
    const r = await answerReply(req.params.token ?? "", body.data.answer);
    if (!r.ok) {
      const status = r.why === "expired" ? 410 : 404;
      return void res.status(status).json({ error: { code: r.why, message: r.why === "expired" ? "This link has expired." : `This link is not one ${productName()} made, or it was changed.` } });
    }
    res.json({ answered: r.answered, listed: r.listed });
  } catch (err) {
    next(err);
  }
});
