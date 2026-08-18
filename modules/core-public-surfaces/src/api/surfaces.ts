// /surfaces — authenticated CRUD for the surface configs. The
// public read path is the platform's /api/v1/public/:token, not
// this router (modules can't easily mount un-authenticated routes
// outside their /modules/<name>/ scope today — see
// api/src/routes/public.ts).

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, mintToken, requireRole } from "./util.js";

export const surfacesRouter = Router({ mergeParams: true });

const SurfaceCreate = z.object({
  name: z.string().min(1).max(160),
  // 'view'       — scope_id is a uuid of a core_views_views row
  // 'entity'     — scope_id is "<kind>:<entityId>"
  // 'collection' — scope_id is an entity_kind (e.g. "inventory:part");
  //                config.query is the EntityListQuery to apply.
  //                Lets a builder share an ad-hoc filter without first
  //                creating a saved view.
  // 'board'      — scope_id is a placeholder ("board"); config.sections
  //                is [{ title, view_id }] — a multi-column TV board
  //                (e.g. recently-done / in-progress / coming-up),
  //                each column resolved from a saved view.
  // 'app'        — scope_id is a core-apps app SLUG. Renders the whole
  //                composed app read-only + no-login (markdown / stat /
  //                view / custom blocks; write/member blocks dropped).
  scope_type: z.enum(["view", "entity", "collection", "board", "app"]),
  scope_id: z.string().min(1),
  config: z.record(z.unknown()).optional(),
  expires_at: z.string().datetime().nullable().optional(),
});

interface MetaDbLike {
  insertInto(t: string): {
    values(v: Record<string, unknown>): { execute(): Promise<unknown> };
  };
  updateTable(t: string): {
    set(v: Record<string, unknown>): {
      where(c: string, op: string, v: unknown): {
        execute(): Promise<unknown>;
      };
    };
  };
  deleteFrom(t: string): {
    where(c: string, op: string, v: unknown): { execute(): Promise<unknown> };
  };
}

function metaDb(): MetaDbLike {
  return platform().db.meta as MetaDbLike;
}

// AI-REACH: authoring of a user-built surface; a whole-workspace build goes through the design flow, and records inside an app are reachable as records
surfacesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = SurfaceCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const token = mintToken();
    const expiresAt = parsed.data.expires_at ? new Date(parsed.data.expires_at) : null;

    // Two-step insert. Tenant-side first (so a failure there doesn't
    // leave an orphan in the meta lookup); meta-side after.
    const row = await db
      .insertInto("core_public_surfaces_surfaces")
      .values({
        name: parsed.data.name,
        token,
        scope_type: parsed.data.scope_type,
        scope_id: parsed.data.scope_id,
        config: parsed.data.config ?? {},
        expires_at: expiresAt,
        created_by: session?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await metaDb()
      .insertInto("public_surface_tokens")
      .values({
        token,
        org_id: ctx.org.id,
        surface_id: row.id,
        enabled: true,
        expires_at: expiresAt,
      })
      .execute();

    await platform().events.emit("core-public-surfaces.surface.created", {
      orgId: ctx.org.id,
      surfaceId: row.id,
      name: row.name,
      scope_type: row.scope_type,
    });

    res.status(201).json({ ...row, public_url: `/api/v1/public/${token}` });
  }),
);

surfacesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db
      .selectFrom("core_public_surfaces_surfaces")
      .selectAll()
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .execute();
    res.json({
      items: items.map((r) => ({
        ...r,
        public_url: `/api/v1/public/${r.token}`,
      })),
    });
  }),
);

