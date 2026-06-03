// /orgs/:slug/portal-config + /orgs/:slug/permissions
//
// Backs the member portal feature (a slimmed-down front-end shell)
// + per-action capability grants. See
// docs/modules/member-portal-and-permissions.md.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { effectiveCapabilities } from "../auth/effective-capabilities.js";
import * as activity from "../platform/activity.js";

export const portalRouter = Router({ mergeParams: true });

// Portal launcher override theme — the SAME token shape as a core-apps
// app theme (mirrored here; the module can't be imported from core). When
// unset, the launcher INHERITS the workspace's default-app / sole-app
// theme (resolved client-side in PortalLayout); when set, this wins. The
// per-workspace portal is the builder's, so it carries the builder's
// brand — not Cobblr's. Tokens only (validated hex / vetted keyword / a
// bounded asset URL), never raw CSS.
const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "must be a hex color");
const assetRef = z
  .string()
  .regex(/^(https?:\/\/|data:(image|font|application)\/)/, "must be an http(s) or data: URL");
const ThemeTokens = z
  .object({
    bg: hexColor.optional(),
    surface: hexColor.optional(),
    text: hexColor.optional(),
    muted: hexColor.optional(),
    accent: hexColor.optional(),
    accent_text: hexColor.optional(),
    border: hexColor.optional(),
    font: z.enum(["sans", "serif", "mono", "rounded", "slab"]).optional(),
    radius: z.number().int().min(0).max(36).optional(),
    logo: assetRef.max(500_000).optional(),
    font_url: assetRef.max(1_200_000).optional(),
    font_name: z.string().max(60).optional(),
  })
  .strict();

const PortalConfigShape = z.object({
  display_name: z.string().max(120).optional(),
  logo_path: z.string().max(500).nullable().optional(),
  theme: z.enum(["light", "dark", "auto"]).optional(),
  /** Override skin for the portal launcher. Unset → inherit the
   *  workspace's default-app / sole-app theme. See PortalLayout. */
  theme_tokens: ThemeTokens.nullable().optional(),
  /** Brand theme for the ADMIN dashboard shell. v1 (chrome): drives the
   *  page background + accent + workspace logo, keeping the Cobblr mark;
   *  the dense module-page palette is a later migration. See AppLayout +
   *  worker-navigation-and-identity.md §4. */
  admin_theme: ThemeTokens.nullable().optional(),
  pinned_views: z.array(z.string().uuid()).default([]),
  welcome_markdown: z.string().max(20000).optional(),
  /** Worker-landing (worker-navigation-and-identity.md): the app slug a
   *  member lands in directly instead of this portal. The portal then
   *  serves only as the fallback "drawer of everything". A member who
   *  can't open it (capabilities) falls through to the launcher; an
   *  unset value + exactly one openable app + no pinned views also
   *  auto-lands. Not cross-checked here — the resolver tolerates a stale
   *  slug by showing the launcher. */
  default_app: z.string().max(80).nullable().optional(),
});

// ──────────────────────── /portal-config ────────────────────────

portalRouter.get(
  "/:slug/portal-config",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const row = await meta
        .selectFrom("orgs")
        .select(["portal_config", "name"])
        .where("id", "=", req.tenant!.org.id)
        .executeTakeFirst();
      res.json({
        config: row?.portal_config ?? { pinned_views: [] },
        org_name: row?.name ?? "",
      });
    } catch (err) {
      next(err);
    }
  },
);

portalRouter.put(
  "/:slug/portal-config",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // Only admins/owners can edit. The portal it configures is
      // visible to every role.
      if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
        res.status(403).json({
          error: { code: "forbidden", message: "Admins only." },
        });
        return;
      }
      const parsed = PortalConfigShape.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad portal config", details: parsed.error.issues },
        });
        return;
      }
      await meta
        .updateTable("orgs")
        .set({
          portal_config: sql`${JSON.stringify(parsed.data)}::jsonb` as never,
          updated_at: new Date(),
        })
        .where("id", "=", req.tenant!.org.id)
        .execute();
      await activity.log({
        orgId: req.tenant!.org.id,
        userId: req.session!.id,
        action: "portal_config_updated",
        ref: { module: null, entityType: "org", entityId: req.tenant!.org.id },
        diff: { pinned_views: parsed.data.pinned_views.length },
      });
      res.json({ config: parsed.data });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────── /permissions ───────────────────────────

