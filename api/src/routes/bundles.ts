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
      z
        .object({
          source_kind: z.string(),
          action_id: z.string(),
          trigger_type: z
            .enum(["user-invoked", "event", "on-create", "on-update", "on-delete", "schedule"])
            .default("user-invoked"),
          trigger_event: z.string().optional(),
          // Q4: RRULE for schedule-triggered wires. Required when
          // trigger_type='schedule', ignored otherwise.
          trigger_schedule: z.string().optional(),
          template: z.string().optional(),
          filter: z.record(z.unknown()).optional(),
          args: z.record(z.unknown()).optional(),
          // Q1 wire target. Default "self" if omitted.
          // See docs/design-decisions/wires-and-bundles.md.
          target: z
            .union([
              z.literal("self"),
              z.object({
                rel: z.string().min(1),
                dir: z.enum(["in", "out"]).optional(),
                kind: z.string().optional(),
              }),
            ])
            .optional(),
        })
        .superRefine((data, ctx) => {
          // Same trigger / companion-field validation as the
          // /bindings POST endpoint. Catches bundle authoring bugs
          // at install time, with a clear path to the offending
          // wire's field.
          if (data.trigger_type === "event" && !data.trigger_event) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "trigger_event is required when trigger_type is 'event'",
              path: ["trigger_event"],
            });
          }
          if (data.trigger_type === "schedule" && !data.trigger_schedule) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                "trigger_schedule (an RRULE) is required when trigger_type is 'schedule'",
              path: ["trigger_schedule"],
            });
          }
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
        .select(["source_kind", "action_id", "trigger_type", "trigger_event", "template", "filter", "args", "target"])
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
          // Omit "self" from exports (it's the default; round-trip clean).
          // Object form serialises as-is.
          target:
            w.target && w.target !== "self" && typeof w.target === "object"
              ? (w.target as { rel: string; dir?: "in" | "out"; kind?: string })
              : undefined,
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
      // Q5 (wires-and-bundles.md): `requires` is now an "install" not
      // a "check." If the bundle needs modules the workspace doesn't
      // have enabled, return 409 with `needs_enable` instead of
      // auto-enabling silently. Caller re-POSTs with `confirm:true`
      // to proceed.
      const ManifestBody = z.object({
        manifest: BundleManifest,
        confirm: z.boolean().optional(),
      });
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
      // this org. Q5 resolution: if any required modules aren't
      // enabled, return 409 with `needs_enable: [...]` so the UI can
      // prompt the user. Caller re-POSTs with `confirm: true` to
      // proceed; that path then enables the missing modules (and
      // their transitive deps via enableModuleForOrg's own dep-check
      // loop) as part of the atomic install.
      //
      // If a required module isn't even *registered* with the
      // platform, we still fail loud immediately: that's a real
      // incompatibility, not a setup gap the user can resolve.
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
          // Fail early if any are unknown to the platform — that's
          // not user-resolvable.
          for (const name of missing) {
            if (!getEntry(name)) {
              res.status(400).json({
                error: {
                  code: "unknown_module",
                  message: `Bundle requires module '${name}' which isn't registered with this platform.`,
                  details: { missing_module: name },
                },
              });
              return;
            }
          }
          // Q5: needs_enable confirmation gate.
          if (!parsed.data.confirm) {
            res.status(409).json({
              error: {
                code: "needs_enable",
                message: `This bundle requires module(s) not enabled in your workspace: ${missing.join(", ")}. Re-POST with confirm:true to enable and install in one step.`,
                details: { needs_enable: missing },
              },
            });
            return;
          }
          // Confirmed: enable the missing modules in dependency order
          // (parents before children: machines before 3d-printers).
          const ordered = [...missing].sort((a, b) => {
            const ea = getEntry(a);
            const eb = getEntry(b);
            return (ea?.manifest.dependencies.length ?? 0) - (eb?.manifest.dependencies.length ?? 0);
          });
          for (const name of ordered) {
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

      // Q6 (wires-and-bundles.md): pre-check field-def collisions.
      // Field defs are storage-level (one column-name per entity kind);
      // two different bundles trying to add the same (entity_kind, name)
      // is genuinely ambiguous. Fail loud with the collision list so
      // the user can uninstall the conflicting bundle first.
      //
      // This runs AFTER the existing-version uninstall above, so a
      // bundle that defines `set_id` and then ships v2 also defining
      // `set_id` doesn't trip itself up.
      if (m.field_defs.length > 0) {
        const conflicts = await meta
          .selectFrom("module_field_defs")
          .select(["entity_kind", "name", "bundle_id", "source_module"])
          .where("org_id", "=", req.tenant!.org.id)
          .where((eb) =>
            eb.or(
              m.field_defs.map((f) =>
                eb.and([
                  eb("entity_kind", "=", f.entity_kind),
                  eb("name", "=", f.name),
                ]),
              ),
            ),
          )
          .execute();
        if (conflicts.length > 0) {
          // Resolve each collision to a human-readable owner so the
          // UI / user knows what's blocking the install.
          const ownerNames = new Map<string, string>();
          const bundleIds = conflicts
            .map((c) => c.bundle_id)
            .filter((b): b is string => !!b);
          if (bundleIds.length > 0) {
            const bundleRows = await meta
              .selectFrom("bundles")
              .select(["id", "name"])
              .where("id", "in", bundleIds)
              .execute();
            for (const b of bundleRows) ownerNames.set(b.id, b.name);
          }
          const details = conflicts.map((c) => ({
            entity_kind: c.entity_kind,
            field_name: c.name,
            owned_by: c.bundle_id
              ? `bundle:${ownerNames.get(c.bundle_id) ?? c.bundle_id}`
              : c.source_module
                ? `module:${c.source_module}`
                : "user-authored",
          }));
          res.status(409).json({
            error: {
              code: "field_def_collision",
              message: `Bundle adds field def(s) that already exist in this workspace: ${details
                .map((d) => `${d.entity_kind}.${d.field_name} (${d.owned_by})`)
                .join(", ")}. Uninstall the conflicting bundle/module or remove the user-authored field first.`,
              details: { conflicts: details },
            },
          });
          return;
        }
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
              trigger_schedule: w.trigger_schedule ?? null,
              template: w.template ?? null,
              filter: w.filter ? sql`${JSON.stringify(w.filter)}::jsonb` : null,
              args: w.args ? sql`${JSON.stringify(w.args)}::jsonb` : null,
              bundle_id: bundle.id,
              target: w.target
                ? sql`${JSON.stringify(w.target)}::jsonb`
                : sql`'"self"'::jsonb`,
            })
            .execute();
        }
        for (const f of m.field_defs) {
          // Q6: collisions were pre-checked above and the install
          // would have already failed with 409 field_def_collision.
          // Plain insert; the unique constraint will surface any
          // unexpected races as a 500 (and the transaction rolls
          // back).
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
