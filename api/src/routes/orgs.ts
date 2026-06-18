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
import { sql } from "kysely";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { getManagedApp } from "../platform/managed-apps.js";
import { hardDeleteOrg } from "../platform/delete-org.js";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import * as activity from "../platform/activity.js";
import * as notifications from "../platform/notifications.js";
import { provisionOrgForUser } from "./auth.js";
import { provisionAppWorkspace, ProvisionAppError, refreshManagedApp, importAppData } from "../platform/provision-app.js";
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
      .select((eb) => ["o.id", "o.name", "o.slug", "o.app_mode", "o.focused", "m.role", eb.selectFrom("org_memberships as om").innerJoin("users as ou", "ou.id", "om.user_id").select("ou.display_name").whereRef("om.org_id", "=", "o.id").where("om.role", "=", "owner").limit(1).as("owner_name")])
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
  // Optional managed-app id ("yarn"). When set, the new workspace is provisioned
  // AS that app (flagship bundle + app mode), exactly like POST /provision-app
  // and the /auth/signup app branch — so all three create-paths agree. Without
  // it, a plain workspace (the default). `manifest` is the usual test/operator
  // override; production resolves the bundle from the registry server-side.
  app: z.string().min(1).optional(),
  manifest: z.unknown().optional(),
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
    // Shared with the operator console's delete (platform/delete-org.ts).
    await hardDeleteOrg(req.tenant!.org.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// PATCH /orgs/:slug/app-mode — owner-only. Flip a workspace into a managed
// vertical app ("Cobblr for Yarn") — the web then hides ALL platform chrome and
// lands the user in the app — or clear it back to a normal platform workspace.
// Body: { app: "yarn" } to set (home_path + label come from the server-side
// managed-app registry), or { app: null } to clear. Setting app_mode does NOT
// itself install the app's bundle — that's done separately (the workspace is
// expected to already have, or get, the flagship bundle applied); this only
// records "treat this workspace as that managed app + lock it down."
const AppModeBody = z.object({ app: z.string().min(1).nullable() });
orgsRouter.patch("/:slug/app-mode", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (req.tenant!.role !== "owner") {
      res.status(403).json({
        error: { code: "forbidden", message: "Only the workspace owner can change app mode." },
      });
      return;
    }
    const parsed = AppModeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    let appMode: { app: string; home_path: string; label: string } | null = null;
    if (parsed.data.app) {
      const app = getManagedApp(parsed.data.app);
      if (!app) {
        res.status(400).json({ error: { code: "unknown_app", message: `Unknown managed app "${parsed.data.app}".` } });
        return;
      }
      appMode = { app: app.id, home_path: app.homePath, label: app.label };
    }
    await meta
      .updateTable("orgs")
      .set({
        app_mode: (appMode ? sql`${JSON.stringify(appMode)}::jsonb` : null) as never,
        updated_at: new Date(),
      })
      .where("id", "=", req.tenant!.org.id)
      .execute();
    await activity.log({
      orgId: req.tenant!.org.id,
      userId: req.session!.id,
      action: appMode ? "app_mode_set" : "app_mode_cleared",
      ref: { module: null, entityType: "org", entityId: req.tenant!.org.id },
      diff: { app_mode: appMode },
    });
    res.json({ app_mode: appMode });
  } catch (err) {
    next(err);
  }
});

// PATCH /orgs/:slug/focused — owner/admin. Flip "focused mode" on this workspace:
// the web shell hides the builder chrome (marketplace / add-modules / AI builder /
// Configuration / the "+ New thing" funnel) so a non-technical owner sees a
// finished app, not a toolkit. SOFTER than app_mode — the workspace stays fully
// navigable and any owner/admin can flip it straight back ("Explore the full
// platform"). Body: { focused: boolean }.
const FocusedBody = z.object({ focused: z.boolean() });
orgsRouter.patch("/:slug/focused", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
      res.status(403).json({
        error: { code: "forbidden", message: "Only an owner or admin can change focused mode." },
      });
      return;
    }
    const parsed = FocusedBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    await meta
      .updateTable("orgs")
      .set({ focused: parsed.data.focused, updated_at: new Date() })
      .where("id", "=", req.tenant!.org.id)
      .execute();
    await activity.log({
      orgId: req.tenant!.org.id,
      userId: req.session!.id,
      action: parsed.data.focused ? "focused_enabled" : "focused_disabled",
      ref: { module: null, entityType: "org", entityId: req.tenant!.org.id },
      diff: { focused: parsed.data.focused },
    });
    res.json({ focused: parsed.data.focused });
  } catch (err) {
    next(err);
  }
});

