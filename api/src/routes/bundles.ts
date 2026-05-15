// Bundles — publishable artifacts that bundle multiple wires +
// field defs into one install. Phase 4 C.2: export current org
// state, import + apply a bundle, uninstall cleanly.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import * as activity from "../platform/activity.js";
import { enableModuleForOrg } from "../modules/enable.js";
import { getEntry } from "../modules/registry.js";

export const bundlesRouter = Router({ mergeParams: true });

const BundleManifest = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  requires: z
    .array(z.object({ module: z.string(), version: z.string().optional() }))
    .default([]),
  wires: z
    .array(
      z.object({
        source_kind: z.string(),
        action_id: z.string(),
        trigger_type: z
          .enum(["user-invoked", "event", "on-create", "on-update", "on-delete"])
          .default("user-invoked"),
        trigger_event: z.string().optional(),
        template: z.string().optional(),
        filter: z.record(z.unknown()).optional(),
        args: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
  field_defs: z
    .array(
      z.object({
        entity_kind: z.string(),
        name: z.string().regex(/^[a-z][a-z0-9_]*$/),
        display_label: z.string(),
        type: z.enum(["text", "number", "boolean", "date", "url"]),
        required: z.boolean().optional(),
        position: z.number().int().optional(),
      }),
    )
    .default([]),
});

type BundleManifestT = z.infer<typeof BundleManifest>;

bundlesRouter.get(
  "/",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const rows = await meta
        .selectFrom("bundles")
        .select(["id", "external_id", "name", "version", "author", "description", "source_url", "installed_at"])
        .where("org_id", "=", req.tenant!.org.id)
        .orderBy("installed_at", "desc")
        .execute();
      res.json({ items: rows });
    } catch (err) {
      next(err);
    }
  },
);

// Export the org's current state as a bundle manifest. Pulls wires
// and field defs not already owned by an installed bundle (those
// would re-install on import anyway), so the export is a snapshot
// of the *user's own* customisations.
bundlesRouter.get(
  "/export",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const orgId = req.tenant!.org.id;
      // Exclude module-contributed rows (source_module set) — those
      // re-appear automatically when the bundle's `requires` modules
      // are enabled, and including them here would create duplicates
      // on install. The export is the user's own customisations only.
      const wires = await meta
        .selectFrom("entity_action_bindings")
        .select(["source_kind", "action_id", "trigger_type", "trigger_event", "template", "filter", "args"])
        .where("org_id", "=", orgId)
        .where("bundle_id", "is", null)
        .where("source_module", "is", null)
        .where("enabled", "=", true)
        .execute();
      const fieldDefs = await meta
        .selectFrom("module_field_defs")
        .select(["entity_kind", "name", "display_label", "type", "required", "position"])
        .where("org_id", "=", orgId)
        .where("bundle_id", "is", null)
        .where("source_module", "is", null)
        .orderBy("entity_kind")
        .orderBy("position")
        .execute();
      const installedModules = await meta
        .selectFrom("org_modules")
        .select("module_name")
        .where("org_id", "=", orgId)
        .execute();

      // requires set = modules referenced by any exported wire's
      // kind/action. Keeps the manifest re-installable on a fresh
      // org without bringing the user's whole module set along.
      const referencedModules = new Set<string>();
      for (const w of wires) {
        const srcMod = w.source_kind.split(":")[0];
        const actMod = w.action_id.split(":")[0];
        if (srcMod) referencedModules.add(srcMod);
        if (actMod) referencedModules.add(actMod);
      }
      for (const f of fieldDefs) {
        const m = f.entity_kind.split(":")[0];
        if (m) referencedModules.add(m);
      }
      const requires = installedModules
        .filter((m) => referencedModules.has(m.module_name))
        .map((m) => ({ module: m.module_name }));

      const orgRow = await meta
        .selectFrom("orgs")
        .select(["name", "slug"])
        .where("id", "=", orgId)
        .executeTakeFirstOrThrow();
      const stamp = new Date().toISOString().slice(0, 10);
      const manifest = {
        id: `cobblr.export.${orgRow.slug}.${stamp}`,
        version: stamp,
        name: `${orgRow.name} — exported ${stamp}`,
        description: `Wires + field defs exported from ${orgRow.name}. Re-installable on any org with the same modules enabled.`,
        author: orgRow.name,
        requires,
        wires: wires.map((w) => ({
          source_kind: w.source_kind,
          action_id: w.action_id,
          trigger_type: w.trigger_type,
          trigger_event: w.trigger_event ?? undefined,
          template: w.template ?? undefined,
          filter: w.filter ?? undefined,
          args: w.args ?? undefined,
        })),
        field_defs: fieldDefs.map((f) => ({
          entity_kind: f.entity_kind,
          name: f.name,
          display_label: f.display_label,
          type: f.type,
          required: f.required,
          position: f.position,
        })),
      };
      res.json({ manifest });
    } catch (err) {
      next(err);
    }
  },
);

// Single-bundle detail with its installed wires + field defs.
bundlesRouter.get(
  "/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const bundle = await meta
        .selectFrom("bundles")
        .selectAll()
        .where("id", "=", id)
        .where("org_id", "=", req.tenant!.org.id)
        .executeTakeFirst();
      if (!bundle) {
        res.status(404).json({ error: { code: "not_found", message: "bundle not found" } });
        return;
      }
      const wires = await meta
        .selectFrom("entity_action_bindings")
        .selectAll()
        .where("bundle_id", "=", id)
        .execute();
      const fieldDefs = await meta
        .selectFrom("module_field_defs")
        .selectAll()
        .where("bundle_id", "=", id)
        .orderBy("entity_kind")
        .orderBy("position")
        .execute();
      res.json({ bundle, wires, field_defs: fieldDefs });
    } catch (err) {
      next(err);
    }
  },
);

