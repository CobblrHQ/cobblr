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
import { requireAuth, requirePlatformAdmin, isPlatformAdmin } from "../auth/middleware.js";
import { scanResolversRouter } from "./super-admin-scan-resolvers.js";
import { signImpersonation } from "../auth/jwt.js";
import { log as activityLog } from "../platform/activity.js";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import { hardDeleteOrg } from "../platform/delete-org.js";
import { getCpuStats, getInvocationStats } from "../sandbox/pool.js";
import { hasAuthEmailSender, sendAuthEmail } from "../platform/hosted-seams.js";
import { notifyAccount } from "../platform/notifications.js";
import { announce, listAnnounceSettings, setAnnounceSetting, isComposable } from "../platform/announce.js";
import { reporterCardFields } from "../platform/feedback-card.js";
import { pokeDiscordResolved, pokeDiscordWaitlistCard } from "../platform/discord-bot-trigger.js";
import { pokeTriage } from "../platform/triage-trigger.js";
import { absoluteAppUrl } from "../platform/public-url.js";
import { feedbackReplyAddress } from "../platform/feedback-reply.js";
import {
  runMatchmaker,
  type PerceivedItem,
  type ScanMenuEntry,
} from "@cobblr/core-scan/services/matchmaker";
import { llmIdentify } from "@cobblr/core-scan/services/barcode-websearch";
import { identifyImage } from "@cobblr/core-scan/services/enrich-photo";
import { platform } from "@cobblr/platform-contract";
import { assembleContext, compilePrompt, unwrapBuild, parseJsonObject } from "@cobblr/core-authoring/services/compile";
import { validateBundle } from "./bundles.js";

// ── Feedback reply email (HTML) ──────────────────────────────────────
// A small, email-client-safe HTML body for the transactional feedback reply,
// so it reads as a designed message (greeting · the quoted report in a styled
// blockquote · the fix · a button to the thread) rather than a wall of text.
// The plaintext version is always sent alongside as the fallback.
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function feedbackEmailHtml(opts: { greeting: string; reportText?: string; bodyParas: string[]; ctaUrl: string; ctaLabel: string; footerNote?: string }): string {
  const para = (t: string) => `<p style="margin:0 0 14px;">${escHtml(t).replace(/\n/g, "<br>")}</p>`;
  const quote = opts.reportText
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:13px;">You reported:</p>
       <blockquote style="margin:0 0 18px;padding:10px 16px;border-left:3px solid #c7b8a6;background:#f6f3ee;color:#374151;border-radius:0 6px 6px 0;white-space:pre-wrap;">${escHtml(opts.reportText)}</blockquote>`
    : "";
  return `<!DOCTYPE html><html><body style="margin:0;background:#f3f4f6;padding:24px 12px;">
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;font-size:15px;line-height:1.5;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 28px 24px;">
    <p style="margin:0 0 16px;">${escHtml(opts.greeting)}</p>
    ${quote}
    ${opts.bodyParas.map(para).join("")}
    <p style="margin:22px 0 8px;"><a href="${escHtml(opts.ctaUrl)}" style="display:inline-block;background:#8a6f47;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;">${escHtml(opts.ctaLabel)}</a></p>
    ${opts.footerNote ? `<p style="margin:14px 0 0;color:#9ca3af;font-size:12px;">${escHtml(opts.footerNote)}</p>` : ""}
    <p style="margin:18px 0 0;color:#9ca3af;font-size:12px;">— The Cobblr team</p>
  </div></body></html>`;
}

export const superAdminRouter = Router();

// Every route below requires platform admin. The composition
// `requireAuth → requirePlatformAdmin` lands here.
superAdminRouter.use(requireAuth, requirePlatformAdmin);

// Vendor scan-URL resolver list (built-in + operator-added). See
// super-admin-scan-resolvers.ts.
superAdminRouter.use("/scan-url-resolvers", scanResolversRouter);

// GET /super-admin/overview — the dashboard landing. Counts +
// at-a-glance numbers. Cheap; safe to poll.
superAdminRouter.get("/overview", async (_req, res, next) => {
  try {
    const [orgsCount, usersCount, activeUsers, activityToday, totalGrants, totalBundles, feedbackNew, waitlistPending, barcodeUpcs] =
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
        // "Needs attention" numbers — the reason an operator opens this page.
        meta
          .selectFrom("feedback")
          .select(meta.fn.count<number>("id").as("c"))
          .where("status", "in", ["new", "triaged"])
          .executeTakeFirst(),
        meta
          .selectFrom("waitlist")
          .select(meta.fn.count<number>("id").as("c"))
          .where("status", "=", "pending")
          .executeTakeFirst(),
        meta
          .selectFrom("shared_cache")
          .select(meta.fn.count<number>("key").as("c"))
          .where("namespace", "=", "barcode")
          .executeTakeFirst(),
      ]);
    res.json({
      orgs_count: Number(orgsCount?.c ?? 0),
      users_count: Number(usersCount?.c ?? 0),
      active_users_7d: Number(activeUsers?.c ?? 0),
      activity_24h: Number(activityToday?.c ?? 0),
      capability_grants: Number(totalGrants?.c ?? 0),
      bundles_installed: Number(totalBundles?.c ?? 0),
      feedback_open: Number(feedbackNew?.c ?? 0),
      waitlist_pending: Number(waitlistPending?.c ?? 0),
      barcode_cache_upcs: Number(barcodeUpcs?.c ?? 0),
      build_sha: process.env.COBBLR_BUILD_SHA || null,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /super-admin/workspaces/:id — operator plan control. plan:"disabled"
// is a real switch: withTenant refuses every tenant-scoped call for a
// disabled workspace (login stays; re-enable restores). Also how a plan is
// flipped free↔paid for the entitlement guard.
const PatchWorkspace = z.object({ plan: z.enum(["free", "paid", "disabled"]) });
superAdminRouter.patch("/workspaces/:id", async (req, res, next) => {
  try {
    const parsed = PatchWorkspace.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "plan must be free | paid | disabled" } });
      return;
    }
    const updated = await meta
      .updateTable("orgs")
      .set({ plan: parsed.data.plan })
      .where("id", "=", req.params.id!)
      .returning(["id", "slug", "plan"])
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "Workspace not found." } });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/ai-summary — 24h AI usage roll-up for the Overview card.
// Loops tenant DBs (same pattern as /ai-activity) but count+sum only; keep
// it on its own endpoint so /overview stays meta-cheap.
superAdminRouter.get("/ai-summary", async (_req, res, next) => {
  try {
    const orgs = await meta.selectFrom("orgs").select(["id"]).execute();
    let calls = 0;
    let costCents = 0;
    for (const org of orgs) {
      try {
        const tdb = await getTenantDb(org.id);
        const r = await sql<{ c: number; cost: number | null }>`
          select count(*)::int as c, coalesce(sum(cost_cents), 0)::float as cost
          from core_ai_calls where invoked_at > now() - interval '24 hours'`.execute(tdb);
        calls += Number(r.rows[0]?.c ?? 0);
        costCents += Number(r.rows[0]?.cost ?? 0);
      } catch {
        // Tenant without core_ai_calls (module never enabled) — skip.
      }
    }
    res.json({ calls_24h: calls, cost_cents_24h: Math.round(costCents) });
  } catch (err) {
    next(err);
  }
});

// DELETE /super-admin/workspaces/:id — operator hard-delete (the same
// machinery as the owner-facing DELETE /orgs/:slug). Exists for cleaning up
// e2e/test detritus from the console; the UI double-confirms with the slug.
superAdminRouter.delete("/workspaces/:id", async (req, res, next) => {
  try {
    const org = await meta
      .selectFrom("orgs")
      .select(["id", "slug", "name"])
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!org) {
      res.status(404).json({ error: { code: "not_found", message: "Workspace not found." } });
      return;
    }
    await hardDeleteOrg(org.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/instance-config — which operator-level switches are live
// on THIS instance. Read-only, booleans + non-secret identifiers only (never
// echoes tokens/keys). The console's Health section renders these so "what
// mode is this instance in" stops requiring a box ssh.
superAdminRouter.get("/instance-config", async (_req, res, next) => {
  try {
    const { publicSignupEnabled, selfServeInvitesEnabled } = await import("../auth/signup-gate.js");
    res.json({
      node_env: process.env.NODE_ENV || "development",
      build_sha: process.env.COBBLR_BUILD_SHA || null,
      public_signup: publicSignupEnabled(),
      self_serve_invites: selfServeInvitesEnabled(),
      ai_enabled: (process.env.COBBLR_AI_ENABLED ?? "true").toLowerCase() !== "false",
      sandbox_registry_configured: !!process.env.COBBLR_REGISTRY_URL || true, // default GitHub registry counts as configured
      barcode_resolver_configured: !!process.env.COBBLR_BARCODE_RESOLVER_URL,
    });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/barcode-resolver-stats — proxy the box-level barcode
// resolver's /stats (cache size, today's upcitemdb budget) so the operator
// sees the shared cache's health without shelling into the host. 503 with
// not_configured when the instance doesn't use a resolver.
superAdminRouter.get("/barcode-resolver-stats", async (_req, res) => {
  try {
    const base = (process.env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
    if (!base) {
      res.status(503).json({ error: { code: "not_configured", message: "No barcode resolver on this instance." } });
      return;
    }
    const r = await fetch(`${base}/stats`, {
      headers: { authorization: `Bearer ${process.env.COBBLR_BARCODE_RESOLVER_TOKEN ?? ""}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      res.status(502).json({ error: { code: "resolver_error", message: `Resolver answered HTTP ${r.status}.` } });
      return;
    }
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: { code: "resolver_unreachable", message: (err as Error).message } });
  }
});

