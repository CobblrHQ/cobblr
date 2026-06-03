// Super-admin surface — cross-workspace dashboards for the person
// hosting Cobblr. Gated by SUPERADMIN_EMAILS env var (see
// auth/middleware.ts → isPlatformAdmin). Workspace owners/admins
// CANNOT reach these routes; this is a separate tier above them.
//
// Use case: the author hosts cobblr on the workshop server. a beta tester's
// LEGO club + the author's own workshop + others are tenants. the author needs to
// see which workspaces exist, who's enabled what, disk usage, recent
// errors. SSH-ing into postgres is the alternative.
//
// See docs/operations/PRODUCTION_DEPLOY.md §1 launch checklist.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { requireAuth, requirePlatformAdmin } from "../auth/middleware.js";
import { meta } from "../db/meta.js";
import { getCpuStats, getInvocationStats } from "../sandbox/pool.js";

export const superAdminRouter = Router();

// Every route below requires platform admin. The composition
// `requireAuth → requirePlatformAdmin` lands here.
superAdminRouter.use(requireAuth, requirePlatformAdmin);

// GET /super-admin/overview — the dashboard landing. Counts +
// at-a-glance numbers. Cheap; safe to poll.
superAdminRouter.get("/overview", async (_req, res, next) => {
  try {
    const [orgsCount, usersCount, activeUsers, activityToday, totalGrants, totalBundles] =
      await Promise.all([
        meta
          .selectFrom("orgs")
          .select(meta.fn.count<number>("id").as("c"))
          .executeTakeFirst(),
        meta
          .selectFrom("users")
          .select(meta.fn.count<number>("id").as("c"))
          .executeTakeFirst(),
        meta
          .selectFrom("users")
          .select(meta.fn.count<number>("id").as("c"))
          .where("active", "=", true)
          .where("last_login_at", ">", sql<Date>`now() - interval '7 days'` as never)
          .executeTakeFirst(),
        meta
          .selectFrom("activity_log")
          .select(meta.fn.count<number>("id").as("c"))
          .where("occurred_at", ">", sql<Date>`now() - interval '24 hours'` as never)
          .executeTakeFirst(),
        meta
          .selectFrom("workspace_capability_grants")
          .select(meta.fn.count<number>("id").as("c"))
          .executeTakeFirst(),
        meta
          .selectFrom("bundles")
          .select(meta.fn.count<number>("id").as("c"))
          .executeTakeFirst(),
      ]);
    res.json({
      orgs_count: Number(orgsCount?.c ?? 0),
      users_count: Number(usersCount?.c ?? 0),
      active_users_7d: Number(activeUsers?.c ?? 0),
      activity_24h: Number(activityToday?.c ?? 0),
      capability_grants: Number(totalGrants?.c ?? 0),
      bundles_installed: Number(totalBundles?.c ?? 0),
    });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/workspaces — list every workspace with owner +
// member count + last activity. Heavy-ish join; cache 30s client-side
// in the UI.
superAdminRouter.get("/workspaces", async (_req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("orgs as o")
      .leftJoin("org_memberships as m", "m.org_id", "o.id")
      .leftJoin("activity_log as a", "a.org_id", "o.id")
      .select((eb) => [
        "o.id",
        "o.name",
        "o.slug",
        "o.plan",
        "o.created_at",
        eb.fn.count<number>("m.user_id").distinct().as("member_count"),
        sql<Date | null>`max(a.occurred_at)`.as("last_activity_at"),
      ])
      .groupBy(["o.id", "o.name", "o.slug", "o.plan", "o.created_at"])
      .orderBy("o.created_at", "desc")
      .execute();
    // Owner email for each workspace (one extra query, indexed).
    const ownersByOrg = new Map<string, { id: string; email: string; display_name: string }>();
    if (rows.length > 0) {
      const ownerRows = await meta
        .selectFrom("org_memberships as m")
        .innerJoin("users as u", "u.id", "m.user_id")
        .select(["m.org_id", "u.id", "u.email", "u.display_name"])
        .where(
          "m.org_id",
          "in",
          rows.map((r) => r.id),
        )
        .where("m.role", "=", "owner")
        .execute();
      for (const o of ownerRows) {
        if (!ownersByOrg.has(o.org_id)) {
          ownersByOrg.set(o.org_id, {
            id: o.id,
            email: o.email,
            display_name: o.display_name,
          });
        }
      }
    }
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        plan: r.plan,
        created_at: r.created_at,
        member_count: Number(r.member_count ?? 0),
        last_activity_at: r.last_activity_at,
        owner: ownersByOrg.get(r.id) ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/users — every user across every workspace, with
// their workspace memberships + roles. Useful for "who is this
// person locked-out of which workspace" support tickets.
superAdminRouter.get("/users", async (_req, res, next) => {
  try {
    const users = await meta
      .selectFrom("users")
      .select([
        "id",
        "email",
        "display_name",
        "active",
        "must_reset_password",
        "created_at",
        "last_login_at",
      ])
      .orderBy("created_at", "desc")
      .limit(500)
      .execute();
    const memberships = users.length > 0
      ? await meta
          .selectFrom("org_memberships as m")
          .innerJoin("orgs as o", "o.id", "m.org_id")
          .select(["m.user_id", "o.id as org_id", "o.name as org_name", "o.slug as org_slug", "m.role"])
          .where(
            "m.user_id",
            "in",
            users.map((u) => u.id),
          )
          .execute()
      : [];
    const orgsByUser = new Map<string, Array<{ org_id: string; org_name: string; org_slug: string; role: string }>>();
    for (const m of memberships) {
      const list = orgsByUser.get(m.user_id) ?? [];
      list.push({ org_id: m.org_id, org_name: m.org_name, org_slug: m.org_slug, role: m.role });
      orgsByUser.set(m.user_id, list);
    }
    res.json({
      items: users.map((u) => ({
        id: u.id,
        email: u.email,
        display_name: u.display_name,
        active: u.active,
        must_reset_password: u.must_reset_password,
        created_at: u.created_at,
        last_login_at: u.last_login_at,
        orgs: orgsByUser.get(u.id) ?? [],
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/installed-modules — what code is in the running
// image. Distinct from `org_modules` (per-workspace enable). See
// marketplace.md §4.
superAdminRouter.get("/installed-modules", async (_req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("installed_modules")
      .selectAll()
      .orderBy("band")
      .orderBy("name")
      .execute();
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/modules — matrix of which workspaces have which
// modules enabled. Useful for "is anyone actually using bricklink?"
// + for migration coordination ("module X is changing, who's
// affected?").
superAdminRouter.get("/modules", async (_req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("org_modules as om")
      .innerJoin("orgs as o", "o.id", "om.org_id")
      .select(["o.id as org_id", "o.name as org_name", "o.slug as org_slug", "om.module_name", "om.version", "om.last_migration"])
      .orderBy("om.module_name")
      .orderBy("o.name")
      .execute();
    // Group by module → list of (org, version).
    const byModule = new Map<
      string,
      Array<{ org_id: string; org_name: string; org_slug: string; version: string; last_migration: string | null }>
    >();
    for (const r of rows) {
      const list = byModule.get(r.module_name) ?? [];
      list.push({
        org_id: r.org_id,
        org_name: r.org_name,
        org_slug: r.org_slug,
        version: r.version,
        last_migration: r.last_migration,
      });
      byModule.set(r.module_name, list);
    }
    res.json({
      items: Array.from(byModule.entries()).map(([name, workspaces]) => ({
        module_name: name,
        workspace_count: workspaces.length,
        workspaces,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/activity — cross-workspace activity feed. Same
// shape as /me/activity but un-scoped to the caller's memberships.
superAdminRouter.get("/activity", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const orgFilter = typeof req.query.org === "string" ? req.query.org : null;
    const userFilter = typeof req.query.user === "string" ? req.query.user : null;
    const actionFilter = typeof req.query.action === "string" ? req.query.action : null;
    let q = meta
      .selectFrom("activity_log as a")
      .leftJoin("orgs as o", "o.id", "a.org_id")
      .leftJoin("users as u", "u.id", "a.user_id")
      .select([
        "a.id",
        "a.action",
        "a.module_name",
        "a.entity_type",
        "a.entity_id",
        "a.diff",
        "a.occurred_at",
        "a.auth_method",
        "o.name as org_name",
        "o.slug as org_slug",
        "u.email as user_email",
        "u.display_name as user_display_name",
      ])
      .orderBy("a.occurred_at", "desc")
      .limit(limit);
    if (orgFilter) q = q.where("o.slug", "=", orgFilter);
    if (userFilter) q = q.where("u.email", "=", userFilter);
    if (actionFilter) q = q.where("a.action", "=", actionFilter);
    const items = await q.execute();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/health — system health snapshot. db ping +
// recent error count + backup-last-success would be ideal; v1 ships
// db + activity-count + a placeholder for backup.
// GET /super-admin/sandbox-cpu — per-workspace + per-module wasm
// CPU usage over the current accounting window. Pairs with the
// platform-side CPU quota (see SANDBOX_CPU_QUOTA_MS_PER_WINDOW).
// Lets the operator spot workspaces close to / over the limit.
superAdminRouter.get("/sandbox-cpu", async (_req, res, next) => {
  try {
    const stats = getCpuStats();
    // Hydrate workspace slugs + names for display.
    const orgIds = stats.workspaces.map((w) => w.orgId);
    let orgsById: Map<string, { name: string; slug: string }> = new Map();
    if (orgIds.length > 0) {
      const rows = await meta
        .selectFrom("orgs")
        .select(["id", "name", "slug"])
        .where("id", "in", orgIds)
        .execute();
      orgsById = new Map(rows.map((r) => [r.id, { name: r.name, slug: r.slug }]));
    }
    res.json({
      window_ms: stats.windowMs,
      quota_ms_per_window: stats.quotaMsPerWindow,
      workspaces: stats.workspaces.map((w) => {
        const org = orgsById.get(w.orgId);
        return {
          org_id: w.orgId,
          name: org?.name ?? "(unknown)",
          slug: org?.slug ?? "",
          used_ms: w.usedMs,
          samples: w.samples,
          pct: w.usedMs / stats.quotaMsPerWindow,
          by_module: w.byModule,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/sandbox-telemetry — per-(workspace, module)
// invocation count + error rate + p50/p95 latency. Process-
// lifetime totals; the latency p50/p95 is computed over a rolling
// ring of the most recent ~200 invocations so the percentiles
// reflect current behaviour rather than aging-out historicals.
superAdminRouter.get("/sandbox-telemetry", async (_req, res, next) => {
  try {
    const rows = getInvocationStats();
    const orgIds = [...new Set(rows.map((r) => r.orgId))];
    let orgsById: Map<string, { name: string; slug: string }> = new Map();
    if (orgIds.length > 0) {
      const orgRows = await meta
        .selectFrom("orgs")
        .select(["id", "name", "slug"])
        .where("id", "in", orgIds)
        .execute();
      orgsById = new Map(orgRows.map((r) => [r.id, { name: r.name, slug: r.slug }]));
    }
    res.json({
      rows: rows.map((r) => ({
        org_id: r.orgId,
        name: orgsById.get(r.orgId)?.name ?? "(unknown)",
        slug: orgsById.get(r.orgId)?.slug ?? "",
        module_name: r.moduleName,
        invocations: r.invocations,
        errors: r.errors,
        error_rate: r.errorRate,
        p50_ms: r.p50Ms,
        p95_ms: r.p95Ms,
        recent_samples: r.recentSamples,
      })),
    });
  } catch (err) {
    next(err);
  }
});

superAdminRouter.get("/health", async (_req, res, next) => {
  try {
    const dbStart = Date.now();
    await meta.selectFrom("orgs").select("id").limit(1).execute();
    const dbLatencyMs = Date.now() - dbStart;
    const recentActivity = await meta
      .selectFrom("activity_log")
      .select(meta.fn.count<number>("id").as("c"))
      .where("occurred_at", ">", sql<Date>`now() - interval '1 hour'` as never)
      .executeTakeFirst();
    res.json({
      db: { ok: true, latency_ms: dbLatencyMs },
      activity_1h: Number(recentActivity?.c ?? 0),
      // Backup status would come from a sidecar / restic state file.
      // Stub for v1 — operator confirms via `restic snapshots` on
      // the host. See docs/operations/PRODUCTION_DEPLOY.md §5.
      backup: { ok: null, note: "Verify via `restic snapshots` on host." },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ───────────────────── signup invites (invite-only beta) ─────────────────
// Single-use links that let a new person self-register their OWN account +
// workspace while public signup stays off. Redeemed via POST /auth/signup
// with the token; minted + managed here.

const MintInvite = z.object({
  email: z.string().email().max(255).optional(),
  note: z.string().max(200).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

function inviteStatus(r: { consumed_at: Date | null; revoked_at: Date | null; expires_at: Date | null }): string {
  if (r.revoked_at) return "revoked";
  if (r.consumed_at) return "consumed";
  if (r.expires_at && new Date(r.expires_at) < new Date()) return "expired";
  return "open";
}

// POST /super-admin/signup-invites — mint one. Returns the token (shown once
// in the link; we don't display it again after).
superAdminRouter.post("/signup-invites", async (req, res, next) => {
  try {
    const parsed = MintInvite.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad invite", details: parsed.error.issues } });
      return;
    }
    const userId = (req as unknown as { session?: { id: string } }).session?.id;
    const token = randomBytes(24).toString("base64url");
    const expires_at = parsed.data.expires_in_days
      ? new Date(Date.now() + parsed.data.expires_in_days * 86_400_000)
      : null;
    const row = await meta
      .insertInto("signup_invites")
      .values({
        token,
        created_by: userId!,
        invited_email: parsed.data.email?.toLowerCase().trim() ?? null,
        note: parsed.data.note ?? null,
        expires_at,
      })
      .returning(["id", "token", "invited_email", "note", "expires_at", "created_at"])
      .executeTakeFirstOrThrow();
    res.status(201).json({ ...row, status: "open" });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/signup-invites — list, newest first, with status + who
// redeemed it. The raw token is NOT returned (it's a credential); the link is
// shown once at mint time.
superAdminRouter.get("/signup-invites", async (_req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("signup_invites as i")
      .leftJoin("users as u", "u.id", "i.consumed_by_user")
      .select([
        "i.id",
        "i.invited_email",
        "i.note",
        "i.expires_at",
        "i.consumed_at",
        "i.revoked_at",
        "i.created_at",
        "u.email as consumed_by_email",
      ])
      .orderBy("i.created_at", "desc")
      .limit(200)
      .execute();
    res.json({ items: rows.map((r) => ({ ...r, status: inviteStatus(r) })) });
  } catch (err) {
    next(err);
  }
});

// POST /super-admin/signup-invites/:id/revoke — kill an unused invite.
superAdminRouter.post("/signup-invites/:id/revoke", async (req, res, next) => {
  try {
    const updated = await meta
      .updateTable("signup_invites")
      .set({ revoked_at: new Date() })
      .where("id", "=", req.params.id)
      .where("consumed_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) {
      res.status(409).json({ error: { code: "not_revocable", message: "Invite not found or already used." } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
