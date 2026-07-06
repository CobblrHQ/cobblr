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

import { Router } from "express";
import type { Kysely } from "kysely";
import { createHmac, timingSafeEqual } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { env } from "../env.js";

export const publicRouter = Router();

// Verify a scan-export photo token → orgId (or null). Byte-compatible mirror of
// modules/core-scan/src/services/export-token.ts `verifyExportToken` — keep the
// two in lockstep (same payload shape, same HMAC over JWT_SECRET). Grants
// org-wide IMAGE read (the serving route below is images-only) until it expires.
function verifyScanExportToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const expected = createHmac("sha256", env.JWT_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { o, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { o?: unknown; e?: unknown };
    if (typeof o !== "string" || typeof e !== "number" || Date.now() > e) return null;
    return o;
  } catch {
    return null;
  }
}

interface SurfaceRow {
  id: string;
  name: string;
  scope_type: "view" | "entity" | "collection" | "board" | "app";
  scope_id: string;
  config: Record<string, unknown>;
  enabled: boolean;
  expires_at: Date | null;
  revoked_at: Date | null;
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
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

publicRouter.get("/:token", (req, res, next) => {
  void (async () => {
    const token = req.params.token;

    // 1. Meta-side token lookup (shared with the public file route).
    const tok = await resolveToken(token);
    if (!tok.ok) {
      res.status(tok.status).json({ error: { code: tok.code, message: tok.message } });
      return;
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
      res.status(404).json({ error: { code: "not_found", message: "no such surface" } });
      return;
    }

    // 3. Resolve scope → data.
    const payload: Record<string, unknown> = {
      surface: {
        name: surface.name,
        scope_type: surface.scope_type,
        config: surface.config,
      },
    };

    if (surface.scope_type === "entity") {
      // scope_id is "<kind>:<entityId>"
      const sep = surface.scope_id.indexOf(":");
      if (sep < 0) {
        res.status(500).json({ error: { code: "malformed_scope", message: "bad scope_id" } });
        return;
      }
      const lastSep = surface.scope_id.lastIndexOf(":");
      const kind = surface.scope_id.slice(0, lastSep);
      const entityId = surface.scope_id.slice(lastSep + 1);
      const entity = await platform().entities.lookup(tok.orgId, kind, entityId, { publicRead: true });
      payload.entity = curateItem(entity, token!);
    } else if (surface.scope_type === "view") {
      // scope_id is a core_views_views row id. Read the view, then
      // call platform.entities.list with its persisted config.
      const view = await tenantDb
        .selectFrom("core_views_views")
        .selectAll()
        .where("id", "=", surface.scope_id)
        .executeTakeFirst();
      if (!view) {
        res.status(404).json({ error: { code: "view_missing", message: "surface points at a deleted view" } });
        return;
      }
      const cfg = (view.config as Record<string, unknown>) ?? {};
      const result = await platform().entities.list(tok.orgId,view.entity_kind, {
        filter: (cfg.filter as Record<string, unknown> | undefined) ?? undefined,
        sort: (cfg.sort as string[] | undefined) ?? undefined,
        limit: 50,
      }, { publicRead: true });
      payload.view = {
        name: view.name,
        entity_kind: view.entity_kind,
        view_type: view.view_type,
      };
      payload.items = curateItems(result.items, token!);
    } else if (surface.scope_type === "collection") {
      // scope_id is the entity kind; surface.config.query holds the
      // EntityListQuery (filter / where / sort / limit). Lets a
      // builder share an ad-hoc filter without first carving a saved
      // view out of it.
      const kind = surface.scope_id;
      const cfg = (surface.config ?? {}) as Record<string, unknown>;
      const query = (cfg.query as Record<string, unknown> | undefined) ?? {};
      const result = await platform().entities.list(tok.orgId,kind, {
        q: typeof query.q === "string" ? query.q : undefined,
        filter: (query.filter as Record<string, unknown> | undefined) ?? undefined,
        where: (query.where as never) ?? undefined,
        sort: (query.sort as string[] | undefined) ?? undefined,
        limit: Math.min(Number(query.limit) || 50, 200),
      }, { publicRead: true });
      payload.collection = {
        kind,
        query,
      };
      payload.items = curateItems(result.items, token!);
    } else if (surface.scope_type === "board") {
      // Multi-column TV board: config.sections = [{ title, view_id }].
      // Each column resolves a saved view (same path as scope_type
      // 'view'), capped small so a wall display stays glanceable. This
      // is companion app's recently-done / in-progress / coming-up display.
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
        const vcfg = (view.config as Record<string, unknown>) ?? {};
        const result = await platform().entities.list(tok.orgId,view.entity_kind, {
          filter: (vcfg.filter as Record<string, unknown> | undefined) ?? undefined,
          sort: (vcfg.sort as string[] | undefined) ?? undefined,
          limit: perColumn,
        }, { publicRead: true });
        resolved.push({
          title: typeof s.title === "string" && s.title ? s.title : view.name,
          entity_kind: view.entity_kind,
          view_type: view.view_type,
          items: curateItems(result.items, token!),
        });
      }
      payload.sections = resolved;
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
        res.status(404).json({ error: { code: "app_missing", message: "surface points at a deleted app" } });
        return;
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
        const vcfg = (view.config as Record<string, unknown>) ?? {};
        const result = await platform().entities.list(tok.orgId, view.entity_kind, {
          filter: (vcfg.filter as Record<string, unknown> | undefined) ?? undefined,
          sort: (vcfg.sort as string[] | undefined) ?? undefined,
          limit: 200,
        }, { publicRead: true });
        viewsById[vid] = curateItems(result.items, token!) as unknown[];
      }
      // Precompute every stat block's number (count / sum of a field).
      for (const page of pages) {
        for (const b of page.blocks ?? []) {
          if (b.type !== "stat" || !b.view_id) continue;
          const rows = (viewsById[b.view_id] ?? []) as Array<{ fields?: Record<string, unknown> }>;
          if (b.agg === "sum" && b.field) {
            statsById[b.view_id + ":" + b.field] = rows.reduce((acc, r) => {
              const fields = r.fields ?? {};
              const meta = (fields.metadata as Record<string, unknown> | undefined) ?? {};
              const raw = fields[b.field!] ?? meta[b.field!];
              const n = Number(raw);
              return acc + (Number.isFinite(n) ? n : 0);
            }, 0);
          } else {
            statsById[b.view_id] = rows.length;
          }
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
      res.status(500).json({ error: { code: "unknown_scope", message: `unsupported scope_type ${surface.scope_type}` } });
      return;
    }

    // 4. Best-effort "viewed" event + analytics row. Both detached
    // from the response — a failure on either path doesn't make the
    // public page slow or 500. The events.emit is the platform-wide
    // signal (wires can subscribe); the views-log row is the
    // module's own rollup source.
    void platform().events.emit("core-public-surfaces.surface.viewed", {
      orgId: tok.orgId,
      surfaceId: surface.id,
      scope_type: surface.scope_type,
    });
    const ua = req.headers["user-agent"];
    const referer = req.headers.referer ?? req.headers.referrer;
    void tenantDb
      .insertInto("core_public_surfaces_views" as never)
      .values({
        surface_id: surface.id,
        ua_hint: typeof ua === "string" ? ua.slice(0, 200) : null,
        referer: typeof referer === "string" ? referer.slice(0, 200) : null,
      } as never)
      .execute()
      .catch((err) => {
        console.error(
          "[public] view-log insert failed:",
          (err as Error).message,
        );
      });

    res.json(payload);
  })().catch(next);
});

// No-auth, token-gated image serve. The public render payload rewrites
// every image_path to this route so a logged-out page (no Bearer token)
// can still show photos. Bounded by: a valid surface token (org gate) +
// images only (no docs/gcode leak) + unguessable file uuid. Bytes come
// through the platform files seam (org-scoped) — we never touch disk or
// the core-files router here.
publicRouter.get("/:token/files/:id/raw", (req, res, next) => {
  void (async () => {
    const tok = await resolveToken(req.params.token);
    if (!tok.ok) {
      res.status(tok.status).json({ error: { code: tok.code, message: tok.message } });
      return;
    }
    const id = req.params.id;
    if (!id) {
      res.status(404).json({ error: { code: "not_found", message: "no such file" } });
      return;
    }
    const file =
      (await platform().files.read(tok.orgId, id, "medium")) ??
      (await platform().files.read(tok.orgId, id, "original"));
    // Images only on the public path — never serve documents / gcode / etc.
    if (!file || !file.mimeType.startsWith("image/")) {
      res.status(404).json({ error: { code: "not_found", message: "no such image" } });
      return;
    }
    res.type(file.mimeType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(file.bytes));
  })().catch(next);
});

// No-auth, signed-token image serve for scan-inbox EXPORT (cross-instance
// import). A scan export mints a short-lived org-scoped token and bakes this URL
// into each item's photo_urls; the importing instance's best-effort photo fetch
// GETs it with no credentials — exactly like the companion app producer's unauthenticated
// image endpoint the interop contract assumes. Same guardrails as the surface
// file route: images only (no docs/gcode), org-scoped via the token, bytes
// through the platform files seam. The token expires (default 14d) and grants
// read only.
publicRouter.get("/scan-export/:token/files/:id/raw", (req, res, next) => {
  void (async () => {
    const orgId = verifyScanExportToken(req.params.token ?? "");
    if (!orgId) {
      res.status(403).json({ error: { code: "bad_token", message: "invalid or expired export token" } });
      return;
    }
    const id = req.params.id;
    if (!id) {
      res.status(404).json({ error: { code: "not_found", message: "no such file" } });
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