// POST /orgs/:slug/refresh-app — re-apply the latest published version of this
// managed app's bundle if it's behind ("auto-update on use"). Owner/admin; safe
// + idempotent (no-op when current). The web calls it once per session when a
// managed-app user enters the app. `manifest` is a test/operator override.
const RefreshAppBody = z.object({ manifest: z.unknown().optional() });
orgsRouter.post("/:slug/refresh-app", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
      res.status(403).json({ error: { code: "forbidden", message: "Only owners or admins can refresh the app." } });
      return;
    }
    const parsed = RefreshAppBody.safeParse(req.body ?? {});
    const result = await refreshManagedApp(req.tenant!.org.id, req.session!.id, parsed.success ? parsed.data.manifest : undefined);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /orgs/:slug/import-app — graduation: copy a managed app's data (source_slug,
// the user's "Cobblr for Yarn") INTO this (full) workspace. Ensures the matching
// instance + fields exist here, then copies the items. Owner/admin of the target;
// the caller must also be a member of the source. Source data is left untouched.
const ImportAppBody = z.object({ source_slug: z.string().min(1) });
orgsRouter.post("/:slug/import-app", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
      res.status(403).json({ error: { code: "forbidden", message: "Only owners or admins can import into this workspace." } });
      return;
    }
    const parsed = ImportAppBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    // The source must be one of the caller's own workspaces.
    const source = await meta
      .selectFrom("orgs as o")
      .innerJoin("org_memberships as m", "m.org_id", "o.id")
      .select(["o.id"])
      .where("o.slug", "=", parsed.data.source_slug)
      .where("m.user_id", "=", req.session!.id)
      .executeTakeFirst();
    if (!source) {
      res.status(404).json({ error: { code: "source_not_found", message: "That source workspace isn't one of yours." } });
      return;
    }
    if (source.id === req.tenant!.org.id) {
      res.status(400).json({ error: { code: "same_workspace", message: "Source and target are the same workspace." } });
      return;
    }
    const result = await importAppData(source.id, req.tenant!.org.id, req.session!.id);
    res.json(result);
  } catch (err) {
    if (err instanceof ProvisionAppError) {
      res.status(400).json({ error: { code: err.code, message: err.message, details: err.detail } });
      return;
    }
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
    // `app` set → provision a managed app (bundle + app mode), same as
    // /provision-app and the signup app branch. Else a plain workspace.
    let orgId: string, slug: string;
    if (parsed.data.app) {
      const result = await provisionAppWorkspace(req.session!.id, parsed.data.app, parsed.data.manifest, {
        display_name: req.session!.display_name ?? null,
        auth_method: req.session!.auth_method,
        api_token_id: req.session!.api_token_id ?? null,
      });
      orgId = result.orgId;
      slug = result.slug;
    } else {
      ({ orgId, slug } = await provisionOrgForUser(req.session!.id, parsed.data.name));
    }
    const row = await meta
      .selectFrom("org_memberships as m")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select((eb) => ["o.id", "o.name", "o.slug", "o.app_mode", "o.focused", "m.role", eb.selectFrom("org_memberships as om").innerJoin("users as ou", "ou.id", "om.user_id").select("ou.display_name").whereRef("om.org_id", "=", "o.id").where("om.role", "=", "owner").limit(1).as("owner_name")])
      .where("m.user_id", "=", req.session!.id)
      .where("o.id", "=", orgId)
      .executeTakeFirstOrThrow();
    res.status(201).json({ org: row, slug });
  } catch (err) {
    if (err instanceof ProvisionAppError) {
      res.status(400).json({ error: { code: err.code, message: err.message, details: err.detail } });
      return;
    }
    next(err);
  }
});

// POST /orgs/provision-app — one-step managed-app provisioning ("Cobblr for
// Yarn"): create a workspace, apply the app's flagship bundle, and flip it into
// app mode. The web lands the user straight in the locked app. `app` is keyed
// against the server-side managed-app registry; `manifest` is the app's bundle
// (caller-supplied for now — a server-side registry fetch is the follow-up).
const ProvisionAppBody = z.object({ app: z.string().min(1), manifest: z.unknown() });
orgsRouter.post("/provision-app", requireAuth, async (req, res, next) => {
  try {
    const parsed = ProvisionAppBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues } });
      return;
    }
    const ent = await checkEntitlement({ orgId: "", feature: "workspaces.create", userId: req.session!.id });
    if (!ent.allow) {
      res.status(402).json({ error: { code: "plan_limit", message: ent.reason ?? "Your plan's workspace limit is reached." } });
      return;
    }
    const result = await provisionAppWorkspace(req.session!.id, parsed.data.app, parsed.data.manifest, {
      display_name: req.session!.display_name ?? null,
      auth_method: req.session!.auth_method,
      api_token_id: req.session!.api_token_id ?? null,
    });
    res.status(201).json({ slug: result.slug, app_mode: result.app });
  } catch (err) {
    if (err instanceof ProvisionAppError) {
      res.status(400).json({ error: { code: err.code, message: err.message, details: err.detail } });
      return;
    }
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
