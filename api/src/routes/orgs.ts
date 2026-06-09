// /api/v1/orgs/* — org-scoped routes. Composes requireAuth +
// withTenant on every endpoint so handlers can rely on req.tenant.
//
// Milestone 3 ships just /local, which queries the tenant's
// platform_local table — proves end-to-end that:
//   1. The tenant DB exists
//   2. The tenant user can connect to it
//   3. The base-tenant migrations ran
//   4. The auth + routing middleware correctly swaps Kysely instances
//   5. Two different orgs see two different `platform_local`
//      contents (different `created_at` values)

import { Router } from "express";
import { z } from "zod";
import { meta, metaPool } from "../db/meta.js";
import { evictTenantPool } from "../db/tenant.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import * as activity from "../platform/activity.js";
import * as notifications from "../platform/notifications.js";
import { provisionOrgForUser } from "./auth.js";
import { checkEntitlement } from "../platform/hosted-seams.js";
import { disableModuleForOrg, enableModuleForOrg } from "../modules/enable.js";
import { getEntry as getModuleEntry } from "../modules/registry.js";

export const orgsRouter = Router();

// ──────────────────────── multi-org listing + create ────────────────

// GET /orgs — list all orgs the current user belongs to. Lets the
// web shell render the workspace switcher without re-using the
// signup/login response (which is cached and goes stale once you
// create a new org mid-session).
orgsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const orgs = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select((eb) => ["o.id", "o.name", "o.slug", "m.role", eb.selectFrom("org_memberships as om").innerJoin("users as ou", "ou.id", "om.user_id").select("ou.display_name").whereRef("om.org_id", "=", "o.id").where("om.role", "=", "owner").limit(1).as("owner_name")])
      .where("m.user_id", "=", req.session!.id)
      .orderBy("o.created_at")
      .execute();
    res.json({ items: orgs });
  } catch (err) {
    next(err);
  }
});

const CreateOrgBody = z.object({
  name: z.string().min(1).max(120),
});