// M2 v0.2: per-surface analytics rollup. Returns:
//   - views_total              all-time
//   - views_24h / 7d / 30d     count in trailing window
//   - first_viewed / last_viewed   bookends for "is anyone using this"
//   - recent                   newest 50 hits, viewed_at + referer host
//
// The web shell renders this beside each surface row in
// /configuration/surfaces.
surfacesRouter.get(
  "/:id/stats",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    // Confirm the surface exists in this tenant before reporting
    // stats — avoids leaking that an id is valid in some other org.
    const surface = await db
      .selectFrom("core_public_surfaces_surfaces")
      .select(["id"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!surface) {
      res.status(404).json({ error: { code: "not_found", message: "surface not found" } });
      return;
    }
    const totals = await db
      .selectFrom("core_public_surfaces_views")
      .select([
        db.fn.count<number>("id").as("views_total"),
        sql<Date | null>`min(viewed_at)`.as("first_viewed"),
        sql<Date | null>`max(viewed_at)`.as("last_viewed"),
        sql<number>`count(*) filter (where viewed_at > now() - interval '24 hours')`.as(
          "views_24h",
        ),
        sql<number>`count(*) filter (where viewed_at > now() - interval '7 days')`.as(
          "views_7d",
        ),
        sql<number>`count(*) filter (where viewed_at > now() - interval '30 days')`.as(
          "views_30d",
        ),
      ])
      .where("surface_id", "=", id)
      .executeTakeFirstOrThrow();
    const recent = await db
      .selectFrom("core_public_surfaces_views")
      .select(["viewed_at", "referer", "ua_hint"])
      .where("surface_id", "=", id)
      .orderBy("viewed_at", "desc")
      .limit(50)
      .execute();

    // Lazy retention sweep: prune view-log rows older than 90 days.
    // Piggybacks on stats reads since they're the rare-but-explicit
    // moment we touch this table for analytics. No scheduler needed;
    // a tenant that never opens stats just keeps slightly more
    // history, which is fine. Best-effort — a failing DELETE here
    // shouldn't 500 the stats response.
    void db
      .deleteFrom("core_public_surfaces_views")
      .where(sql<boolean>`viewed_at < now() - interval '90 days'`)
      .execute()
      .catch((err) =>
        console.error(
          "[core-public-surfaces] retention sweep failed:",
          (err as Error).message,
        ),
      );

    res.json({
      views_total: Number(totals.views_total),
      views_24h: Number(totals.views_24h),
      views_7d: Number(totals.views_7d),
      views_30d: Number(totals.views_30d),
      first_viewed: totals.first_viewed,
      last_viewed: totals.last_viewed,
      recent,
    });
  }),
);

const SurfaceUpdate = z.object({
  name: z.string().min(1).max(160).optional(),
  config: z.record(z.unknown()).optional(),
  // Pause/resume without revoking the token — the URL stays valid but
  // /public/:token 404s while disabled, then resumes when re-enabled.
  enabled: z.boolean().optional(),
  // null clears the expiry (never expires); a datetime sets it.
  expires_at: z.string().datetime().nullable().optional(),
});

// Edit a live surface in place — rename, pause/resume, change the
// expiry, or tweak config — without delete-and-recreate (which would
// mint a new token and break any printed/shared URL).
// AI-REACH: authoring of a user-built surface; a whole-workspace build goes through the design flow, and records inside an app are reachable as records
surfacesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = SurfaceUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    const expiresProvided = parsed.data.expires_at !== undefined;
    const expiresAt = expiresProvided
      ? parsed.data.expires_at
        ? new Date(parsed.data.expires_at)
        : null
      : undefined;

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.config !== undefined) {
      patch.config = sql`${JSON.stringify(parsed.data.config)}::jsonb` as never;
    }
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
    if (expiresProvided) patch.expires_at = expiresAt;

    const row = await db
      .updateTable("core_public_surfaces_surfaces")
      .set(patch as never)
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "surface not found" } });
      return;
    }

    // Mirror enabled / expires_at to the meta-side token row — the
    // public /api/v1/public/:token route checks the meta copy, so a
    // pause or expiry change has to land there to take effect at once.
    if (parsed.data.enabled !== undefined || expiresProvided) {
      const metaSet: Record<string, unknown> = {};
      if (parsed.data.enabled !== undefined) metaSet.enabled = parsed.data.enabled;
      if (expiresProvided) metaSet.expires_at = expiresAt;
      await metaDb()
        .updateTable("public_surface_tokens")
        .set(metaSet)
        .where("token", "=", row.token)
        .execute();
    }

    await platform().events.emit("core-public-surfaces.surface.updated", {
      orgId: ctx.org.id,
      surfaceId: row.id,
      name: row.name,
    });
    res.json({ ...row, public_url: `/api/v1/public/${row.token}` });
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
surfacesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .updateTable("core_public_surfaces_surfaces")
      .set({ revoked_at: new Date(), updated_at: new Date() })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .returning(["id", "token", "name"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "surface not found" } });
      return;
    }
    // Remove the meta-side lookup so /public/:token starts 404'ing
    // immediately. Belt + suspenders since the platform route also
    // checks the tenant-side revoked_at.
    await metaDb()
      .deleteFrom("public_surface_tokens")
      .where("token", "=", row.token)
      .execute();
    await platform().events.emit("core-public-surfaces.surface.revoked", {
      orgId: ctx.org.id,
      surfaceId: row.id,
      name: row.name,
    });
    res.status(204).end();
  }),
);
