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
import { getTenantDb } from "../db/tenant.js";
import { getCpuStats, getInvocationStats } from "../sandbox/pool.js";
import { hasAuthEmailSender, sendAuthEmail } from "../platform/hosted-seams.js";
import { dispatch } from "../platform/notifications.js";
import { announce, listAnnounceSettings, setAnnounceSetting } from "../platform/announce.js";

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

    // If the invite carries an email and a sender is registered (the cloud
    // overlay's managed sender, or a self-hoster's SMTP), email the join link
    // straight to the invitee. Otherwise the caller copies the link by hand.
    let emailed = false;
    if (row.invited_email && hasAuthEmailSender()) {
      const link = `${req.protocol}://${req.get("host") ?? ""}/join/${row.token}`;
      const expiryLine = row.expires_at
        ? `\n\nThis invite expires ${new Date(row.expires_at).toUTCString()}.`
        : "";
      emailed = await sendAuthEmail({
        to: row.invited_email,
        subject: "You're invited to Cobblr",
        text:
          `You've been invited to create your Cobblr workspace.\n\n` +
          `Open this link to get started:\n${link}` +
          expiryLine +
          `\n\nIf you weren't expecting this, you can ignore this email.`,
        kind: "invite",
      });
    }
    res.status(201).json({ ...row, status: "open", emailed });
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

// ─────────────────────── AI activity — cross-workspace ───────────────────────
// Aggregates each tenant's core_ai_calls into one platform-wide AI log. core_ai_calls
// is a module table (not in the core tenant type), so we query it with raw SQL
// per tenant DB. Filterable by workspace / capability / user-email.
interface AiActivityRow {
  id: string;
  user_id: string | null;
  capability: string;
  provider_id: string;
  model: string | null;
  input_summary: string | null;
  output_summary: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  duration_ms: number | null;
  ok: boolean;
  source_kind: string | null;
  cached: boolean;
  invoked_at: Date;
}

superAdminRouter.get("/ai-activity", async (req, res, next) => {
  try {
    const capability = typeof req.query.capability === "string" && req.query.capability ? req.query.capability : null;
    const orgSlug = typeof req.query.org === "string" && req.query.org ? req.query.org : null;
    const userFilter = typeof req.query.user === "string" && req.query.user ? req.query.user.toLowerCase() : null;
    const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 500);
    const perOrg = Math.min(limit, 100);

    let orgsQ = meta.selectFrom("orgs").select(["id", "name", "slug"]);
    if (orgSlug) orgsQ = orgsQ.where("slug", "=", orgSlug);
    const orgs = await orgsQ.execute();

    const rows: Array<AiActivityRow & { org_id: string; org_name: string; org_slug: string }> = [];
    for (const org of orgs) {
      try {
        const tdb = await getTenantDb(org.id);
        const whereCap = capability ? sql`where capability = ${capability}` : sql``;
        const r = await sql<AiActivityRow>`
          select id, user_id, capability, provider_id, model, input_summary, output_summary,
                 input_tokens, output_tokens, cost_cents, duration_ms, ok, source_kind, cached, invoked_at
          from core_ai_calls ${whereCap}
          order by invoked_at desc limit ${perOrg}`.execute(tdb);
        for (const row of r.rows) rows.push({ ...row, org_id: org.id, org_name: org.name, org_slug: org.slug });
      } catch {
        // Tenant DB may not have core_ai_calls (module never enabled) — skip it.
      }
    }

    // Resolve user_id → email/name from the shared users table.
    const userIds = [...new Set(rows.map((r) => r.user_id).filter((x): x is string => !!x))];
    const users = userIds.length
      ? await meta.selectFrom("users").select(["id", "email", "display_name"]).where("id", "in", userIds).execute()
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));

    let out = rows.map((r) => ({
      ...r,
      user_email: r.user_id ? byId.get(r.user_id)?.email ?? null : null,
      user_name: r.user_id ? byId.get(r.user_id)?.display_name ?? null : null,
    }));
    if (userFilter) out = out.filter((r) => (r.user_email ?? "").toLowerCase().includes(userFilter));
    out.sort((a, b) => new Date(b.invoked_at).getTime() - new Date(a.invoked_at).getTime());
    res.json({ items: out.slice(0, limit) });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/ai-activity/:orgId/:id — full prompt + response for one call.