bundlesRouter.post(
  "/install",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const ManifestBody = z.object({ manifest: BundleManifest });
      const parsed = ManifestBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: "invalid_bundle",
            message: "Bundle manifest failed validation",
            details: parsed.error.issues,
          },
        });
        return;
      }
      const m: BundleManifestT = parsed.data.manifest;

      // Compatibility — every required module must be enabled for
      // this org. Auto-enable any missing ones (and their transitive
      // deps via enableModuleForOrg's own dep-check loop) so a fresh
      // org can install a bundle in one shot. If a required module
      // isn't even *registered* with the platform we still fail
      // loud: that's a real incompatibility, not a setup gap.
      const required = m.requires.map((r) => r.module);
      const autoEnabled: string[] = [];
      if (required.length > 0) {
        const installed = await meta
          .selectFrom("org_modules")
          .select("module_name")
          .where("org_id", "=", req.tenant!.org.id)
          .where("module_name", "in", required)
          .execute();
        const installedSet = new Set(installed.map((r) => r.module_name));
        const missing = required.filter((r) => !installedSet.has(r));
        if (missing.length > 0) {
          // Sort missing topologically by dependency depth so we
          // enable parents before children (machines before 3d-printers).
          const ordered = [...missing].sort((a, b) => {
            const ea = getEntry(a);
            const eb = getEntry(b);
            return (ea?.manifest.dependencies.length ?? 0) - (eb?.manifest.dependencies.length ?? 0);
          });
          for (const name of ordered) {
            if (!getEntry(name)) {
              res.status(400).json({
                error: {
                  code: "unknown_module",
                  message: `Bundle requires module '${name}' which isn't registered with this platform.`,
                },
              });
              return;
            }
            await enableModuleForOrg(req.tenant!.org.id, name, { userId: req.session!.id });
            autoEnabled.push(name);
          }
        }
      }

      // Already installed (same external_id + version)? Idempotent
      // re-install removes the old set and applies the new.
      const existing = await meta
        .selectFrom("bundles")
        .select("id")
        .where("org_id", "=", req.tenant!.org.id)
        .where("external_id", "=", m.id)
        .where("version", "=", m.version)
        .executeTakeFirst();
      if (existing) {
        await uninstallBundleId(existing.id);
      }

      const inserted = await meta.transaction().execute(async (trx) => {
        const bundle = await trx
          .insertInto("bundles")
          .values({
            org_id: req.tenant!.org.id,
            external_id: m.id,
            name: m.name,
            version: m.version,
            author: m.author ?? null,
            description: m.description ?? null,
            source_url: null,
            manifest: sql`${JSON.stringify(m)}::jsonb`,
          })
          .returning(["id", "external_id", "name", "version"])
          .executeTakeFirstOrThrow();

        for (const w of m.wires) {
          await trx
            .insertInto("entity_action_bindings")
            .values({
              org_id: req.tenant!.org.id,
              source_kind: w.source_kind,
              action_id: w.action_id,
              trigger_type: w.trigger_type,
              trigger_event: w.trigger_event ?? null,
              template: w.template ?? null,
              filter: w.filter ? sql`${JSON.stringify(w.filter)}::jsonb` : null,
              args: w.args ? sql`${JSON.stringify(w.args)}::jsonb` : null,
              bundle_id: bundle.id,
            })
            .execute();
        }
        for (const f of m.field_defs) {
          await trx
            .insertInto("module_field_defs")
            .values({
              org_id: req.tenant!.org.id,
              entity_kind: f.entity_kind,
              name: f.name,
              display_label: f.display_label,
              type: f.type,
              required: f.required ?? false,
              position: f.position ?? 0,
              bundle_id: bundle.id,
            })
            .onConflict((b) => b.columns(["org_id", "entity_kind", "name"]).doNothing())
            .execute();
        }
        return bundle;
      });

      await activity.log({
        orgId: req.tenant!.org.id,
        action: "bundle_installed",
        ref: { module: null, entityType: "bundle", entityId: inserted.id },
        diff: {
          external_id: m.id,
          version: m.version,
          name: m.name,
          wires: m.wires.length,
          field_defs: m.field_defs.length,
        },
      });
      res.status(201).json({
        bundle: inserted,
        applied: {
          wires: m.wires.length,
          field_defs: m.field_defs.length,
          auto_enabled_modules: autoEnabled,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

bundlesRouter.delete(
  "/:id",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const bundle = await meta
        .selectFrom("bundles")
        .select("id")
        .where("id", "=", id)
        .where("org_id", "=", req.tenant!.org.id)
        .executeTakeFirst();
      if (!bundle) {
        res.status(404).json({ error: { code: "not_found", message: "bundle not found" } });
        return;
      }
      await uninstallBundleId(bundle.id);
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "bundle_uninstalled",
        ref: { module: null, entityType: "bundle", entityId: bundle.id },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

async function uninstallBundleId(bundleId: string): Promise<void> {
  // FKs on bindings + field_defs have ON DELETE SET NULL for bundle_id,
  // but we want full uninstall — remove the artifacts the bundle
  // created, then the bundle row.
  await meta.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("entity_action_bindings")
      .where("bundle_id", "=", bundleId)
      .execute();
    await trx
      .deleteFrom("module_field_defs")
      .where("bundle_id", "=", bundleId)
      .execute();
    await trx
      .deleteFrom("bundles")
      .where("id", "=", bundleId)
      .execute();
  });
}