// GET — returns the capability matrix: every member of the workspace
// + which action grants they currently hold. Admins/owners are
// implicit; we still list them so the UI can show "implicit" badges.
portalRouter.get(
  "/:slug/permissions",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
        res.status(403).json({
          error: { code: "forbidden", message: "Admins only." },
        });
        return;
      }
      const members = await meta
        .selectFrom("org_memberships as om")
        .innerJoin("users as u", "u.id", "om.user_id")
        .select(["u.id", "u.email", "u.display_name", "om.role"])
        .where("om.org_id", "=", req.tenant!.org.id)
        .orderBy("u.display_name")
        .execute();
      const grants = await meta
        .selectFrom("workspace_capability_grants")
        .select(["user_id", "action_id"])
        .where("org_id", "=", req.tenant!.org.id)
        .execute();
      const grantsByUser: Record<string, string[]> = {};
      for (const g of grants) {
        (grantsByUser[g.user_id] ||= []).push(g.action_id);
      }
      // Custom-role assignments (S2). Each member can have many.
      const roleAssigns = await meta
        .selectFrom("workspace_role_assignments")
        .select(["user_id", "role_id"])
        .where("org_id", "=", req.tenant!.org.id)
        .execute();
      const roleIdsByUser: Record<string, string[]> = {};
      for (const a of roleAssigns) {
        (roleIdsByUser[a.user_id] ||= []).push(a.role_id);
      }
      res.json({
        members: members.map((m) => ({
          id: m.id,
          email: m.email,
          display_name: m.display_name,
          role: m.role,
          grants: grantsByUser[m.id] ?? [],
          custom_role_ids: roleIdsByUser[m.id] ?? [],
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

const GrantBody = z.object({
  user_id: z.string().uuid(),
  action_id: z.string().min(1).max(120),
});

// Capabilities that requireCapability() gates check but that aren't
// invokable "actions" in the entity_actions registry yet. Until the
// manifest gains a first-class capability registry, list the
// endpoint-gate caps here so they're grantable + validated alongside
// the registered actions. TODO: fold into a manifest-declared registry.
const ENDPOINT_CAPABILITIES = [
  { action_id: "inventory:create-part", label: "Create parts", description: "Add new parts to inventory." },
  { action_id: "inventory:update-part", label: "Edit parts", description: "Edit existing part fields." },
];

/** Every capability an admin can grant a member: the registered actions
 *  (entity_actions) plus the endpoint-gate caps above. Single source of
 *  truth for both the matrix columns and grant validation. */
async function grantableActions(
  orgId?: string,
): Promise<Array<{ action_id: string; label: string; description: string }>> {
  const registered = await meta
    .selectFrom("entity_actions")
    .select(["id", "label", "description"])
    .orderBy("id")
    .execute();
  const items = registered.map((r) => ({
    action_id: r.id,
    label: r.label,
    description: r.description ?? "",
  }));
  const have = new Set(items.map((a) => a.action_id));
  for (const c of ENDPOINT_CAPABILITIES) if (!have.has(c.action_id)) items.push(c);
  // H2 — per-field read-scope capabilities declared by entity kinds
  // (entity_kinds.field_read_scopes values). Auto-grantable so an admin
  // can assign a "view costs"-style cap from the matrix without any
  // central registry: any module that gates a field makes its
  // capability appear here automatically.
  const gatedKinds = await meta
    .selectFrom("entity_kinds")
    .select(["field_read_scopes"])
    .where("field_read_scopes", "is not", null)
    .execute();
  for (const k of gatedKinds) {
    const scopes = (k.field_read_scopes as Record<string, string> | null) ?? {};
    for (const [field, cap] of Object.entries(scopes)) {
      if (have.has(cap)) continue;
      have.add(cap);
      items.push({
        action_id: cap,
        label: `View ${field}`,
        description: `See the "${field}" field on records that restrict it.`,
      });
    }
  }
  // H2 admin-configurable — per-workspace field scopes the admin defined
  // (workspace_field_scopes). Same auto-grantable treatment so a
  // workspace's own "view X" caps show in its matrix.
  if (orgId) {
    const perOrg = await meta
      .selectFrom("workspace_field_scopes")
      .select(["field", "capability"])
      .where("org_id", "=", orgId)
      .execute();
    for (const s of perOrg) {
      if (have.has(s.capability)) continue;
      have.add(s.capability);
      items.push({
        action_id: s.capability,
        label: `View ${s.field}`,
        description: `See the "${s.field}" field (restricted in this workspace).`,
      });
    }
  }
  return items;
}

portalRouter.post(
  "/:slug/permissions/grants",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
        res.status(403).json({
          error: { code: "forbidden", message: "Admins only." },
        });
        return;
      }
      const parsed = GrantBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad grant", details: parsed.error.issues },
        });
        return;
      }
      // Verify the target user is actually a member of this workspace.
      const member = await meta
        .selectFrom("org_memberships")
        .select("user_id")
        .where("org_id", "=", req.tenant!.org.id)
        .where("user_id", "=", parsed.data.user_id)
        .executeTakeFirst();
      if (!member) {
        res.status(404).json({
          error: { code: "not_member", message: "User isn't a member of this workspace." },
        });
        return;
      }
      // Don't persist arbitrary action_id strings: a grant for a cap
      // that no gate checks is dead, and it pollutes the matrix.
      const grantable = await grantableActions(req.tenant!.org.id);
      if (!grantable.some((a) => a.action_id === parsed.data.action_id)) {
        res.status(400).json({
          error: {
            code: "unknown_action",
            message: `${parsed.data.action_id} is not a grantable capability.`,
          },
        });
        return;
      }
      const row = await meta
        .insertInto("workspace_capability_grants")
        .values({
          org_id: req.tenant!.org.id,
          user_id: parsed.data.user_id,
          action_id: parsed.data.action_id,
          granted_by: req.session!.id,
        })
        .onConflict((c) => c.columns(["org_id", "user_id", "action_id"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      await activity.log({
        orgId: req.tenant!.org.id,
        userId: req.session!.id,
        action: "capability_granted",
        ref: { module: null, entityType: "user", entityId: parsed.data.user_id },
        diff: { action_id: parsed.data.action_id },
      });
      res.status(201).json({ grant: row ?? null });
    } catch (err) {
      next(err);
    }
  },
);

portalRouter.delete(
  "/:slug/permissions/grants",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (req.tenant!.role !== "owner" && req.tenant!.role !== "admin") {
        res.status(403).json({
          error: { code: "forbidden", message: "Admins only." },
        });
        return;
      }
      const parsed = GrantBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: "invalid_body", message: "Bad grant", details: parsed.error.issues },
        });
        return;
      }
      await meta
        .deleteFrom("workspace_capability_grants")
        .where("org_id", "=", req.tenant!.org.id)
        .where("user_id", "=", parsed.data.user_id)
        .where("action_id", "=", parsed.data.action_id)
        .execute();
      await activity.log({
        orgId: req.tenant!.org.id,
        userId: req.session!.id,
        action: "capability_revoked",
        ref: { module: null, entityType: "user", entityId: parsed.data.user_id },
        diff: { action_id: parsed.data.action_id },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// What actions are even grantable? The platform-contract manifest
// gains a `portal_grantable: boolean` flag on actions; we list every
// action across registered modules whose manifest set it. The admin
// permissions UI consumes this to render the matrix columns.
portalRouter.get(
  "/:slug/permissions/grantable-actions",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      res.json({ items: await grantableActions(req.tenant!.org.id) });
    } catch (err) {
      next(err);
    }
  },
);

