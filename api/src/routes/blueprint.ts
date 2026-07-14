// Blueprint — a whole workspace's *configuration snapshot*: the modules
// it has enabled, the bundles installed on top, the user-authored field
// defs + wires + saved views + public surfaces + module instances. NOT
// its data (no entity rows, no files). See
// docs/architecture/blueprint-backup-export.md.
//
// This is the config half of the Blueprint/Backup/Export feature. It is
// the meta-bundle level above bundles: where `bundles.ts` exports/installs
// ONE bundle's field defs + wires, a blueprint exports/installs the whole
// workspace setup, composing the installed bundles by embedding their full
// manifests and replaying them through bundles' own apply path.
//
// Mounted at /api/v1/orgs/:slug/blueprint. Export + two-phase install,
// owner/admin only (an export reveals every wire/field/view/surface; an
// install enables modules + creates public surfaces).

import { Router } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as activity from "../platform/activity.js";
import { enableModuleForOrg } from "../modules/enable.js";
import { listInstances, getInstance, createInstance } from "../platform/instances.js";
import { validateBundle, applyValidatedBundle } from "./bundles.js";

// ── Minimal tenant-DB shape (the columns we read/write) ──────────────
// The full schemas live in modules/core-views + modules/core-public-surfaces.
interface BlueprintViewsRow {
  id: string;
  entity_kind: string;
  name: string;
  view_type: string;
  config: unknown;
  is_default: boolean;
  pinned: boolean;
  owner_user_id: string | null;
  bundle_id: string | null;
  source_module: string | null;
}
interface BlueprintSurfacesRow {
  id: string;
  name: string;
  token: string;
  scope_type: string;
  scope_id: string;
  config: unknown;
  enabled: boolean;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by: string | null;
}
interface BlueprintTenantDB {
  core_views_views: BlueprintViewsRow;
  core_public_surfaces_surfaces: BlueprintSurfacesRow;
}