superAdminRouter.get("/ai-activity/:orgId/:id", async (req, res, next) => {
  try {
    const org = await meta.selectFrom("orgs").select(["id", "name", "slug"]).where("id", "=", req.params.orgId!).executeTakeFirst();
    if (!org) {
      res.status(404).json({ error: { code: "not_found", message: "Workspace not found." } });
      return;
    }
    const tdb = await getTenantDb(org.id);
    const r = await sql<AiActivityRow & { input_full: string | null; output_full: string | null; error: string | null }>`
      select * from core_ai_calls where id = ${req.params.id} limit 1`.execute(tdb);
    const row = r.rows[0];
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Entry not found." } });
      return;
    }
    const u = row.user_id
      ? await meta.selectFrom("users").select(["email", "display_name"]).where("id", "=", row.user_id).executeTakeFirst()
      : null;
    res.json({ ...row, org: { id: org.id, name: org.name, slug: org.slug }, user_email: u?.email ?? null, user_name: u?.display_name ?? null });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────── feedback triage ───────────────────────────────
// The queue users submit into (POST /feedback). Reviewed + worked here.

const UpdateFeedback = z.object({
  status: z.enum(["new", "triaged", "in_progress", "resolved", "wontfix"]).optional(),
  admin_notes: z.string().max(5000).nullable().optional(),
  // When true, send the reporter an in-app notification (a "we looked at
  // this" / "it's fixed" reply). `reply_message` is the human note; falls
  // back to a status-derived default. Best-effort — never fails the update.
  notify_reporter: z.boolean().optional(),
  reply_message: z.string().max(2000).optional(),
});

// GET /super-admin/feedback?status=new — triage queue, newest first, with who
// submitted + which workspace.
superAdminRouter.get("/feedback", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    let q = meta
      .selectFrom("feedback as f")
      .leftJoin("users as u", "u.id", "f.user_id")
      .leftJoin("orgs as o", "o.id", "f.org_id")
      .select([
        "f.id",
        "f.type",
        "f.message",
        "f.context",
        "f.status",
        "f.admin_notes",
        "f.created_at",
        "f.updated_at",
        "u.email as user_email",
        "u.display_name as user_name",
        "o.slug as workspace_slug",
        "o.name as workspace_name",
      ])
      .orderBy("f.created_at", "desc")
      .limit(200);
    if (status) q = q.where("f.status", "=", status);
    res.json({ items: await q.execute() });
  } catch (err) {
    next(err);
  }
});

// PATCH /super-admin/feedback/:id — set status / admin notes during triage.
superAdminRouter.patch("/feedback/:id", async (req, res, next) => {
  try {
    const parsed = UpdateFeedback.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad update", details: parsed.error.issues } });
      return;
    }
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.admin_notes !== undefined) patch.admin_notes = parsed.data.admin_notes;
    const row = await meta
      .updateTable("feedback")
      .set(patch)
      .where("id", "=", req.params.id)
      .returning(["id", "status", "admin_notes", "updated_at", "user_id", "org_id", "message", "context"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Feedback not found." } });
      return;
    }

    // Optionally close the loop with the reporter — "we looked at this / it's
    // fixed". Best-effort: a failed notification must not fail the triage update.
    let notified = false;
    if (parsed.data.notify_reporter && row.user_id) {
      try {
        // The reporter's workspace: the org they filed from, else their first.
        let orgId = row.org_id ?? null;
        if (!orgId) {
          const m = await meta
            .selectFrom("org_memberships")
            .select("org_id")
            .where("user_id", "=", row.user_id)
            .orderBy("joined_at", "asc")
            .executeTakeFirst();
          orgId = m?.org_id ?? null;
        }
        if (orgId) {
          const ctx = (row.context ?? {}) as { route?: string };
          const defaultMsg =
            parsed.data.status === "resolved"
              ? "The issue you reported has been fixed — it's live now."
              : parsed.data.status === "wontfix"
                ? "We reviewed your feedback — thanks for flagging it."
                : "We're looking into the feedback you sent.";
          await dispatch({
            orgId,
            userId: row.user_id,
            eventType: "platform.feedback.replied",
            message: parsed.data.reply_message?.trim() || defaultMsg,
            link_url: typeof ctx.route === "string" ? ctx.route : undefined,
          });
          notified = true;
        }
      } catch (err) {
        console.error("[super-admin] feedback-reply notification failed:", err);
      }
    }

    // Announce a resolution to Discord (toggleable; off by default of the
    // category if an admin silences it — e.g. to avoid doubling a commit feed).
    if (parsed.data.status === "resolved") {
      const ctx = (row.context ?? {}) as { route?: string };
      void announce("feedback.resolved", {
        title: "✅ Feedback resolved",
        body: (row.message ?? "").slice(0, 1500),
        color: 0x2e7d32,
        fields: typeof ctx.route === "string" && ctx.route ? [{ name: "page", value: ctx.route, inline: true }] : undefined,
      });
    }

    res.json({ ...row, notified });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── announcements config ──────────────────────────────
// Per-category Discord posting toggles (feedback new/resolved, bundle events,
// platform updates). See platform/announce.ts. Super-admin only (whole router
// is already behind requirePlatformAdmin).

superAdminRouter.get("/announce-settings", async (_req, res, next) => {
  try {
    res.json({ items: await listAnnounceSettings() });
  } catch (err) {
    next(err);
  }
});

const AnnounceSettingPatch = z.object({
  enabled: z.boolean().optional(),
  // null clears the per-category channel override (falls back to the default).
  webhook_url: z.string().url().max(500).nullable().optional(),
});

superAdminRouter.patch("/announce-settings/:category", async (req, res, next) => {
  try {
    const parsed = AnnounceSettingPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad update", details: parsed.error.issues } });
      return;
    }
    await setAnnounceSetting(req.params.category, parsed.data);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("unknown announce category")) {
      res.status(404).json({ error: { code: "not_found", message: err.message } });
      return;
    }
    next(err);
  }
});