// ── H2 admin-configurable field read-scope ──────────────────────────
// Owner/admin define which fields are sensitive PER WORKSPACE + the
// capability that gates each. Merged over the manifest scopes at read
// time (see getFieldReadScopes); the capability is auto-grantable.
function adminOnly(req: Parameters<typeof requireAuth>[0], res: Parameters<typeof requireAuth>[1]): boolean {
  const role = (req as { tenant?: { role?: string } }).tenant?.role;
  if (role === "owner" || role === "admin") return true;
  res.status(403).json({ error: { code: "forbidden", message: "Admins only." } });
  return false;
}
const FieldScopeBody = z.object({
  kind: z.string().min(1).max(120),
  field: z.string().min(1).max(120),
  capability: z.string().min(1).max(120),
});
portalRouter.get("/:slug/field-scopes", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const items = await meta
      .selectFrom("workspace_field_scopes")
      .select(["kind", "field", "capability"])
      .where("org_id", "=", req.tenant!.org.id)
      .orderBy(["kind", "field"])
      .execute();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});
portalRouter.put("/:slug/field-scopes", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const parsed = FieldScopeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "invalid_body", message: "Bad body", details: parsed.error.issues } });
      return;
    }
    await meta
      .insertInto("workspace_field_scopes")
      .values({
        org_id: req.tenant!.org.id,
        kind: parsed.data.kind,
        field: parsed.data.field,
        capability: parsed.data.capability,
        created_by: req.session!.id,
      })
      .onConflict((c) => c.columns(["org_id", "kind", "field"]).doUpdateSet({ capability: parsed.data.capability }))
      .execute();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
portalRouter.delete("/:slug/field-scopes", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!adminOnly(req, res)) return;
    const kind = String(req.query.kind ?? "");
    const field = String(req.query.field ?? "");
    if (!kind || !field) {
      res.status(400).json({ error: { code: "missing_params", message: "kind + field required" } });
      return;
    }
    await meta
      .deleteFrom("workspace_field_scopes")
      .where("org_id", "=", req.tenant!.org.id)
      .where("kind", "=", kind)
      .where("field", "=", field)
      .execute();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// What capabilities does the *current* user have? Used by the
// portal shell to decide whether to render edit affordances.
portalRouter.get(
  "/:slug/me/capabilities",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const role = req.tenant!.role;
      // Shared resolution so UI-gating here matches the read-time
      // field-scope enforcement (H2) exactly — same caps, one query.
      const ec = await effectiveCapabilities(
        req.tenant!.org.id,
        req.session!.id,
        role,
      );
      res.json({
        role,
        grants: ec.all ? [] : Array.from(ec.caps).sort(),
      });
    } catch (err) {
      next(err);
    }
  },
);