// Barcode correction review (the human-verified-correction approval queue). The
// operator approves/rejects corrections that untrusted instances PROPOSED
// (verified=false). These proxy the box resolver's review endpoints with the
// REVIEW token (the resolver's write-token) — kept server-side, super-admin only;
// it never reaches the browser. See CobblrHQ/barcode-intelligence/docs/correction-feedback.md.
async function resolverReview(
  method: "GET" | "POST",
  pathAndQuery: string,
  body: unknown,
  res: import("express").Response,
): Promise<void> {
  const base = (process.env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
  const tok = process.env.COBBLR_BARCODE_RESOLVER_REVIEW_TOKEN ?? "";
  if (!base || !tok) {
    res.status(503).json({ error: { code: "not_configured", message: "No barcode-correction review token on this instance." } });
    return;
  }
  try {
    const r = await fetch(`${base}${pathAndQuery}`, {
      method,
      headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : r.status === 401 ? 502 : r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: { code: "resolver_unreachable", message: (err as Error).message } });
  }
}

// GET /super-admin/barcode-corrections — pending proposed corrections to review.
superAdminRouter.get("/barcode-corrections", async (req, res) => {
  const limit = String(req.query.limit ?? "100").replace(/[^0-9]/g, "") || "100";
  await resolverReview("GET", `/proposed?limit=${limit}`, null, res);
});
// POST /super-admin/barcode-corrections/:id/verify|reject — approve / reject.
superAdminRouter.post("/barcode-corrections/:id/verify", async (req, res) => {
  await resolverReview("POST", "/verify", { id: String(req.params.id) }, res);
});
superAdminRouter.post("/barcode-corrections/:id/reject", async (req, res) => {
  await resolverReview("POST", "/reject", { id: String(req.params.id) }, res);
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

// GET /super-admin/product-metrics — the thesis dashboard (2026-07 audit F2).
// Per workspace: time-to-first-working-app (org created → first `created`
// activity row) and walls-hit (product_events: permission_denied,
// validation_rejected, … + wire failures from activity_log), windowed 7d/30d.
// Strategy docs: "walls-hit-per-week trending to zero for a genuine non-dev
// is the proof" — this is where that number lives. HTTP-first by design;
// an operator-console section can render it later.
superAdminRouter.get("/product-metrics", async (_req, res, next) => {
  try {
    const orgs = await meta
      .selectFrom("orgs")
      .select(["id", "name", "slug", "created_at"])
      .orderBy("created_at", "desc")
      .execute();

    // First ITEM per org — the "working app" half of TTFW. Module creates log
    // as `<noun>_created` (part_created, machine_created, …); org/user
    // lifecycle rows share the suffix but aren't items, so they're excluded.
    const firstCreated = await meta
      .selectFrom("activity_log")
      .select(["org_id", sql<Date>`min(occurred_at)`.as("first_at")])
      .where("action", "like", "%_created")
      .where("action", "not in", ["org_created", "user_created", "tenant_created", "wire_created"])
      .groupBy("org_id")
      .execute();
    const firstByOrg = new Map(firstCreated.map((r) => [r.org_id, r.first_at]));

    // Walls: product_events grouped by org+event, 7d and 30d windows.
    const walls = await meta
      .selectFrom("product_events")
      .select([
        "org_id",
        "event",
        sql<number>`count(*) filter (where created_at > now() - interval '7 days')`.as("d7"),
        sql<number>`count(*) filter (where created_at > now() - interval '30 days')`.as("d30"),
      ])
      .where("created_at", ">", sql<Date>`now() - interval '30 days'`)
      .groupBy(["org_id", "event"])
      .execute();
    const wallsByOrg = new Map<string, Array<{ event: string; d7: number; d30: number }>>();
    for (const w of walls) {
      const list = wallsByOrg.get(w.org_id) ?? [];
      list.push({ event: w.event, d7: Number(w.d7), d30: Number(w.d30) });
      wallsByOrg.set(w.org_id, list);
    }

    // Wire failures live in activity_log (wire_failed / wire_depth_exceeded)
    // — they're walls too, just recorded by the wire engine.
    const wireWalls = await meta
      .selectFrom("activity_log")
      .select([
        "org_id",
        "action",
        sql<number>`count(*) filter (where occurred_at > now() - interval '7 days')`.as("d7"),
        sql<number>`count(*) filter (where occurred_at > now() - interval '30 days')`.as("d30"),
      ])
      .where("action", "in", ["wire_failed", "wire_depth_exceeded"])
      .where("occurred_at", ">", sql<Date>`now() - interval '30 days'`)
      .groupBy(["org_id", "action"])
      .execute();
    for (const w of wireWalls) {
      const list = wallsByOrg.get(w.org_id) ?? [];
      list.push({ event: w.action, d7: Number(w.d7), d30: Number(w.d30) });
      wallsByOrg.set(w.org_id, list);
    }

    res.json({
      workspaces: orgs.map((o) => {
        const first = firstByOrg.get(o.id) ?? null;
        const wallList = wallsByOrg.get(o.id) ?? [];
        return {
          org_id: o.id,
          name: o.name,
          slug: o.slug,
          created_at: o.created_at,
          first_item_at: first,
          ttfw_minutes: first
            ? Math.round((new Date(first).getTime() - new Date(o.created_at).getTime()) / 60_000)
            : null,
          walls: wallList.sort((a, b) => b.d7 - a.d7),
          walls_7d: wallList.reduce((n, w) => n + w.d7, 0),
          walls_30d: wallList.reduce((n, w) => n + w.d30, 0),
        };
      }),
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

// ──────────────────────────── waitlist ────────────────────────────
// Signups from the marketing site (cobblr.xyz). The Pages Function POSTs each
// form submission to /ingest (scoped waitlist:ingest token, create-only);
// admins review in the Waitlist tab and approve (mints a signup_invite,
// emailed when a sender is registered) or dismiss.

const IngestWaitlist = z.object({
  email: z.string().email().max(255),
  source: z.string().max(60).optional(),
  user_agent: z.string().max(500).optional(),
  signed_up_at: z.string().datetime().optional(),
});

// POST /super-admin/waitlist/ingest — idempotent on the pending row: a repeat
// signup for an email that's already pending (or already invited) is a 200
// no-op, so the marketing form can't create duplicates.
superAdminRouter.post("/waitlist/ingest", async (req, res, next) => {
  try {
    const parsed = IngestWaitlist.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad signup", details: parsed.error.issues } });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
    const existing = await meta
      .selectFrom("waitlist")
      .select(["id", "status"])
      .where(sql`lower(email)`, "=", email)
      .where("status", "in", ["pending", "invited"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (existing) {
      res.json({ id: existing.id, status: existing.status, duplicate: true });
      return;
    }
    const row = await meta
      .insertInto("waitlist")
      .values({
        email,
        source: parsed.data.source ?? "marketing-site",
        user_agent: parsed.data.user_agent ?? null,
        signed_up_at: parsed.data.signed_up_at ? new Date(parsed.data.signed_up_at) : new Date(),
      })
      .returning(["id", "created_at"])
      .executeTakeFirstOrThrow();
    void announce("waitlist.new", {
      title: "📋 New waitlist signup",
      body: email,
      color: 0x6b8e4e,
    });
    // Post an actionable card (embed + Approve button) to the Discord admin
    // channel so the author can approve from his phone without the web dashboard. The
    // button calls this same /approve endpoint. No-op when the bot isn't wired.
    pokeDiscordWaitlistCard({
      waitlist_id: row.id,
      email,
      source: parsed.data.source ?? "marketing-site",
      signed_up_at: (parsed.data.signed_up_at ? new Date(parsed.data.signed_up_at) : row.created_at).toISOString(),
      user_agent: parsed.data.user_agent ?? null,
    });
    res.status(201).json({ id: row.id, status: "pending", duplicate: false });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/waitlist — newest first, with the linked invite's state.
superAdminRouter.get("/waitlist", async (_req, res, next) => {
  try {
    const rows = await meta
      .selectFrom("waitlist as w")
      .leftJoin("signup_invites as i", "i.id", "w.invite_id")
      .leftJoin("users as d", "d.id", "w.decided_by")
      .select([
        "w.id",
        "w.email",
        "w.source",
        "w.signed_up_at",
        "w.status",
        "w.decided_at",
        "w.created_at",
        "d.email as decided_by_email",
        "i.consumed_at as invite_consumed_at",
        "i.revoked_at as invite_revoked_at",
        "i.expires_at as invite_expires_at",
      ])
      .orderBy("w.created_at", "desc")
      .limit(500)
      .execute();
    res.json({
      items: rows.map((r) => ({
        ...r,
        invite_status: r.status === "invited"
          ? inviteStatus({ consumed_at: r.invite_consumed_at, revoked_at: r.invite_revoked_at, expires_at: r.invite_expires_at })
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const ApproveWaitlist = z.object({
  note: z.string().max(200).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
});

// POST /super-admin/waitlist/:id/approve — mint a signup_invite locked to the
// signup's email (emailed automatically when a sender is registered) and mark
// the row invited. Same invite mechanics as /signup-invites.
superAdminRouter.post("/waitlist/:id/approve", async (req, res, next) => {
  try {
    const parsed = ApproveWaitlist.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad approval", details: parsed.error.issues } });
      return;
    }
    const entry = await meta
      .selectFrom("waitlist")
      .select(["id", "email", "status"])
      .where("id", "=", req.params.id)
      .executeTakeFirst();
    if (!entry || entry.status !== "pending") {
      res.status(409).json({ error: { code: "not_pending", message: "Signup not found or already decided." } });
      return;
    }
    const userId = (req as unknown as { session?: { id: string } }).session?.id;
    const token = randomBytes(24).toString("base64url");
    const expires_at = parsed.data.expires_in_days
      ? new Date(Date.now() + parsed.data.expires_in_days * 86_400_000)
      : new Date(Date.now() + 14 * 86_400_000); // waitlist invites default to 14d
    const invite = await meta
      .insertInto("signup_invites")
      .values({
        token,
        created_by: userId!,
        invited_email: entry.email,
        note: parsed.data.note ?? "waitlist",
        expires_at,
      })
      .returning(["id", "token", "invited_email", "expires_at", "created_at"])
      .executeTakeFirstOrThrow();
    let emailed = false;
    if (hasAuthEmailSender()) {
      const link = `${req.protocol}://${req.get("host") ?? ""}/join/${invite.token}`;
      emailed = await sendAuthEmail({
        to: entry.email,
        subject: "You're off the Cobblr waitlist 🎉",
        text:
          `Good news — a spot opened up.\n\n` +
          `Open this link to create your Cobblr workspace:\n${link}` +
          `\n\nThis invite expires ${new Date(invite.expires_at!).toUTCString()}.` +
          `\n\nIf you weren't expecting this, you can ignore this email.`,
        kind: "invite",
      });
    }
    await meta
      .updateTable("waitlist")
      .set({ status: "invited", invite_id: invite.id, decided_at: new Date(), decided_by: userId ?? null })
      .where("id", "=", entry.id)
      .execute();
    res.status(201).json({ id: entry.id, status: "invited", invite: { ...invite, emailed } });
  } catch (err) {
    next(err);
  }
});

// POST /super-admin/waitlist/:id/dismiss — decline without inviting.
superAdminRouter.post("/waitlist/:id/dismiss", async (req, res, next) => {
  try {
    const userId = (req as unknown as { session?: { id: string } }).session?.id;
    const updated = await meta
      .updateTable("waitlist")
      .set({ status: "dismissed", decided_at: new Date(), decided_by: userId ?? null })
      .where("id", "=", req.params.id)
      .where("status", "=", "pending")
      .returning("id")
      .executeTakeFirst();
    if (!updated) {
      res.status(409).json({ error: { code: "not_pending", message: "Signup not found or already decided." } });
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
    // Substring match on source_kind — "matchmaker" / "core-scan" / "barcode"
    // isolates the scanner calls from Ask-Cobblr chat (both log capability=chat).
    const source = typeof req.query.source === "string" && req.query.source ? req.query.source : null;
    const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 500);
    const perOrg = Math.min(limit, 100);

    let orgsQ = meta.selectFrom("orgs").select(["id", "name", "slug"]);
    if (orgSlug) orgsQ = orgsQ.where("slug", "=", orgSlug);
    const orgs = await orgsQ.execute();

    const rows: Array<AiActivityRow & { org_id: string; org_name: string; org_slug: string }> = [];
    for (const org of orgs) {
      try {
        const tdb = await getTenantDb(org.id);
        // Filter in SQL so the per-org cap applies to MATCHING rows (not the
        // newest 100 of everything, then filtered down to nothing).
        const conds = [];
        if (capability) conds.push(sql`capability = ${capability}`);
        if (source) conds.push(sql`source_kind ilike ${"%" + source + "%"}`);
        const whereClause = conds.length
          ? sql`where ${sql.join(conds, sql` and `)}`
          : sql``;
        const r = await sql<AiActivityRow>`
          select id, user_id, capability, provider_id, model, input_summary, output_summary,
                 input_tokens, output_tokens, cost_cents, duration_ms, ok, source_kind, cached, invoked_at
          from core_ai_calls ${whereClause}
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

// ───────────────────────────── barcode cache ─────────────────────────────────
// The per-UPC lookup cache core-scan builds as people scan (go-upc primary,
// upcitemdb/OPF fallback). It's a per-TENANT table (core_scan_barcode_cache —
// the same UPC may resolve differently per workspace), so like /ai-activity
// this aggregates with raw SQL across every tenant DB. Read-only viewer for
// the operator console's "Barcodes" section.
interface BarcodeCacheRow {
  upc: string;
  found: boolean;
  source: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  description: string | null;
  category: string | null;
  image_url: string | null;
  raw: unknown;
  fetched_at: Date;
}

superAdminRouter.get("/barcode-cache", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
    const orgSlug = typeof req.query.org === "string" && req.query.org ? req.query.org : null;
    const source = typeof req.query.source === "string" && req.query.source ? req.query.source : null;
    const found =
      req.query.found === "true" ? true : req.query.found === "false" ? false : null;
    const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 500);
    const perOrg = Math.min(limit, 200);

    // layer=shared → the DEDUPED instance-wide platform.sharedCache layer
    // (namespace 'barcode' in cobblr_meta.shared_cache) — the authoritative
    // "a UPC resolves once per instance" store. The default (workspaces)
    // view reads the per-tenant mirrors, which adds who-scanned-where.
    if (req.query.layer === "shared") {
      const conds = [sql`namespace = ${"barcode"}`];
      if (q) {
        conds.push(
          sql`(key ilike ${"%" + q + "%"} or value->>'title' ilike ${"%" + q + "%"} or value->>'brand' ilike ${"%" + q + "%"})`,
        );
      }
      if (source) conds.push(sql`value->>'source' = ${source}`);
      if (found !== null) conds.push(sql`(value->>'found')::boolean = ${found}`);
      const r = await sql<{
        key: string;
        value: {
          found: boolean;
          source: string;
          title: string | null;
          brand: string | null;
          model: string | null;
          description: string | null;
          category: string | null;
          image_url: string | null;
          raw: unknown;
        };
        expires_at: Date | null;
        updated_at: Date;
      }>`
        select key, value, expires_at, updated_at from shared_cache
        where ${sql.join(conds, sql` and `)}
        order by updated_at desc limit ${limit}`.execute(meta);
      res.json({
        items: r.rows.map((row) => ({
          upc: row.key,
          found: !!row.value.found,
          source: row.value.source ?? "miss",
          title: row.value.title ?? null,
          brand: row.value.brand ?? null,
          model: row.value.model ?? null,
          description: row.value.description ?? null,
          category: row.value.category ?? null,
          image_url: row.value.image_url ?? null,
          raw: row.value.raw ?? {},
          fetched_at: row.updated_at,
          expires_at: row.expires_at,
          org_id: null,
          org_name: null,
          org_slug: null,
        })),
      });
      return;
    }

    let orgsQ = meta.selectFrom("orgs").select(["id", "name", "slug"]);
    if (orgSlug) orgsQ = orgsQ.where("slug", "=", orgSlug);
    const orgs = await orgsQ.execute();

    const rows: Array<BarcodeCacheRow & { org_id: string; org_name: string; org_slug: string }> = [];
    for (const org of orgs) {
      try {
        const tdb = await getTenantDb(org.id);
        const conds = [];
        if (q) conds.push(sql`(upc ilike ${"%" + q + "%"} or title ilike ${"%" + q + "%"} or brand ilike ${"%" + q + "%"})`);
        if (source) conds.push(sql`source = ${source}`);
        if (found !== null) conds.push(sql`found = ${found}`);
        const whereClause = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
        const r = await sql<BarcodeCacheRow>`
          select upc, found, source, title, brand, model, description, category, image_url, raw, fetched_at
          from core_scan_barcode_cache ${whereClause}
          order by fetched_at desc limit ${perOrg}`.execute(tdb);
        for (const row of r.rows) rows.push({ ...row, org_id: org.id, org_name: org.name, org_slug: org.slug });
      } catch {
        // Tenant DB may not have core_scan_barcode_cache (module never enabled) — skip.
      }
    }

    rows.sort((a, b) => new Date(b.fetched_at).getTime() - new Date(a.fetched_at).getTime());
    res.json({ items: rows.slice(0, limit) });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────── feedback triage ───────────────────────────────
// The queue users submit into (POST /feedback). Reviewed + worked here.

const UpdateFeedback = z.object({
  // `backlog` = parked for a human to handle interactively later: OPEN (not
  // dismissed like wontfix), but the autopilot + triage skip it (only
  // new/triaged/in_progress are actionable). The "keep for human" lane.
  status: z.enum(["new", "triaged", "in_progress", "backlog", "resolved", "wontfix"]).optional(),
  admin_notes: z.string().max(5000).nullable().optional(),
  // When true, send the reporter an in-app notification (a "we looked at
  // this" / "it's fixed" reply). `reply_message` is the human note; falls
  // back to a status-derived default. Best-effort — never fails the update.
  notify_reporter: z.boolean().optional(),
  reply_message: z.string().max(2000).optional(),
  // Third-person "what was reported → what we fixed" note for the PUBLIC Discord
  // feedback-resolved post (NOT addressed to the reporter). Distinct from
  // reply_message (the personal in-app/email reply). Used when status=resolved.
  public_summary: z.string().max(2000).optional(),
  // AI triage verdict, written by the host-side analyzer (feedback:triage
  // token). Setting this stamps triaged_at; the analyzer also passes
  // status:"triaged". Kept a nested object so a human PATCH (status/notes)
  // and a machine PATCH (verdict) don't step on each other's shapes.
  triage: z
    .object({
      priority: z.enum(["urgent", "high", "medium", "low"]),
      valid: z.boolean(),
      viable: z.boolean(),
      summary: z.string().max(4000),
      action: z.string().max(2000),
      model: z.string().max(80).optional(),
    })
    .optional(),
});

// GET /super-admin/feedback?status=new — triage queue, newest first, with who
// submitted + which workspace.
superAdminRouter.get("/feedback", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    // sort=priority → analyzed queue, highest priority first (untriaged last);
    // default → newest first.
    const byPriority = req.query.sort === "priority";
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
        "f.attachments",
        "f.triage_priority",
        "f.triage_valid",
        "f.triage_viable",
        "f.triage_summary",
        "f.triage_action",
        "f.triaged_at",
        "f.triage_model",
        "f.origin",
        "f.origin_ref",
        "f.followups",
        "f.created_at",
        "f.updated_at",
        "u.email as user_email",
        "u.display_name as user_name",
        "o.slug as workspace_slug",
        "o.name as workspace_name",
      ])
      .limit(200);
    if (byPriority) {
      // urgent > high > medium > low > untriaged(null). Postgres sorts the
      // CASE rank ascending (1..5), then newest-first within a rank.
      q = q
        .orderBy(
          sql`case f.triage_priority when 'urgent' then 1 when 'high' then 2 when 'medium' then 3 when 'low' then 4 else 5 end`,
          "asc",
        )
        .orderBy("f.created_at", "desc");
    } else {
      q = q.orderBy("f.created_at", "desc");
    }
    if (status) q = q.where("f.status", "=", status);
    res.json({ items: await q.execute() });
  } catch (err) {
    next(err);
  }
});

// POST /super-admin/feedback/ingest — create a ticket from an external channel
// (the Discord support bot). A discord ticket has no platform user (user_id
// null); the reporter + how-to-reply live in origin_ref. Gated by the narrow
// feedback:ingest scope (create-only). Fires triage like a normal submission.
const IngestFeedback = z.object({
  type: z.enum(["bug", "confusing", "idea", "other"]).default("other"),
  message: z.string().trim().min(1).max(5000),
  origin_ref: z.object({
    channel_id: z.string().max(40),
    thread_id: z.string().max(40),
    message_id: z.string().max(40).optional(),
    user_id: z.string().max(40).optional(),
    username: z.string().max(120).optional(),
  }),
});
superAdminRouter.post("/feedback/ingest", async (req, res, next) => {
  try {
    const parsed = IngestFeedback.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad ticket", details: parsed.error.issues } });
      return;
    }
    const row = await meta
      .insertInto("feedback")
      .values({
        user_id: null,
        org_id: null,
        type: parsed.data.type,
        message: parsed.data.message,
        origin: "discord",
        origin_ref: sql`${JSON.stringify(parsed.data.origin_ref)}::jsonb`,
      })
      .returning(["id", "created_at"])
      .executeTakeFirstOrThrow();
    pokeTriage(row.id);
    // Humanised card: "💬 New feedback" / "🐛 New bug report" — not the raw enum
    // ("New other ticket (Discord)"). The "from" field already shows it came via
    // a Discord user, so the redundant "(Discord)" suffix is dropped.
    const TICKET_LABEL: Record<string, { emoji: string; label: string }> = {
      bug: { emoji: "🐛", label: "bug report" },
      confusing: { emoji: "😕", label: "confusing-UX report" },
      idea: { emoji: "💡", label: "idea" },
      other: { emoji: "💬", label: "feedback" },
    };
    const t = TICKET_LABEL[parsed.data.type] ?? { emoji: "💬", label: "feedback" };
    void announce("feedback.new", {
      title: `${t.emoji} New ${t.label}`,
      body: parsed.data.message.slice(0, 1500),
      color: 0x5865f2,
      fields: parsed.data.origin_ref.username ? [{ name: "from", value: parsed.data.origin_ref.username, inline: true }] : undefined,
    });
    res.status(201).json({ id: row.id, created_at: row.created_at });
  } catch (err) {
    next(err);
  }
});

// POST /super-admin/feedback/append — a reporter replied in a ticket thread.
// Finds the ticket by its Discord thread, appends the message to the
// conversation, REOPENS it if it had been resolved/wontfix, and clears
// triaged_at so the analyzer re-judges with the new context. Same create/append
// scope as ingest. The actual reply back to the user stays human-in-the-loop.
const AppendFeedback = z.object({
  thread_id: z.string().max(40),
  from: z.string().max(120).optional(),
  text: z.string().trim().max(5000).default(""),
  images: z
    .array(z.object({ url: z.string().url().max(2000), name: z.string().max(255).optional() }))
    .max(8)
    .default([]),
});
superAdminRouter.post("/feedback/append", async (req, res, next) => {
  try {
    const parsed = AppendFeedback.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad follow-up", details: parsed.error.issues } });
      return;
    }
    if (!parsed.data.text && parsed.data.images.length === 0) {
      res.status(400).json({ error: { code: "empty", message: "Nothing to append." } });
      return;
    }
    const fb = await meta
      .selectFrom("feedback")
      .select(["id", "status", "message"])
      .where(sql`origin_ref ->> 'thread_id'`, "=", parsed.data.thread_id)
      .executeTakeFirst();
    if (!fb) {
      res.status(404).json({ error: { code: "not_found", message: "No ticket for that thread." } });
      return;
    }
    const entry = {
      at: new Date().toISOString(),
      from: parsed.data.from ?? "reporter",
      text: parsed.data.text,
      ...(parsed.data.images.length ? { images: parsed.data.images } : {}),
    };
    const reopened = fb.status === "resolved" || fb.status === "wontfix";
    await meta
      .updateTable("feedback")
      .set({
        followups: sql`coalesce(followups, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
        ...(reopened ? { status: "in_progress" as never } : {}),
        triaged_at: null, // re-judge with the new context
        updated_at: new Date(),
      })
      .where("id", "=", fb.id)
      .execute();
    pokeTriage(fb.id);
    if (reopened) {
      void announce("feedback.new", {
        title: "🔄 Ticket reopened (Discord follow-up)",
        body: (parsed.data.text || "(image / attachment)").slice(0, 1500),
        color: 0xfaa61a,
      });
    }
    res.json({ id: fb.id, reopened });
  } catch (err) {
    next(err);
  }
});

// POST /super-admin/feedback/append-dm — a user replied to the support bot in a
// DIRECT MESSAGE (the Discord round-trip on an in-app feedback item). Unlike
// /append (keyed by a #support thread), this resolves the reporter from their
// VERIFIED Discord connection, then appends to their most-recently-touched
// feedback item — which is the one we just messaged them about (sending a
// clarifying question bumps updated_at). Same feedback:ingest scope as /append.
const AppendDm = z.object({
  discord_user_id: z.string().min(1).max(40),
  text: z.string().trim().max(5000).default(""),
  from: z.string().max(120).optional(),
});
superAdminRouter.post("/feedback/append-dm", async (req, res, next) => {
  try {
    const parsed = AppendDm.safeParse(req.body);
    if (!parsed.success || !parsed.data.text) {
      res.status(400).json({ error: { code: "empty", message: "Nothing to append." } });
      return;
    }
    const conn = await meta
      .selectFrom("discord_connections")
      .select(["user_id"])
      .where("discord_user_id", "=", parsed.data.discord_user_id)
      .where("verified", "=", true)
      .executeTakeFirst();
    if (!conn) {
      res.status(404).json({ error: { code: "no_connection", message: "No verified Discord connection for that user." } });
      return;
    }
    const fb = await meta
      .selectFrom("feedback")
      .select(["id", "status"])
      .where("user_id", "=", conn.user_id)
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!fb) {
      res.status(404).json({ error: { code: "no_item", message: "No feedback item to reply to." } });
      return;
    }
    const entry = { at: new Date().toISOString(), from: parsed.data.from ?? "reporter", text: parsed.data.text, role: "user" as const };
    const reopened = fb.status === "resolved" || fb.status === "wontfix";
    await meta
      .updateTable("feedback")
      .set({
        followups: sql`coalesce(followups, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
        ...(reopened ? { status: "in_progress" as never } : {}),
        triaged_at: null,
      })
      .where("id", "=", fb.id)
      .execute();
    pokeTriage(fb.id);
    res.json({ ok: true, feedback_id: fb.id, reopened });
  } catch (err) {
    next(err);
  }
});

// POST /super-admin/feedback/resolve-by-thread — the reporter clicked the Discord
// support bot's "✅ That solved it — close" button. Resolve the matching ticket.
// Lean on purpose: status only, NO public "resolved" card and NO bot re-poke (the
// bot already archived the thread on the click). Gated by the same feedback:ingest
// scope the bot already holds.
const ResolveByThread = z.object({ thread_id: z.string().min(1), by: z.string().max(120).optional() });
superAdminRouter.post("/feedback/resolve-by-thread", async (req, res, next) => {
  try {
    const parsed = ResolveByThread.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues } });
      return;
    }
    const fb = await meta
      .selectFrom("feedback")
      .select(["id"])
      .where(sql`origin_ref ->> 'thread_id'`, "=", parsed.data.thread_id)
      .executeTakeFirst();
    if (!fb) {
      res.status(404).json({ error: { code: "not_found", message: "No ticket for that thread." } });
      return;
    }
    await meta
      .updateTable("feedback")
      .set({
        status: "resolved" as never,
        admin_notes: sql`coalesce(admin_notes, '') || ${`\n[closed via Discord button by ${parsed.data.by ?? "user"}]`}`,
        updated_at: new Date(),
      })
      .where("id", "=", fb.id)
      .execute();
    res.json({ id: fb.id, status: "resolved" });
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
    if (parsed.data.triage) {
      const t = parsed.data.triage;
      patch.triage_priority = t.priority;
      patch.triage_valid = t.valid;
      patch.triage_viable = t.viable;
      patch.triage_summary = t.summary;
      patch.triage_action = t.action;
      patch.triage_model = t.model ?? null;
      patch.triaged_at = new Date();
    }
    const row = await meta
      .updateTable("feedback")
      .set(patch)
      .where("id", "=", req.params.id)
      .returning(["id", "status", "admin_notes", "updated_at", "user_id", "org_id", "message", "context", "origin", "origin_ref"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "Feedback not found." } });
      return;
    }

    // Optionally close the loop with the reporter — "we looked at this / it's
    // fixed". Best-effort: a failed notification must not fail the triage update.
    let notified = false;
    let emailed = false;
    // Record our reply on the item itself so it shows in the reporter's in-app
    // thread (/me/feedback) — the notification channels are just the ping.
    if (parsed.data.notify_reporter && parsed.data.reply_message?.trim()) {
      const teamEntry = { at: new Date().toISOString(), from: "Cobblr", text: parsed.data.reply_message.trim(), role: "team" as const };
      await meta
        .updateTable("feedback")
        .set({ followups: sql`coalesce(followups, '[]'::jsonb) || ${JSON.stringify([teamEntry])}::jsonb` })
        .where("id", "=", row.id)
        .execute();
    }
    // A discord-origin ticket has no platform user — its reply goes back into
    // the Discord thread via the support bot (the API never touches Discord).
    if (parsed.data.notify_reporter && row.origin === "discord") {
      const ref = (row.origin_ref ?? null) as { thread_id?: string } | null;
      if (ref?.thread_id) {
        const defaultMsg =
          parsed.data.status === "resolved"
            ? "Fixed — this is live now. 🎉"
            : parsed.data.status === "wontfix"
              ? "We reviewed this — thanks for flagging it."
              : "We're looking into this.";
        // Prefer the actual reply / what-we-did over the generic line.
        const did = parsed.data.reply_message?.trim() || parsed.data.public_summary?.trim();
        pokeDiscordResolved({
          thread_id: ref.thread_id,
          text: parsed.data.status === "resolved" && did ? `Fixed — this is live now. 🎉\n\n${did}` : did || defaultMsg,
        });
        notified = true;
      }
    }
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
          const isResolved = parsed.data.status === "resolved";
          const reply = parsed.data.reply_message?.trim();
          const defaultMsg = isResolved
            ? "The issue you reported has been fixed — it's live now."
            : parsed.data.status === "wontfix"
              ? "We reviewed your feedback — thanks for flagging it."
              : "We're looking into the feedback you sent.";
          // The reporter — for the greeting + the email address.
          const u = await meta
            .selectFrom("users")
            .select(["email", "display_name"])
            .where("id", "=", row.user_id)
            .executeTakeFirst();
          const hi = u?.display_name ? `Hi ${u.display_name},` : "Hi,";
          // Lead the bell + DM with the reporter's own words ("You reported: …")
          // then the fix — same shape as the email, so the message has context
          // instead of being a wall of fix text. A shorter quote than the email's
          // (a notification should stay scannable).
          const reportRaw = (row.message ?? "").trim();
          const reportQuote = reportRaw.length > 240 ? `${reportRaw.slice(0, 240)}…` : reportRaw;
          // Markdown blockquote — Discord renders `>` as a quoted block (a vertical
          // bar), and it still reads as a quote in the plain-text bell. Each line
          // is prefixed so a multi-line report stays inside the quote.
          const bq = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
          const reported = reportRaw ? `You reported:\n${bq(reportQuote)}` : "";
          const useContext = isResolved && !!reply && !!reported;
          // in-app bell: context + fix, NO greeting (a "Hi the author," is too much there).
          const message = useContext ? `${reported}\n\n${reply}` : (reply || defaultMsg);
          // Discord DM: the same, WITH the greeting (the more formal channel).
          const discordMessage = useContext ? `${hi}\n\n${reported}\n\n${reply}` : undefined;
          // Email both ways now that feedback is a conversation: "your request is
          // live" on resolve, and "we replied / have a question" on an OPEN item
          // when there's an explicit reply_message (so a clarifying question
          // actually reaches the reporter — not just the in-app bell). The latter
          // links them to their thread to answer. notifyAccount also honors the
          // matrix per channel + DMs them if Discord is verified.
          let email: { subject: string; text: string; html?: string; replyTo?: string } | undefined;
          if (hasAuthEmailSender() && u?.email) {
            const sentUs = `You'd sent us:\n  "${(row.message ?? "").slice(0, 500)}"`;
            // Reply-by-email when wired (a tokenized Reply-To routes replies
            // back inbound); otherwise be explicit that email replies aren't
            // seen and point to the in-app thread.
            const replyAddr = feedbackReplyAddress(row.id);
            const feedbackUrl = absoluteAppUrl("/me/feedback");
            const replyHere = replyAddr
              ? `Just reply to this email and it'll land on your report — or use your feedback page:\n  ${feedbackUrl}`
              : `To reply, use your feedback page — replies to this email aren't monitored yet:\n  ${feedbackUrl}`;
            if (isResolved) {
              // Lead with the reporter's own words, then what we did — a
              // "reported → fixed" record. (Body is the raw fix, not the
              // context-wrapped `message`, or "You reported" would double up.)
              const head = `You reported:\n${bq(reportRaw.slice(0, 600))}`;
              email = {
                subject: "Your Cobblr request is live",
                text: `${hi}\n\n${head}\n\n${reply || defaultMsg}\n\nStill off? ${replyHere}\n\nThanks for helping make Cobblr better.\n— The Cobblr team`,
                html: feedbackEmailHtml({
                  greeting: hi,
                  reportText: reportRaw.slice(0, 600),
                  bodyParas: [reply || defaultMsg],
                  ctaUrl: feedbackUrl,
                  ctaLabel: "View your feedback",
                  footerNote: replyAddr ? "Still off? Just reply to this email and it'll land on your report." : "Still off? Reply on your feedback page (email replies aren't monitored yet).",
                }),
                replyTo: replyAddr ?? undefined,
              };
            } else if (reply) {
              email = {
                subject: "We replied to your Cobblr feedback",
                text: `${hi}\n\n${reply}\n\n${replyHere}\n\n${sentUs}\n\n— The Cobblr team`,
                html: feedbackEmailHtml({
                  greeting: hi,
                  reportText: (row.message ?? "").slice(0, 500),
                  bodyParas: [reply],
                  ctaUrl: feedbackUrl,
                  ctaLabel: "Open your feedback",
                  footerNote: replyAddr ? "Reply to this email to answer, or use your feedback page." : "Reply on your feedback page — email replies aren't monitored yet.",
                }),
                replyTo: replyAddr ?? undefined,
              };
            }
          }
          const { deliveredVia } = await notifyAccount({
            userId: row.user_id,
            representativeOrgId: orgId,
            notificationType: "platform.feedback.replied",
            message,
            discordMessage,
            // Land them on their feedback thread to read our reply + respond.
            link_url: "/me/feedback",
            email,
          });
          notified = deliveredVia.length > 0 || notified;
          emailed = deliveredVia.includes("email");
        }
      } catch (err) {
        console.error("[super-admin] feedback-reply notification failed:", err);
      }
    }

    // Announce a resolution to Discord (toggleable; off by default of the
    // category if an admin silences it — e.g. to avoid doubling a commit feed).
    if (parsed.data.status === "resolved") {
      const ctx = (row.context ?? {}) as { route?: string };
      const reported = (row.message ?? "").slice(0, 1200);
      // Prefer an explicit third-person changelog note; otherwise fall back to
      // the reply we sent the requester so the public card ALWAYS says what we
      // did — never just re-echoes the complaint with a green check.
      const fixed = parsed.data.public_summary?.trim() || parsed.data.reply_message?.trim();
      const cardFields = await reporterCardFields({ userId: row.user_id, orgId: row.org_id, route: ctx.route });
      void announce("feedback.resolved", {
        title: "✅ Feedback resolved",
        // When we have a "what we did" line, the post reads as a public changelog
        // entry (reported → fixed); otherwise just the original report.
        body: fixed ? `**Reported:** ${reported}\n\n**Fixed:** ${fixed.slice(0, 2400)}` : reported,
        color: 0x2e7d32,
        fields: cardFields,
      });
    }

    res.json({ ...row, notified, emailed });
  } catch (err) {
    next(err);
  }
});

// POST /super-admin/feedback/batch-resolve — close several items at once with
// ONE reporter-facing email/notification per reporter. Each item still resolves
// individually (its own status + its own public changelog entry); the reporter
// just isn't pinged N times. This is the proper form of "fix these three and
// email the person once" — vs. faking it with a single "carrier" item, which
// mis-quoted the original report and doubled the greeting.
//
// `reply_message` is the ONE combined body — do NOT include a greeting; the
// email prepends "Hi <name>,". The public changelog only re-posts on a genuine
// resolve TRANSITION, so re-running this on already-resolved items (e.g. to
// re-send a corrected email) emails without duplicating changelog entries.
const BatchResolveBody = z.object({
  status: z.enum(["resolved", "wontfix"]).optional().default("resolved"),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        // Third-person changelog line for the PUBLIC Discord post.
        public_summary: z.string().max(2000).optional(),
        // Reporter-facing "we fixed it by …" line for THIS item, shown next to
        // its quoted report in the combined email. Falls back to public_summary.
        fix_note: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(50),
  // Optional intro/summary shown once at the top (above the per-item breakdown).
  reply_message: z.string().max(4000).optional(),
  notify_reporter: z.boolean().optional(),
});

superAdminRouter.post("/feedback/batch-resolve", async (req, res, next) => {
  try {
    const parsed = BatchResolveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad batch", details: parsed.error.issues } });
      return;
    }
    const { status, items, reply_message, notify_reporter } = parsed.data;
    const order = items.map((i) => i.id);
    const summaryById = new Map(items.map((i) => [i.id, i.public_summary]));
    const fixNoteById = new Map(items.map((i) => [i.id, i.fix_note]));

    const rows = await meta
      .selectFrom("feedback")
      .select(["id", "status", "user_id", "org_id", "message", "context", "origin", "origin_ref"])
      .where("id", "in", order)
      .execute();
    const found = new Set(rows.map((r) => r.id));
    if (rows.length === 0) {
      res.status(404).json({ error: { code: "not_found", message: "No matching feedback." } });
      return;
    }

    // 1) Resolve each item; post its OWN public changelog only on a fresh
    //    resolved transition (so a re-send doesn't double-post).
    await meta.updateTable("feedback").set({ status, updated_at: new Date() }).where("id", "in", [...found]).execute();
    for (const row of rows) {
      const isResolved = status === "resolved";
      const freshlyResolved = isResolved && row.status !== "resolved";
      if (notify_reporter && row.origin === "discord") {
        const ref = (row.origin_ref ?? {}) as { thread_id?: string };
        if (ref.thread_id) {
          // Send what we ACTUALLY did (the per-item fix / reply), not a generic
          // line — mirrors the email's per-item block + the single-resolve DM.
          // The reporter's report is already in the thread, so don't re-quote it.
          const did = (fixNoteById.get(row.id) || summaryById.get(row.id) || reply_message || "").trim();
          const dmsg = isResolved
            ? did
              ? `Fixed — this is live now. 🎉\n\n${did}`
              : "Fixed — this is live now. 🎉"
            : did || "We reviewed your feedback — thanks for flagging it.";
          void pokeDiscordResolved({ thread_id: ref.thread_id, text: dmsg });
        }
      }
      // Record our per-item reply on the thread so it shows in /me/feedback.
      if (notify_reporter) {
        const teamText = (fixNoteById.get(row.id) || reply_message || "").trim();
        if (teamText) {
          const teamEntry = { at: new Date().toISOString(), from: "Cobblr", text: teamText, role: "team" as const };
          await meta
            .updateTable("feedback")
            .set({ followups: sql`coalesce(followups, '[]'::jsonb) || ${JSON.stringify([teamEntry])}::jsonb` })
            .where("id", "=", row.id)
            .execute();
        }
      }
      if (freshlyResolved) {
        const ctx = (row.context ?? {}) as { route?: string };
        const fixed = (summaryById.get(row.id) || reply_message || "").trim();
        const reported = (row.message ?? "").slice(0, 1200);
        const cardFields = await reporterCardFields({ userId: row.user_id, orgId: row.org_id, route: ctx.route });
        void announce("feedback.resolved", {
          title: "✅ Feedback resolved",
          body: fixed ? `**Reported:** ${reported}\n\n**Fixed:** ${fixed.slice(0, 2400)}` : reported,
          color: 0x2e7d32,
          fields: cardFields,
        });
      }
    }

    // 2) ONE combined reporter notification per distinct reporter.
    const notifiedReporters: string[] = [];
    if (notify_reporter && reply_message?.trim()) {
      const byUser = new Map<string, typeof rows>();
      for (const row of rows) {
        if (!row.user_id) continue;
        const list = byUser.get(row.user_id) ?? [];
        list.push(row);
        byUser.set(row.user_id, list);
      }
      for (const [userId, userRowsRaw] of byUser) {
        const userRows = [...userRowsRaw].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        let orgId = userRows.find((r) => r.org_id)?.org_id ?? null;
        if (!orgId) {
          const m = await meta
            .selectFrom("org_memberships")
            .select("org_id")
            .where("user_id", "=", userId)
            .orderBy("joined_at", "asc")
            .executeTakeFirst();
          orgId = m?.org_id ?? null;
        }
        if (!orgId) continue;
        let email: { subject: string; text: string; html?: string } | undefined;
        if (status === "resolved") {
          const u = await meta.selectFrom("users").select(["display_name"]).where("id", "=", userId).executeTakeFirst();
          const hi = u?.display_name ? `Hi ${u.display_name},` : "Hi,";
          const plural = userRows.length > 1;
          // Per-item "you reported X → we fixed it by Y" blocks, after the
          // optional intro/summary. Each pairs the reporter's own words with the
          // specific fix, so the email is both a scannable summary AND a record.
          const bq = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
          const blocks = userRows
            .map((r) => {
              const reported = (r.message ?? "").trim().slice(0, 600);
              const fix = (fixNoteById.get(r.id) || summaryById.get(r.id) || "").trim();
              const head = `You reported:\n${bq(reported)}`;
              return fix ? `${head}\n\n${fix}` : head;
            })
            .join("\n\n");
          const intro = reply_message.trim();
          // HTML: one styled quote+fix block per item (escaped), mirroring the text.
          const htmlBlocks = userRows
            .map((r) => {
              const reported = (r.message ?? "").trim().slice(0, 600);
              const fix = (fixNoteById.get(r.id) || summaryById.get(r.id) || "").trim();
              const q = `<p style="margin:0 0 4px;color:#6b7280;font-size:13px;">You reported:</p><blockquote style="margin:0 0 10px;padding:10px 16px;border-left:3px solid #c7b8a6;background:#f6f3ee;color:#374151;border-radius:0 6px 6px 0;white-space:pre-wrap;">${escHtml(reported)}</blockquote>`;
              const f = fix ? `<p style="margin:0 0 18px;">${escHtml(fix).replace(/\n/g, "<br>")}</p>` : "";
              return q + f;
            })
            .join("");
          email = {
            subject: plural ? "Your Cobblr requests are live" : "Your Cobblr request is live",
            text:
              `${hi}\n\n` +
              (intro ? `${intro}\n\n` : "") +
              `${blocks}\n\n` +
              `Thanks for helping make Cobblr better.\n— The Cobblr team`,
            html: `<!DOCTYPE html><html><body style="margin:0;background:#f3f4f6;padding:24px 12px;"><div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;font-size:15px;line-height:1.5;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;"><p style="margin:0 0 16px;">${escHtml(hi)}</p>${intro ? `<p style="margin:0 0 16px;">${escHtml(intro).replace(/\n/g, "<br>")}</p>` : ""}${htmlBlocks}<p style="margin:14px 0 0;"><a href="${escHtml(absoluteAppUrl("/me/feedback"))}" style="display:inline-block;background:#8a6f47;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;">View your feedback</a></p><p style="margin:18px 0 0;color:#9ca3af;font-size:12px;">— The Cobblr team</p></div></body></html>`,
          };
        }
        const { deliveredVia } = await notifyAccount({
          userId,
          representativeOrgId: orgId,
          notificationType: "platform.feedback.replied",
          message: reply_message.trim(),
          link_url: "/me/feedback",
          email,
        });
        if (deliveredVia.length) notifiedReporters.push(userId);
      }
    }

    res.json({
      resolved: [...found],
      missing: order.filter((id) => !found.has(id)),
      notified_reporters: notifiedReporters.length,
    });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/feedback/:id/context — the SITUATIONAL picture the AI triage
// analyzer needs to judge an item well: which workspace it came from, what the
// page the user was on actually IS (its entity kind + that table's fields and
// their current choices), and what the workspace is shaped like (installed
// bundles + enabled modules). Without this the model sees only the raw message +
// a route string and reads concrete requests as vague — e.g. "incorporate the
// numbers for Weight" looks empty until you can see there's a yarn `Weight`
// field with choices. Everything is org-scoped meta, so no tenant connection.
//
// Allowed by the feedback:triage scope (GET /super-admin/feedback/*), so the
// host-side analyzer reads it with the same narrow token it already holds.

// Default entity kind for a module's primary (is_default) instance. Named
// instances use `<instance_name>:item` (mirrors core-scan's matchmaker).
const DEFAULT_ENTITY_KIND: Record<string, string> = {
  inventory: "inventory:part",
  assets: "assets:asset",
  machines: "machines:machine",
};

/** Best-effort: resolve the page route → the entity kind whose fields the user
 *  was looking at. Handles `/instances/<name>/…` (named/default instances) and
 *  `/<module>` module pages. Returns null when nothing matches. */
function entityKindForRoute(
  route: string,
  instances: Array<{ module_name: string; instance_name: string; is_default: boolean }>,
): string | null {
  const m = route.match(/\/instances\/([^/]+)/);
  if (m) {
    const inst = instances.find((i) => i.instance_name === m[1]);
    if (inst) {
      return inst.is_default
        ? DEFAULT_ENTITY_KIND[inst.module_name] ?? `${inst.module_name}:item`
        : `${inst.instance_name}:item`;
    }
    return `${m[1]}:item`; // instance gone but the noun is still a signal
  }
  // module page: first path segment that names an enabled module/instance.
  const segs = route.split("/").filter(Boolean);
  for (const s of segs) {
    const inst = instances.find((i) => i.module_name === s && i.is_default);
    if (inst) return DEFAULT_ENTITY_KIND[s] ?? `${s}:item`;
    if (DEFAULT_ENTITY_KIND[s]) return DEFAULT_ENTITY_KIND[s];
  }
  return null;
}

superAdminRouter.get("/feedback/:id/context", async (req, res, next) => {
  try {
    const fb = await meta
      .selectFrom("feedback")
      .select(["id", "org_id", "context"])
      .where("id", "=", req.params.id)
      .executeTakeFirst();
    if (!fb) {
      res.status(404).json({ error: { code: "not_found", message: "Feedback not found." } });
      return;
    }
    if (!fb.org_id) {
      res.json({ workspace: null });
      return;
    }
    const orgId = fb.org_id;
    const route = ((fb.context ?? {}) as { route?: string }).route ?? "";

    const [org, bundles, modules, instances] = await Promise.all([
      meta.selectFrom("orgs").select(["slug", "name"]).where("id", "=", orgId).executeTakeFirst(),
      meta
        .selectFrom("bundles")
        .select(["name"])
        .where("org_id", "=", orgId)
        .where("install_status", "=", "active")
        .execute(),
      meta.selectFrom("org_modules").select(["module_name"]).where("org_id", "=", orgId).execute(),
      meta
        .selectFrom("workspace_module_instances")
        .select(["module_name", "instance_name", "display_name", "is_default"])
        .where("org_id", "=", orgId)
        .execute(),
    ]);

    const kind = entityKindForRoute(route, instances);
    const pageFields = kind
      ? await meta
          .selectFrom("module_field_defs")
          .select(["name", "display_label", "type", "choices"])
          .where("org_id", "=", orgId)
          .where("entity_kind", "=", kind)
          .where("type", "!=", "computed")
          .orderBy("position")
          .execute()
      : [];

    res.json({
      workspace: org ? { slug: org.slug, name: org.name } : null,
      page: { route, entity_kind: kind },
      page_fields: pageFields.map((f) => ({
        name: f.name,
        label: f.display_label,
        type: f.type,
        ...(f.choices && f.choices.length ? { choices: f.choices } : {}),
      })),
      installed_bundles: bundles.map((b) => b.name),
      enabled_modules: modules.map((m) => m.module_name).filter((m) => !m.startsWith("core-")),
      instances: instances.map((i) => ({
        module: i.module_name,
        instance: i.is_default ? null : i.instance_name,
        label: i.display_name,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/feedback/:id/attachments/:fileId/raw — stream a reporter's
// screenshot. The bytes live in the REPORTER's workspace core-files; we read
// them server-side under the feedback's own org_id (so the endpoint can't be
// pointed at another org's file — a non-matching id just reads null). Only
// file_ids actually listed on the feedback row are served. Images only.
superAdminRouter.get("/feedback/:id/attachments/:fileId/raw", async (req, res, next) => {
  try {
    const fb = await meta
      .selectFrom("feedback")
      .select(["org_id", "attachments"])
      .where("id", "=", req.params.id)
      .executeTakeFirst();
    if (!fb || !fb.org_id) {
      res.status(404).json({ error: { code: "not_found", message: "no such attachment" } });
      return;
    }
    const atts = (fb.attachments ?? []) as Array<{ file_id: string }>;
    if (!atts.some((a) => a.file_id === req.params.fileId)) {
      res.status(404).json({ error: { code: "not_found", message: "no such attachment" } });
      return;
    }
    const variant = req.query.variant === "thumb" || req.query.variant === "medium" ? req.query.variant : "medium";
    const file =
      (await platform().files.read(fb.org_id, req.params.fileId, variant)) ??
      (await platform().files.read(fb.org_id, req.params.fileId, "original"));
    if (!file || !file.mimeType.startsWith("image/")) {
      res.status(404).json({ error: { code: "not_found", message: "no such image" } });
      return;
    }
    res.type(file.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(file.bytes));
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

// POST /super-admin/announce — the "Post an update" composer. Fires a curated
// announcement (bundle release / feature note) into its category's channel.
// Only `composable` categories may be posted this way.
const ComposeAnnounce = z.object({
  category: z.string().min(1).max(80),
  title: z.string().min(1).max(240),
  body: z.string().max(3500).optional(),
});

superAdminRouter.post("/announce", async (req, res, next) => {
  try {
    const parsed = ComposeAnnounce.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad announcement", details: parsed.error.issues } });
      return;
    }
    if (!isComposable(parsed.data.category)) {
      res.status(400).json({ error: { code: "not_composable", message: "That category can't be posted from the composer." } });
      return;
    }
    const color = parsed.data.category === "bundle.release" ? 0x6d28d9 : 0x2563eb;
    const delivered = await announce(parsed.data.category, {
      title: parsed.data.title.trim(),
      body: parsed.data.body?.trim() || undefined,
      color,
    });
    // Don't claim success when Discord rejected the post (bad/expired webhook,
    // etc.) — the old code always returned ok:true and the failure was invisible.
    if (!delivered) {
      res.status(502).json({
        error: {
          code: "announce_delivery_failed",
          message: "The announcement could not be delivered to Discord — check the channel webhook in Settings.",
        },
      });
      return;
    }
    res.json({ ok: true, delivered: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────── operator impersonation ("View as") ─────────────────────
// Time-boxed, audited, read-only-by-default grant to render a workspace AS one of
// its members for support. The operator's identity is never replaced (it rides
// the token's `sub`). See docs/modules/operator-impersonation.md.

const StartImpersonation = z.object({
  org_id: z.string().uuid(),
  target_user_id: z.string().uuid(),
  reason: z.string().min(1).max(500),
  ttl_min: z.number().int().min(1).max(60).optional(),
});

// POST /super-admin/impersonations — mint a session + token (read-only).
superAdminRouter.post("/impersonations", async (req, res, next) => {
  try {
    const parsed = StartImpersonation.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request", details: parsed.error.issues } });
      return;
    }
    const { org_id, target_user_id, reason } = parsed.data;
    const ttlMin = parsed.data.ttl_min ?? 30;
    const operatorId = req.session!.id;

    const target = await meta.selectFrom("users").select(["email", "display_name"]).where("id", "=", target_user_id).executeTakeFirst();
    if (!target) {
      res.status(404).json({ error: { code: "user_not_found", message: "Target user not found." } });
      return;
    }
    // Platform admins can't be impersonated (no tier-internal impersonation).
    if (isPlatformAdmin(target.email)) {
      res.status(403).json({ error: { code: "target_is_admin", message: "Platform admins can't be impersonated." } });
      return;
    }
    const membership = await meta
      .selectFrom("org_memberships")
      .select(["role"])
      .where("user_id", "=", target_user_id)
      .where("org_id", "=", org_id)
      .executeTakeFirst();
    if (!membership) {
      res.status(404).json({ error: { code: "not_a_member", message: "That user is not a member of that workspace." } });
      return;
    }
    const org = await meta.selectFrom("orgs").select(["slug", "name"]).where("id", "=", org_id).executeTakeFirst();
    if (!org) {
      res.status(404).json({ error: { code: "org_not_found", message: "Workspace not found." } });
      return;
    }

    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);
    const row = await meta
      .insertInto("impersonation_sessions")
      .values({ operator_user_id: operatorId, target_user_id, org_id, reason, expires_at: expiresAt })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const token = await signImpersonation(operatorId, target_user_id, org_id, row.id, ttlMin * 60);

    // Transparent by default: a workspace-visible trace in the org's activity feed.
    await activityLog({
      orgId: org_id,
      userId: operatorId,
      action: "impersonation_started",
      ref: { module: null, entityType: "org", entityId: org_id },
      diff: { reason, target: target.display_name || target.email },
    });

    res.status(201).json({
      session_id: row.id,
      token,
      expires_at: expiresAt.toISOString(),
      mode: "read",
      target: { id: target_user_id, name: target.display_name || target.email, role: membership.role },
      workspace: { id: org_id, slug: org.slug, name: org.name },
    });
  } catch (err) {
    next(err);
  }
});

const PatchImpersonation = z.object({
  ended: z.boolean().optional(),
  mode: z.enum(["read", "write"]).optional(),
});

// PATCH /super-admin/impersonations/:id — end the session, and/or arm/disarm write
// mode (the deliberate, separately-audited write escalation).
superAdminRouter.patch("/impersonations/:id", async (req, res, next) => {
  try {
    const parsed = PatchImpersonation.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request", details: parsed.error.issues } });
      return;
    }
    const sess = await meta
      .selectFrom("impersonation_sessions")
      .select(["id", "operator_user_id", "org_id", "mode", "write_enabled_at", "ended_at"])
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!sess) {
      res.status(404).json({ error: { code: "session_not_found", message: "Impersonation session not found." } });
      return;
    }
    // Only the operator who started it can change it.
    if (sess.operator_user_id !== req.session!.id) {
      res.status(403).json({ error: { code: "not_your_session", message: "Not your impersonation session." } });
      return;
    }
    const updates: { ended_at?: Date; mode?: "read" | "write"; write_enabled_at?: Date } = {};
    if (parsed.data.ended) updates.ended_at = new Date();
    if (parsed.data.mode) {
      updates.mode = parsed.data.mode;
      if (parsed.data.mode === "write" && !sess.write_enabled_at) updates.write_enabled_at = new Date();
    }
    if (Object.keys(updates).length > 0) {
      await meta.updateTable("impersonation_sessions").set(updates).where("id", "=", sess.id).execute();
    }
    // Arming write mode is its own audited event in the workspace's feed.
    if (parsed.data.mode === "write" && sess.mode !== "write") {
      await activityLog({
        orgId: sess.org_id,
        userId: sess.operator_user_id,
        action: "impersonation_write_enabled",
        ref: { module: null, entityType: "org", entityId: sess.org_id },
      });
    }
    res.json({ ok: true, ended: !!parsed.data.ended, mode: parsed.data.mode ?? sess.mode });
  } catch (err) {
    next(err);
  }
});

// GET /super-admin/impersonations — the append-only "Impersonation log".
superAdminRouter.get("/impersonations", async (_req, res, next) => {
  try {
    const items = await meta
      .selectFrom("impersonation_sessions as s")
      .leftJoin("users as op", "op.id", "s.operator_user_id")
      .leftJoin("users as tu", "tu.id", "s.target_user_id")
      .leftJoin("orgs as o", "o.id", "s.org_id")
      .select([
        "s.id",
        "s.reason",
        "s.mode",
        "s.request_count",
        "s.created_at",
        "s.expires_at",
        "s.write_enabled_at",
        "s.ended_at",
        "op.email as operator_email",
        "op.display_name as operator_name",
        "tu.email as target_email",
        "tu.display_name as target_name",
        "o.slug as workspace_slug",
        "o.name as workspace_name",
      ])
      .orderBy("s.created_at", "desc")
      .limit(100)
      .execute();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /super-admin/notices — advise the members of affected workspace(s) (and/or
// explicit users) of a breaking change that affects THEM — e.g. a workspace web
// address change. Unlike /announce (a public Discord broadcast), this is a
// TARGETED, per-recipient notice that rides the locked auth-email path (always
// emails, like a security notice — not subject to the opt-out matrix) PLUS drops
// an in-app bell. Reusable: any "we changed something that affects your access"
// event. event_type platform.account.notice (Tier 1, see notification-catalog).
const NoticeBody = z.object({
  org_ids: z.array(z.string().uuid()).optional(),
  user_ids: z.array(z.string().uuid()).optional(),
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
  link_url: z.string().max(500).optional(),
});

superAdminRouter.post("/notices", async (req, res, next) => {
  try {
    const parsed = NoticeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad notice", details: parsed.error.issues } });
      return;
    }
    const { org_ids = [], user_ids = [], subject, message, link_url } = parsed.data;
    // Recipients = members of org_ids ∪ explicit user_ids, deduped. Keep one
    // representative org per user for the in-app row's org_id.
    const recipientOrg = new Map<string, string>();
    if (org_ids.length) {
      const members = await meta
        .selectFrom("org_memberships")
        .select(["user_id", "org_id"])
        .where("org_id", "in", org_ids)
        .execute();
      for (const m of members) if (!recipientOrg.has(m.user_id)) recipientOrg.set(m.user_id, m.org_id);
    }
    for (const uid of user_ids) {
      if (recipientOrg.has(uid)) continue;
      const m = await meta
        .selectFrom("org_memberships")
        .select("org_id")
        .where("user_id", "=", uid)
        .orderBy("joined_at", "asc")
        .executeTakeFirst();
      if (m?.org_id) recipientOrg.set(uid, m.org_id);
    }
    if (recipientOrg.size === 0) {
      res.status(404).json({ error: { code: "no_recipients", message: "No matching recipients." } });
      return;
    }

    const text = link_url ? `${message}\n\n${link_url}` : message;
    const userIds = [...recipientOrg.keys()];
    const users = await meta.selectFrom("users").select(["id", "email"]).where("id", "in", userIds).execute();
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    let emailed = 0;
    for (const [uid, orgId] of recipientOrg) {
      await meta
        .insertInto("notifications")
        .values({
          org_id: orgId,
          user_id: uid,
          event_type: "platform.account.notice",
          module_name: null,
          entity_type: null,
          entity_id: null,
          message,
          link_url: link_url ?? null,
          priority: "high",
          delivered_via: ["in_app"],
        })
        .execute();
      const to = emailById.get(uid);
      if (to && hasAuthEmailSender()) {
        const ok = await sendAuthEmail({ to, subject, text, kind: "notification" });
        if (ok) emailed++;
      }
    }
    res.json({ recipients: recipientOrg.size, emailed });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────── AI prompt-eval — scan matchmaker ────────────────────
// The decoupled eval seam for the scan matchmaker (docs/operations/
// ai-prompt-eval-harness.md). Runs `runMatchmaker` on an EXPLICIT item + menu —
// no inbox row, no instance setup, no DB writes — so the e2e harness can score a
// prompt against fixtures without standing up a workspace per menu. The model
// invoke runs under a real workspace's AI config (the `org` slug if given, else
// the caller's first workspace) since `platform().ai.invoke` is org-scoped.
//
// Runnable with a narrow `scan:eval` capability token (see auth/scopes.ts), so
// the harness needn't carry a full super-admin token.

const ScanEvalMenuField = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  help: z.string().optional(),
  choices: z.array(z.string()).optional(),
});

// Fixtures route by {module, instance} + noun; `kind` is only used to label the
// returned candidate, so it's optional here and derived when omitted.
const ScanEvalMenuEntry = z.object({
  module: z.string().min(1),
  instance: z.string().nullable().default(null),
  kind: z.string().optional(),
  noun: z.string(),
  label: z.string(),
  fields: z.array(ScanEvalMenuField).default([]),
});

const ScanEvalItem = z.object({
  name: z.string(),
  manufacturer: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  entityType: z.enum(["asset", "part"]).nullable().optional(),
  barcode: z.string().nullable().optional(),
});

// Surface-switched: matchmaker (item+menu → candidates), barcode-identify
// (upc+titles → identity), photo-identify (image → identity). Each runs the
// surface's core function on explicit input — no DB writes.
const ScanEvalBody = z.discriminatedUnion("surface", [
  z.object({
    surface: z.literal("matchmaker"),
    item: ScanEvalItem,
    menu: z.array(ScanEvalMenuEntry).min(1),
    org: z.string().optional(),
  }),
  z.object({
    surface: z.literal("barcode-identify"),
    upc: z.string().min(1).max(64),
    // The DDG result titles the model identifies from — fixtured so the eval is
    // deterministic-input (avoids live-search variance; only model variance).
    // An EMPTY array is allowed: it exercises the no-titles path (identify from
    // the UPC alone, conservatively), which on a shared public IP is the common
    // real case since DDG can't search a bare UPC.
    titles: z.array(z.string().max(400)).max(40),
    org: z.string().optional(),
  }),
  z.object({
    surface: z.literal("photo-identify"),
    image_b64: z.string().min(1),
    image_media_type: z.string().min(1).max(80),
    org: z.string().optional(),
  }),
]);

superAdminRouter.post("/scan-eval", async (req, res, next) => {
  try {
    const parsed = ScanEvalBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad scan-eval request", details: parsed.error.issues } });
      return;
    }
    const userId = req.session?.id;
    if (!userId) {
      res.status(401).json({ error: { code: "unauthenticated", message: "No session." } });
      return;
    }

    // Resolve the org whose AI config backs the model call (shared by surfaces).
    let orgId: string | null = null;
    if (parsed.data.org) {
      const o = await meta.selectFrom("orgs").select("id").where("slug", "=", parsed.data.org).executeTakeFirst();
      if (!o) {
        res.status(404).json({ error: { code: "org_not_found", message: `No workspace with slug '${parsed.data.org}'.` } });
        return;
      }
      orgId = o.id;
    } else {
      const m = await meta
        .selectFrom("org_memberships")
        .select("org_id")
        .where("user_id", "=", userId)
        .orderBy("joined_at", "asc")
        .executeTakeFirst();
      orgId = m?.org_id ?? null;
    }
    if (!orgId) {
      res.status(409).json({ error: { code: "no_workspace", message: "Caller has no workspace; pass `org` to choose one for the AI invoke." } });
      return;
    }

    if (parsed.data.surface === "matchmaker") {
      const menu: ScanMenuEntry[] = parsed.data.menu.map((m) => ({
        module: m.module,
        instance: m.instance,
        kind: m.kind ?? (m.instance ? `${m.instance}:item` : `${m.module}:item`),
        noun: m.noun,
        label: m.label,
        fields: m.fields,
      }));
      const item: PerceivedItem = {
        name: parsed.data.item.name,
        manufacturer: parsed.data.item.manufacturer ?? null,
        category: parsed.data.item.category ?? null,
        description: parsed.data.item.description ?? null,
        entityType: parsed.data.item.entityType ?? null,
        barcode: parsed.data.item.barcode ?? null,
      };
      res.json({ candidates: await runMatchmaker(orgId, item, menu) });
      return;
    }

    if (parsed.data.surface === "barcode-identify") {
      res.json({ identity: await llmIdentify(orgId, parsed.data.upc, parsed.data.titles) });
      return;
    }

    // photo-identify
    res.json({ identity: await identifyImage(orgId, parsed.data.image_b64, parsed.data.image_media_type) });
  } catch (err) {
    next(err);
  }
});

// ─────────────────── scan eval cases — captured from real triage ──────────────
// P2 of the eval harness: platform admins flag a corrected scan commit as a
// golden case (core_scan_eval_cases, per-tenant). Aggregate them across
// workspaces here (same cross-tenant raw-SQL pattern as /ai-activity), so the
// e2e import script can pull + materialise them into e2e/fixtures/scan-eval/.
interface ScanEvalCaseRow {
  id: string;
  inbox_item_id: string | null;
  surface: string;
  perceived_input: unknown;
  scan_menu: unknown;
  candidates: unknown;
  expected: unknown;
  note: string | null;
  created_by_user_id: string | null;
  created_at: Date;
}

// GET /super-admin/scan-eval-cases — every captured case across all workspaces.
superAdminRouter.get("/scan-eval-cases", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? "500"), 10) || 500, 1000);
    const orgs = await meta.selectFrom("orgs").select(["id", "name", "slug"]).execute();
    const rows: Array<ScanEvalCaseRow & { org_id: string; org_name: string; org_slug: string }> = [];
    for (const org of orgs) {
      try {
        const tdb = await getTenantDb(org.id);
        const r = await sql<ScanEvalCaseRow>`
          select id, inbox_item_id, surface, perceived_input, scan_menu, candidates,
                 expected, note, created_by_user_id, created_at
          from core_scan_eval_cases order by created_at desc limit ${limit}`.execute(tdb);
        for (const row of r.rows) rows.push({ ...row, org_id: org.id, org_name: org.name, org_slug: org.slug });
      } catch {
        // Tenant DB without core_scan_eval_cases (module never enabled) — skip it.
      }
    }
    rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    res.json({ items: rows.slice(0, limit) });
  } catch (err) {
    next(err);
  }
});

// DELETE /super-admin/scan-eval-cases/:orgId/:id — prune one captured case.
superAdminRouter.delete("/scan-eval-cases/:orgId/:id", async (req, res, next) => {
  try {
    const org = await meta.selectFrom("orgs").select("id").where("id", "=", req.params.orgId!).executeTakeFirst();
    if (!org) {
      res.status(404).json({ error: { code: "not_found", message: "Workspace not found." } });
      return;
    }
    const tdb = await getTenantDb(org.id);
    const r = await sql`delete from core_scan_eval_cases where id = ${req.params.id}`.execute(tdb);
    if (Number(r.numAffectedRows ?? 0) === 0) {
      res.status(404).json({ error: { code: "not_found", message: "Eval case not found." } });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ─────────────────── AI prompt-eval — bundle authoring (surface 4) ────────────
// The decoupled eval seam for the AI bundle builder (core-authoring): describe →
// working bundle. Mirrors the draft-build pipeline (assembleContext → compilePrompt
// → ai.invoke → unwrapBuild → validateBundle) on an EXPLICIT intent, one shot, no
// draft row / no DB writes — so the harness can score the compiled bundle against a
// fixture. `validateBundle` (the kernel's single-truth gate, also used at draft +
// install) IS the structural scorer. Runnable with an `authoring:eval` token.
const AuthoringEvalBody = z.object({
  intent: z.string().min(1).max(4000),
  // refine-bundle (B17): the harness supplies the artifact to revise via
  // base_artifact — same context shape the /drafts/:id/refine route builds
  // from the parent draft. (refine-APP scoring needs the app contract in the
  // harness first — bundle refine only here.)
  task: z.enum(["create-bundle", "customize-template", "design-workspace", "refine-bundle"]).default("create-bundle"),
  selected_kinds: z.array(z.string().max(120)).max(20).optional(),
  base_template_id: z.string().max(120).optional(),
  base_artifact: z.record(z.unknown()).optional(),
  org: z.string().optional(),
});

superAdminRouter.post("/authoring-eval", async (req, res, next) => {
  try {
    const parsed = AuthoringEvalBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad authoring-eval request", details: parsed.error.issues } });
      return;
    }
    const userId = req.session?.id;
    if (!userId) {
      res.status(401).json({ error: { code: "unauthenticated", message: "No session." } });
      return;
    }

    // The org whose catalog (entity kinds/actions) + AI config back the build.
    let orgId: string | null = null;
    if (parsed.data.org) {
      const o = await meta.selectFrom("orgs").select("id").where("slug", "=", parsed.data.org).executeTakeFirst();
      if (!o) {
        res.status(404).json({ error: { code: "org_not_found", message: `No workspace with slug '${parsed.data.org}'.` } });
        return;
      }
      orgId = o.id;
    } else {
      const m = await meta.selectFrom("org_memberships").select("org_id").where("user_id", "=", userId).orderBy("joined_at", "asc").executeTakeFirst();
      orgId = m?.org_id ?? null;
    }
    if (!orgId) {
      res.status(409).json({ error: { code: "no_workspace", message: "Caller has no workspace; pass `org`." } });
      return;
    }

    const ctx = await assembleContext(orgId, parsed.data.selected_kinds, parsed.data.task, parsed.data.base_template_id);
    if (parsed.data.task === "refine-bundle") {
      if (!parsed.data.base_artifact) {
        res.status(400).json({ error: { code: "missing_base_artifact", message: "task refine-bundle requires base_artifact (the bundle to revise)." } });
        return;
      }
      ctx.baseArtifact = parsed.data.base_artifact;
    }
    const prompt = compilePrompt(ctx, parsed.data.intent);
    let text = "";
    try {
      const r = await platform().ai.invoke({
        orgId,
        capability: "chat",
        input: { messages: [{ role: "user", content: prompt }] },
        source: { kind: "core-authoring:eval", id: parsed.data.intent.slice(0, 60) },
        userId,
      });
      const result = r.result as { content?: string; text?: string } | string;
      text = typeof result === "string" ? result : result?.content ?? result?.text ?? "";
    } catch (err) {
      res.json({ interpretation: null, bundle: null, seed: [], validation: { valid: false, preview: null, errors: [{ path: "", code: "ai_error", message: (err as Error).message }] }, warnings: ctx.warnings });
      return;
    }

    const unwrapped = unwrapBuild(parseJsonObject(text));
    const bundle = unwrapped.bundle;
    const validation = bundle && typeof bundle === "object"
      ? await validateBundle(orgId, bundle, { autoEnable: true })
      : { valid: false, preview: null, errors: [{ path: "", code: "not_json", message: "Model output did not unwrap to a bundle object." }] };
    res.json({ interpretation: unwrapped.interpretation, bundle, seed: unwrapped.seed, validation, warnings: ctx.warnings });
  } catch (err) {
    next(err);
  }
});
