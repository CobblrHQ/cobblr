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
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";

export const publicRouter = Router();

interface SurfaceRow {
  id: string;
  name: string;
  scope_type: "view" | "entity" | "collection";
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

publicRouter.get("/:token", (req, res, next) => {
  void (async () => {
    const token = req.params.token;
    if (!token || token.length < 16) {
      res.status(404).json({ error: { code: "not_found", message: "no such surface" } });
      return;
    }

    // 1. Meta-side token lookup. Cheap indexed query.
    const tokenRow = await meta
      .selectFrom("public_surface_tokens")
      .selectAll()
      .where("token", "=", token)
      .executeTakeFirst();
    if (!tokenRow || tokenRow.revoked_at !== null || !tokenRow.enabled) {
      res.status(404).json({ error: { code: "not_found", message: "no such surface" } });
      return;
    }
    if (tokenRow.expires_at && tokenRow.expires_at < new Date()) {
      res.status(410).json({ error: { code: "expired", message: "this surface has expired" } });
      return;
    }

    // 2. Open the tenant DB + read the surface config.
    const tenantDb = (await platform().tenants.getDb(
      tokenRow.org_id,
    )) as Kysely<{ core_public_surfaces_surfaces: SurfaceRow; core_views_views: ViewRow }>;
    const surface = await tenantDb
      .selectFrom("core_public_surfaces_surfaces")
      .selectAll()
      .where("id", "=", tokenRow.surface_id)
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
      const entity = await platform().entities.lookup(tokenRow.org_id, kind, entityId);
      payload.entity = entity;
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
      const result = await platform().entities.list(tokenRow.org_id, view.entity_kind, {
        filter: (cfg.filter as Record<string, unknown> | undefined) ?? undefined,
        sort: (cfg.sort as string[] | undefined) ?? undefined,
        limit: 50,
      });
      payload.view = {
        name: view.name,
        entity_kind: view.entity_kind,
        view_type: view.view_type,
      };
      payload.items = result.items;
    } else if (surface.scope_type === "collection") {
      // scope_id is the entity kind; surface.config.query holds the
      // EntityListQuery (filter / where / sort / limit). Lets a
      // builder share an ad-hoc filter without first carving a saved
      // view out of it.
      const kind = surface.scope_id;
      const cfg = (surface.config ?? {}) as Record<string, unknown>;
      const query = (cfg.query as Record<string, unknown> | undefined) ?? {};
      const result = await platform().entities.list(tokenRow.org_id, kind, {
        q: typeof query.q === "string" ? query.q : undefined,
        filter: (query.filter as Record<string, unknown> | undefined) ?? undefined,
        where: (query.where as never) ?? undefined,
        sort: (query.sort as string[] | undefined) ?? undefined,
        limit: Math.min(Number(query.limit) || 50, 200),
      });
      payload.collection = {
        kind,
        query,
      };
      payload.items = result.items;
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
      orgId: tokenRow.org_id,
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