// POST /orgs — create a new workspace for the current user. The user
// becomes owner of the new org. Returns the new {id, name, slug,
// role} so the client can flip the active-org locally.
// GET /orgs/:slug/modules — every registered module + whether it's
// enabled for THIS org. The UI uses this for the "modules" admin
// page (turn things on/off).
orgsRouter.get("/:slug/modules", requireAuth, withTenant, async (req, res, next) => {
  try {
    const registered = (await import("../modules/registry.js")).list();
    const enabled = await meta
      .selectFrom("org_modules")
      .select(["module_name", "version", "enabled_at"])
      .where("org_id", "=", req.tenant!.org.id)
      .execute();
    const enabledSet = new Map(enabled.map((e) => [e.module_name, e]));
    const items = registered.map((m) => {
      const on = enabledSet.get(m.name);
      return {
        name: m.name,
        version: m.version,
        displayName: m.displayName,
        description: m.description,
        icon: m.icon ?? null,
        // Module layer (foundational/stock/marketplace/user) — the empty
        // dashboard suggests only `stock` first-party domains.
        band: m.band,
        // Icon-only quick-action for the navbar's right cluster (only
        // surfaced when the module is enabled — the web filters on that).
        headerAction: m.headerAction ?? null,
        dependencies: m.dependencies,
        contributes: {
          fieldDefs: m.contributes.fieldDefs.length,
          wires: m.contributes.wires.length,
        },
        enabled: !!on,
        enabled_version: on?.version ?? null,
        enabled_at: on?.enabled_at ?? null,
      };
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /orgs/:slug/modules/:moduleName/enable — enable a module for
// the workspace post-signup. Idempotent: returns already_enabled=true
// instead of erroring if the module's already on.
orgsRouter.post(
  "/:slug/modules/:moduleName/enable",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin" && req.tenant!.role !== "editor") {
        res.status(403).json({
          error: { code: "forbidden", message: "Only owners, admins, or editors can enable modules." },
        });
        return;
      }
      const name = req.params.moduleName;
      if (!name) {
        res.status(400).json({ error: { code: "missing_id", message: "module name required" } });
        return;
      }
      if (!getModuleEntry(name)) {
        res.status(404).json({
          error: { code: "not_found", message: `module not registered: ${name}` },
        });
        return;
      }
      const result = await enableModuleForOrg(req.tenant!.org.id, name, {
        userId: req.session!.id,
      });
      res.status(result.alreadyEnabled ? 200 : 201).json({
        module: name,
        already_enabled: result.alreadyEnabled,
        migrations_applied: result.migrationsApplied,
        last_migration: result.lastMigration,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /orgs/:slug/modules/:moduleName/disable — clean up the
// module's Pillar-E contributions (field-defs + wires it owns) and
// drop the org_modules row. Tenant tables are NOT dropped (data
// preservation); re-enabling the module later re-runs migrations
// against existing tables, which is a no-op.
orgsRouter.post(
  "/:slug/modules/:moduleName/disable",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin" && req.tenant!.role !== "editor") {
        res.status(403).json({
          error: { code: "forbidden", message: "Only owners, admins, or editors can disable modules." },
        });
        return;
      }
      const name = req.params.moduleName;
      if (!name) {
        res.status(400).json({ error: { code: "missing_id", message: "module name required" } });
        return;
      }
      await disableModuleForOrg(req.tenant!.org.id, name);
      res.status(204).end();
    } catch (err) {
      // Surface dependent-module errors as 400 (user-actionable)
      // rather than 500.
      if (err instanceof Error && err.message.startsWith("Cannot disable")) {
        res.status(400).json({ error: { code: "module_in_use", message: err.message } });
        return;
      }
      next(err);
    }
  },
);

// DELETE /orgs/:slug — owner-only. Drops the tenant DB, removes
// the meta-side artifacts (memberships, invites, bundles, wires,
// field-defs, activity_log for this org), then the org row itself.
// Hard delete. Phase-0 minimum-viable; later versions might support
// "archive" instead.
orgsRouter.delete("/:slug", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (req.tenant!.role !== "owner") {
      res.status(403).json({
        error: { code: "forbidden", message: "Only the workspace owner can delete it." },
      });
      return;
    }
    const orgId = req.tenant!.org.id;
    const dbName = await meta
      .selectFrom("orgs")
      .select("db_name")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();

    // Close any cached connection pool to the tenant DB BEFORE dropping
    // it. Otherwise DROP DATABASE WITH (FORCE) kills active connections
    // and the resulting pg error can take the api process down with it.
    await evictTenantPool(orgId);

    // Terminate any other connections to the DB (background tasks,
    // hung queries) then DROP. CREATE/DROP DATABASE can't run inside
    // a tx — also can't run while you're connected to the target DB,
    // so we issue from the meta pool.
    try {
      await metaPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName.db_name],
      );
      await metaPool.query(`DROP DATABASE IF EXISTS "${dbName.db_name}"`);
    } catch (err) {
      console.error(`[delete-org] failed to drop tenant DB ${dbName.db_name}:`, err);
      // Fall through — DB drop failing doesn't block the meta cleanup,
      // since the credentials are encrypted on the org row and the
      // user can't reach a stranded DB anyway.
    }

    // FKs with ON DELETE CASCADE handle most child rows
    // (memberships, modules, bundles, bindings, field_defs, invites).
    // activity_log doesn't cascade — clear it explicitly.
    await meta.deleteFrom("activity_log").where("org_id", "=", orgId).execute();
    await meta.deleteFrom("notifications").where("org_id", "=", orgId).execute();
    await meta.deleteFrom("notification_subscriptions").where("org_id", "=", orgId).execute();
    await meta.deleteFrom("orgs").where("id", "=", orgId).execute();

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

orgsRouter.post("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = CreateOrgBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues },
      });
      return;
    }
    // Entitlement seam: the hosted overlay gates how many workspaces a user's
    // plan allows (user-scoped, so orgId is empty). No-op in open core.
    const ent = await checkEntitlement({
      orgId: "",
      feature: "workspaces.create",
      userId: req.session!.id,
    });
    if (!ent.allow) {
      res.status(402).json({
        error: { code: "plan_limit", message: ent.reason ?? "Your plan's workspace limit is reached." },
      });
      return;
    }
    const { orgId, slug } = await provisionOrgForUser(req.session!.id, parsed.data.name);
    const row = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select((eb) => ["o.id", "o.name", "o.slug", "m.role", eb.selectFrom("org_memberships as om").innerJoin("users as ou", "ou.id", "om.user_id").select("ou.display_name").whereRef("om.org_id", "=", "o.id").where("om.role", "=", "owner").limit(1).as("owner_name")])
      .where("m.user_id", "=", req.session!.id)
      .where("o.id", "=", orgId)
      .executeTakeFirstOrThrow();
    res.status(201).json({ org: row, slug });
  } catch (err) {
    next(err);
  }
});