// ── Manifest schema ──────────────────────────────────────────────────
// Additive by design (blueprint-backup-export.md §10): new fields slot in
// next to the existing ones without breaking earlier exports.
export const BlueprintManifest = z.object({
  kind: z.literal("cobblr.blueprint").default("cobblr.blueprint"),
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  readme_md: z.string().optional(),
  modules: z.array(z.object({ name: z.string() })).default([]),
  instances: z
    .array(
      z.object({
        module: z.string(),
        instance_name: z.string(),
        display_name: z.string(),
        config: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
  // Embedded full bundle manifests (validated by validateBundle on install).
  bundles: z.array(z.unknown()).default([]),
  wires: z
    .array(
      z.object({
        source_kind: z.string(),
        action_id: z.string(),
        trigger_type: z.string(),
        trigger_event: z.string().nullish(),
        trigger_schedule: z.string().nullish(),
        template: z.string().nullish(),
        filter: z.unknown().optional(),
        args: z.unknown().optional(),
        target: z.unknown().optional(),
      }),
    )
    .default([]),
  field_defs: z
    .array(
      z.object({
        entity_kind: z.string(),
        name: z.string(),
        display_label: z.string(),
        type: z.string(),
        required: z.boolean().optional(),
        position: z.number().optional(),
        choices: z.unknown().optional(),
        renderer: z.string().nullish(),
        template: z.string().nullish(),
        help: z.string().nullish(),
      }),
    )
    .default([]),
  saved_views: z
    .array(
      z.object({
        entity_kind: z.string(),
        name: z.string(),
        view_type: z.string(),
        config: z.record(z.unknown()).default({}),
        pinned: z.boolean().optional(),
        is_default: z.boolean().optional(),
      }),
    )
    .default([]),
  public_surfaces: z
    .array(
      z.object({
        name: z.string(),
        scope_type: z.string(),
        // We ship the underlying view NAME, never the local id (ids are
        // workspace-local). Re-resolved to a fresh view id on install.
        scope_view_name: z.string(),
        config: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
});
export type BlueprintManifestT = z.infer<typeof BlueprintManifest>;

export const blueprintRouter = Router({ mergeParams: true });

// ── Capture: build a blueprint manifest from a workspace ──────────────
// Shared by GET /export here and (Phase B) the backup builder.
export async function captureBlueprint(orgId: string): Promise<BlueprintManifestT> {
  // Enabled modules — every module the workspace has on. core-* foundationals
  // are always-on, so re-enabling them on install is a harmless no-op; we
  // keep them out of the manifest to keep it about the user's *choices*.
  const moduleRows = await meta
    .selectFrom("org_modules")
    .select("module_name")
    .where("org_id", "=", orgId)
    .execute();
  const modules = moduleRows
    .filter((m) => !m.module_name.startsWith("core-"))
    .map((m) => ({ name: m.module_name }));

  // Non-default instances (the default instance is created by module-enable).
  const allInstances = await listInstances(orgId);
  const instances = allInstances
    .filter((i) => !i.is_default)
    .map((i) => ({
      module: i.module_name,
      instance_name: i.instance_name,
      display_name: i.display_name,
      config: i.config ?? {},
    }));

  // Installed bundles — embed each full manifest so the blueprint is
  // self-contained (there's no bundle directory yet; the manifest we stored
  // on install round-trips through validateBundle/applyValidatedBundle).
  const bundleRows = await meta
    .selectFrom("bundles")
    .select("manifest")
    .where("org_id", "=", orgId)
    .orderBy("installed_at", "asc")
    .execute();
  const bundles = bundleRows.map((b) => b.manifest).filter(Boolean);

  // User-authored wires + field defs (not bundle- or module-owned) — same
  // filter bundle export uses.
  const wires = await meta
    .selectFrom("entity_action_bindings")
    .select([
      "source_kind",
      "action_id",
      "trigger_type",
      "trigger_event",
      "trigger_schedule",
      "template",
      "filter",
      "args",
      "target",
    ])
    .where("org_id", "=", orgId)
    .where("bundle_id", "is", null)
    .where("source_module", "is", null)
    .where("enabled", "=", true)
    .execute();
  const fieldDefs = await meta
    .selectFrom("module_field_defs")
    .select([
      "entity_kind",
      "name",
      "display_label",
      "type",
      "required",
      "position",
      "choices",
      "renderer",
      "template",
      "help",
    ])
    .where("org_id", "=", orgId)
    .where("bundle_id", "is", null)
    .where("source_module", "is", null)
    .orderBy("entity_kind")
    .orderBy("position")
    .execute();

  // Workspace-shared saved views + public surfaces from the tenant DB.
  // Best-effort: a tenant-DB hiccup degrades to a config-only blueprint
  // rather than failing the whole export.
  let savedViews: BlueprintManifestT["saved_views"] = [];
  let publicSurfaces: BlueprintManifestT["public_surfaces"] = [];
  try {
    const tdb = (await getTenantDb(orgId)) as unknown as Kysely<BlueprintTenantDB>;
    const views = await tdb
      .selectFrom("core_views_views")
      .select(["id", "entity_kind", "name", "view_type", "config", "pinned", "is_default"])
      .where("bundle_id", "is", null)
      .where("source_module", "is", null)
      .where("owner_user_id", "is", null)
      .execute();
    savedViews = views.map((v) => ({
      entity_kind: v.entity_kind,
      name: v.name,
      view_type: v.view_type,
      config: (v.config ?? {}) as Record<string, unknown>,
      pinned: v.pinned,
      is_default: v.is_default,
    }));
    const viewNameById = new Map(views.map((v) => [v.id, v.name]));

    const surfaces = await tdb
      .selectFrom("core_public_surfaces_surfaces")
      .select(["name", "scope_type", "scope_id", "config"])
      .where("enabled", "=", true)
      .where("revoked_at", "is", null)
      .execute();
    publicSurfaces = surfaces
      // Only view-scoped surfaces port cleanly — they reference a saved view
      // by name. Entity/collection/app surfaces point at local row ids that
      // don't exist in the target workspace, so we drop them.
      .filter((s) => s.scope_type === "view" && viewNameById.has(s.scope_id))
      .map((s) => ({
        name: s.name,
        scope_type: s.scope_type,
        scope_view_name: viewNameById.get(s.scope_id)!,
        config: (s.config ?? {}) as Record<string, unknown>,
      }));
  } catch (err) {
    console.error(`[blueprint-capture] tenant DB fetch failed for ${orgId}:`, err);
  }

  const orgRow = await meta
    .selectFrom("orgs")
    .select(["name", "slug"])
    .where("id", "=", orgId)
    .executeTakeFirstOrThrow();
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    kind: "cobblr.blueprint",
    id: `cobblr.blueprint.export.${orgRow.slug}.${stamp}`,
    version: stamp,
    name: `${orgRow.name} — blueprint ${stamp}`,
    description: `Workspace setup (modules, bundles, fields, wires, views, surfaces) from ${orgRow.name}. No data.`,
    author: orgRow.name,
    modules,
    instances,
    bundles,
    wires: wires.map((w) => ({
      source_kind: w.source_kind,
      action_id: w.action_id,
      trigger_type: w.trigger_type,
      trigger_event: w.trigger_event ?? undefined,
      trigger_schedule: w.trigger_schedule ?? undefined,
      template: w.template ?? undefined,
      filter: w.filter ?? undefined,
      args: w.args ?? undefined,
      target:
        w.target && w.target !== "self" && typeof w.target === "object"
          ? (w.target as Record<string, unknown>)
          : undefined,
    })),
    field_defs: fieldDefs.map((f) => ({
      entity_kind: f.entity_kind,
      name: f.name,
      display_label: f.display_label,
      type: f.type,
      required: f.required,
      position: f.position,
      choices: f.choices ?? undefined,
      renderer: f.renderer ?? undefined,
      template: f.template ?? undefined,
      help: f.help ?? undefined,
    })),
    saved_views: savedViews,
    public_surfaces: publicSurfaces,
  };
}

// ── Plan: what an install would do (the needs_consent payload) ───────
export interface BlueprintPlan {
  enable_modules: string[];
  install_bundles: Array<{ id: string; version: string }>;
  create_instances: number;
  create_wires: number;
  create_field_defs: number;
  create_saved_views: number;
  create_public_surfaces: number;
}

async function planInstall(orgId: string, m: BlueprintManifestT): Promise<BlueprintPlan> {
  const enabled = new Set(
    (await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()).map(
      (r) => r.module_name,
    ),
  );
  const existingInstances = new Set((await listInstances(orgId)).map((i) => i.instance_name));
  return {
    enable_modules: m.modules.map((x) => x.name).filter((n) => !enabled.has(n)),
    install_bundles: m.bundles.map((b) => {
      const bb = b as { id?: string; version?: string };
      return { id: bb.id ?? "(unknown)", version: bb.version ?? "" };
    }),
    create_instances: m.instances.filter((i) => !existingInstances.has(i.instance_name)).length,
    create_wires: m.wires.length,
    create_field_defs: m.field_defs.length,
    create_saved_views: m.saved_views.length,
    create_public_surfaces: m.public_surfaces.length,
  };
}

// ── Apply: install a blueprint onto a workspace ──────────────────────
export interface BlueprintApplyResult {
  enabled_modules: string[];
  created_instances: number;
  installed_bundles: number;
  bundle_warnings: Array<{ id: string; error: string }>;
  created_wires: number;
  created_field_defs: number;
  created_saved_views: number;
  created_public_surfaces: number;
}

export async function applyBlueprint(
  orgId: string,
  sess: { id: string; display_name?: string | null; auth_method: "session" | "api_token" | "system"; api_token_id?: string | null },
  m: BlueprintManifestT,
): Promise<BlueprintApplyResult> {
  const result: BlueprintApplyResult = {
    enabled_modules: [],
    created_instances: 0,
    installed_bundles: 0,
    bundle_warnings: [],
    created_wires: 0,
    created_field_defs: 0,
    created_saved_views: 0,
    created_public_surfaces: 0,
  };

  // 1. Enable modules (dependency expansion handled inside enableModuleForOrg;
  //    short-circuits if already on).
  const enabled = new Set(
    (await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()).map(
      (r) => r.module_name,
    ),
  );
  for (const mod of m.modules) {
    if (enabled.has(mod.name)) continue;
    try {
      await enableModuleForOrg(orgId, mod.name, { userId: sess.id });
      result.enabled_modules.push(mod.name);
      enabled.add(mod.name);
    } catch (err) {
      console.error(`[blueprint-install] enable module ${mod.name} failed:`, (err as Error).message);
    }
  }

  // 2. Create non-default instances.
  for (const inst of m.instances) {
    const existing = await getInstance(orgId, inst.instance_name);
    if (existing) continue;
    try {
      await createInstance({
        orgId,
        moduleName: inst.module,
        instanceName: inst.instance_name,
        displayName: inst.display_name,
        isDefault: false,
        config: inst.config,
      });
      result.created_instances++;
    } catch (err) {
      console.error(`[blueprint-install] create instance ${inst.instance_name} failed:`, (err as Error).message);
    }
  }

  // 3. Install embedded bundles through bundles' own validated apply path
  //    (modules are already enabled, so its needs_enable short-circuits).
  for (const raw of m.bundles) {
    const bb = raw as { id?: string };
    try {
      const v = await validateBundle(orgId, raw, { autoEnable: true });
      if (!v.valid) {
        result.bundle_warnings.push({
          id: bb.id ?? "(unknown)",
          error: v.errors.map((e) => e.message).join("; "),
        });
        continue;
      }
      await applyValidatedBundle(orgId, sess, v);
      result.installed_bundles++;
    } catch (err) {
      result.bundle_warnings.push({ id: bb.id ?? "(unknown)", error: (err as Error).message });
    }
  }

  // 4. User-authored field defs (idempotent on the unique key).
  for (const f of m.field_defs) {
    try {
      await meta
        .insertInto("module_field_defs")
        .values({
          org_id: orgId,
          entity_kind: f.entity_kind,
          name: f.name,
          display_label: f.display_label,
          type: f.type as never,
          required: f.required ?? false,
          position: f.position ?? 0,
          bundle_id: null,
          source_module: null,
          choices: f.choices ? (sql`${JSON.stringify(f.choices)}::jsonb` as unknown as string[]) : null,
          renderer: f.renderer ?? null,
          template: f.type === "computed" ? f.template ?? null : null,
          help: f.help ?? null,
        })
        .onConflict((c) => c.columns(["org_id", "entity_kind", "name"]).doNothing())
        .execute();
      result.created_field_defs++;
    } catch (err) {
      console.error(`[blueprint-install] field def ${f.entity_kind}.${f.name} failed:`, (err as Error).message);
    }
  }

  // 5. User-authored wires — skip an identical existing binding (idempotent).
  for (const w of m.wires) {
    try {
      const dup = await meta
        .selectFrom("entity_action_bindings")
        .select("id")
        .where("org_id", "=", orgId)
        .where("source_kind", "=", w.source_kind)
        .where("action_id", "=", w.action_id)
        .where("trigger_type", "=", w.trigger_type as never)
        .where("trigger_event", w.trigger_event ? "=" : "is", w.trigger_event ?? null)
        .where("bundle_id", "is", null)
        .where("source_module", "is", null)
        .executeTakeFirst();
      if (dup) continue;
      await meta
        .insertInto("entity_action_bindings")
        .values({
          org_id: orgId,
          source_kind: w.source_kind,
          action_id: w.action_id,
          trigger_type: w.trigger_type as never,
          trigger_event: w.trigger_event ?? null,
          trigger_schedule: w.trigger_schedule ?? null,
          template: w.template ?? null,
          filter: w.filter ? sql`${JSON.stringify(w.filter)}::jsonb` : null,
          args: w.args ? sql`${JSON.stringify(w.args)}::jsonb` : null,
          bundle_id: null,
          source_module: null,
          target: w.target ? sql`${JSON.stringify(w.target)}::jsonb` : sql`'"self"'::jsonb`,
        })
        .execute();
      result.created_wires++;
    } catch (err) {
      console.error(`[blueprint-install] wire ${w.source_kind}→${w.action_id} failed:`, (err as Error).message);
    }
  }

  // 6 + 7. Saved views + public surfaces into the tenant DB (best-effort,
  //        separate Postgres DB from cobblr_meta so no shared transaction).
  if (m.saved_views.length > 0 || m.public_surfaces.length > 0) {
    try {
      const tdb = (await getTenantDb(orgId)) as unknown as Kysely<BlueprintTenantDB>;
      // 6. Saved views — skip a same-(kind,name) view that already exists.
      const viewIdByName = new Map<string, string>();
      const existingViews = await tdb
        .selectFrom("core_views_views")
        .select(["id", "entity_kind", "name"])
        .execute();
      for (const ev of existingViews) viewIdByName.set(`${ev.entity_kind}\x00${ev.name}`, ev.id);
      for (const v of m.saved_views) {
        const key = `${v.entity_kind}\x00${v.name}`;
        if (viewIdByName.has(key)) continue;
        const row = await tdb
          .insertInto("core_views_views")
          .values({
            entity_kind: v.entity_kind,
            name: v.name,
            view_type: v.view_type,
            config: sql`${JSON.stringify(v.config)}::jsonb`,
            is_default: v.is_default ?? false,
            pinned: v.pinned ?? false,
            owner_user_id: null,
            bundle_id: null,
            source_module: null,
          } as never)
          .returning("id")
          .executeTakeFirst();
        if (row?.id) viewIdByName.set(key, row.id);
        result.created_saved_views++;
      }
      // 7. Public surfaces — resolve the view by name, mint a FRESH token
      //    (public slugs must never be shared across workspaces).
      for (const s of m.public_surfaces) {
        // The surface's view name is unique within an entity kind, but the
        // manifest doesn't carry the kind — match by name across kinds.
        let scopeId: string | undefined;
        for (const [key, id] of viewIdByName) {
          if (key.endsWith(`\x00${s.scope_view_name}`)) {
            scopeId = id;
            break;
          }
        }
        if (!scopeId) continue;
        await tdb
          .insertInto("core_public_surfaces_surfaces")
          .values({
            name: s.name,
            token: randomBytes(18).toString("base64url"),
            scope_type: s.scope_type,
            scope_id: scopeId,
            config: sql`${JSON.stringify(s.config)}::jsonb`,
            enabled: true,
            created_by: sess.id,
          } as never)
          .execute();
        result.created_public_surfaces++;
      }
    } catch (err) {
      console.error(`[blueprint-install] tenant-DB apply failed for ${orgId}:`, (err as Error).message);
    }
  }

  return result;
}

// ── Routes ───────────────────────────────────────────────────────────

// GET /export — the workspace's blueprint manifest.
blueprintRouter.get("/export", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const manifest = await captureBlueprint(req.tenant!.org.id);
    res.json({ manifest });
  } catch (err) {
    next(err);
  }
});

// POST /install — two-phase. confirm:false → 409 needs_consent with a plan;
// confirm:true → apply.
blueprintRouter.post("/install", requireAuth, withTenant, async (req, res, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const Body = z.object({ manifest: z.unknown(), confirm: z.boolean().optional() });
    const body = Body.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: { code: "invalid_blueprint", message: "Bad request body", details: body.error.issues } });
      return;
    }
    const parsed = BlueprintManifest.safeParse(body.data.manifest);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_blueprint", message: "Blueprint manifest failed validation", details: parsed.error.issues },
      });
      return;
    }
    const m = parsed.data;
    const orgId = req.tenant!.org.id;

    if (!body.data.confirm) {
      const plan = await planInstall(orgId, m);
      res.status(409).json({
        error: {
          code: "needs_consent",
          message:
            "This blueprint will enable modules, install bundles, and create views/surfaces in your workspace. Re-POST with confirm:true to proceed.",
          details: plan,
        },
      });
      return;
    }

    const sess = {
      id: req.session!.id,
      display_name: req.session!.display_name ?? null,
      auth_method: req.session!.auth_method,
      api_token_id: req.session!.api_token_id ?? null,
    };
    const applied = await applyBlueprint(orgId, sess, m);
    await activity.log({
      orgId,
      action: "blueprint_installed",
      ref: { module: null, entityType: "blueprint", entityId: m.id },
    });
    res.status(201).json({ blueprint: { id: m.id, name: m.name, version: m.version }, applied });
  } catch (err) {
    next(err);
  }
});