orgsRouter.get("/:slug/local", requireAuth, withTenant, async (req, res, next) => {
  try {
    const rows = await req.tenant!.db
      .selectFrom("platform_local")
      .select(["key", "value", "updated_at"])
      .orderBy("key")
      .execute();
    res.json({
      org: req.tenant!.org,
      role: req.tenant!.role,
      rows,
    });
  } catch (err) {
    next(err);
  }
});

// Queue jobs for this workspace. Read-only; admins use this to see
// what background work is queued, running, done, or failed.
orgsRouter.get("/:slug/queue/jobs", requireAuth, withTenant, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const statusParam = typeof req.query.status === "string" ? req.query.status : null;
    let q = meta
      .selectFrom("core_queue_jobs")
      .select([
        "id",
        "queue",
        "payload",
        "status",
        "attempts",
        "max_attempts",
        "run_at",
        "locked_at",
        "locked_by",
        "completed_at",
        "failed_at",
        "error",
        "created_at",
      ])
      .where("org_id", "=", req.tenant!.org.id)
      .orderBy("created_at", "desc")
      .limit(limit);
    if (statusParam) {
      q = q.where("status", "=", statusParam as never);
    }
    const items = await q.execute();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

orgsRouter.get("/:slug/activity", requireAuth, withTenant, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const actionsParam = typeof req.query.actions === "string" ? req.query.actions : null;
    const actions = actionsParam
      ? actionsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const authParam = typeof req.query.auth_methods === "string" ? req.query.auth_methods : null;
    const authMethods = authParam
      ? (authParam
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is "session" | "api_token" | "system" =>
            s === "session" || s === "api_token" || s === "system"))
      : undefined;
    const apiTokenId = typeof req.query.api_token_id === "string" ? req.query.api_token_id : undefined;
    const entityType = typeof req.query.entity_type === "string" ? req.query.entity_type : undefined;
    const items = await activity.list({
      orgId: req.tenant!.org.id,
      limit,
      actions,
      authMethods,
      apiTokenId,
      entityType,
    });

    // Enrich with token names + user display names so the UI can
    // show "via 'claude-on-mac'" instead of bare UUIDs.
    const tokenIds = [...new Set(items.map((i) => i.api_token_id).filter((x): x is string => !!x))];
    const userIds = [...new Set(items.map((i) => i.user_id).filter((x): x is string => !!x))];
    const tokenRows = tokenIds.length
      ? await meta
          .selectFrom("api_tokens")
          .select(["id", "name", "token_prefix"])
          .where("id", "in", tokenIds)
          .execute()
      : [];
    const userRows = userIds.length
      ? await meta
          .selectFrom("users")
          .select(["id", "display_name", "email"])
          .where("id", "in", userIds)
          .execute()
      : [];
    const tokenById = new Map(tokenRows.map((t) => [t.id, t]));
    const userById = new Map(userRows.map((u) => [u.id, u]));

    res.json({
      items: items.map((i) => ({
        ...i,
        actor: i.user_id
          ? {
              id: i.user_id,
              display_name: userById.get(i.user_id)?.display_name ?? null,
              email: userById.get(i.user_id)?.email ?? null,
            }
          : null,
        token: i.api_token_id
          ? {
              id: i.api_token_id,
              name: tokenById.get(i.api_token_id)?.name ?? "(revoked)",
              prefix: tokenById.get(i.api_token_id)?.token_prefix ?? null,
            }
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

orgsRouter.get("/:slug/notifications", requireAuth, withTenant, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const unreadOnly = req.query.unread === "1";
    const items = await notifications.listForUser(req.session!.id, req.tenant!.org.id, {
      limit,
      unreadOnly,
    });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

orgsRouter.get(
  "/:slug/notifications/unread-count",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const count = await notifications.unreadCount(
        req.session!.id,
        req.tenant!.org.id,
      );
      res.json({ count });
    } catch (err) {
      next(err);
    }
  },
);

orgsRouter.post(
  "/:slug/notifications/:id/read",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      await notifications.markRead(id, req.session!.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

orgsRouter.post(
  "/:slug/notifications/read-all",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const count = await notifications.markAllRead(
        req.session!.id,
        req.tenant!.org.id,
      );
      res.json({ marked: count });
    } catch (err) {
      next(err);
    }
  },
);
