// Bundles — publishable artifacts that bundle multiple wires +
// field defs into one install. Phase 4 C.2: export current org
// state, import + apply a bundle, uninstall cleanly.

import { Router } from "express";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as activity from "../platform/activity.js";
import { enableModuleForOrg } from "../modules/enable.js";
import { getEntry } from "../modules/registry.js";
import { upsertOverride, deleteOverride } from "../platform/entity-kind-overrides.js";

// Cross-module table type for the tenant-DB writes. core-views owns
// `core_views_views`; bundles install rows into it tagged with
// bundle_id. We declare the minimal columns we touch — the full
// schema is in modules/core-views/src/db.ts (ViewsTable).
interface CoreViewsViewsRow {
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
// core-catalogs lives in the same tenant DB. Bundles can ship catalog
// shells (definition + schema, no rows) tagged by bundle_external_id
// so uninstall can find them.
interface CoreCatalogsCatalogsRow {
  id: string;
  name: string;
  description: string | null;
  source_url: string | null;
  puller_id: string | null;
  schema: unknown;
  last_sync_at: Date | null;
  entry_count: number;
  bundle_external_id: string | null;
  created_at: Date;
  updated_at: Date;
}
interface BundleTenantDB {
  core_views_views: CoreViewsViewsRow;
  core_catalogs_catalogs: CoreCatalogsCatalogsRow;
}

export const bundlesRouter = Router({ mergeParams: true });

export const BundleManifest = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  /** v1.5: long-form walkthrough rendered on the bundle's detail page.
   *  Markdown. The short `description` field still appears in lists +
   *  install confirmations; `readme_md` is for the "here's how I use
   *  this bundle in practice" narrative. Free-form length — sensible
   *  authors keep it under a few thousand chars; the platform doesn't
   *  enforce a cap. */
  readme_md: z.string().optional(),
  /** v1.5: image URLs (or file:// paths inside the manifest delivery
   *  archive when a directory ships a sidecar) that render as a
   *  screenshot strip on the bundle detail page. Order = display
   *  order. Treated as URLs verbatim — no embedding, no inlining;
   *  bundle authors host the images wherever. */
  screenshots: z.array(z.string().min(1)).optional(),
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
        /** When type='text', renders as a dropdown of these choices. */
        choices: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  /** v1.5 (wires-and-bundles.md Q5, alt 3): bundle ships saved views.
   *  The "skin over a generic module" framing — a Lego bundle wants
   *  to ship not just custom field defs but also "see them grouped
   *  by theme, filtered to low-stock" as a default view.
   *
   *  Each entry creates a row in core_views_views tagged with the
   *  bundle's id; uninstall removes them, the user can edit them
   *  freely while installed (edits stick across re-install since the
   *  install path is upsert-by-(bundle_id, name, entity_kind)). */
  saved_views: z
    .array(
      z.object({
        entity_kind: z.string(),
        name: z.string().min(1),
        view_type: z.string().min(1).default("list"),
        config: z.record(z.unknown()).default({}),
        /** Pin this view to the dashboard on install. */
        pinned: z.boolean().optional(),
        /** Mark as default-for-entity-kind on install. The same
         *  unique-default guard the views API enforces applies. */
        is_default: z.boolean().optional(),
      }),
    )
    .default([]),
  /** Bundles can ship catalog SHELLS — name + schema config, no
   *  rows. Used so a "Rebrickable Lego" bundle can install the six
   *  catalogs with their hero_field / image_column / field_renderer
   *  config in one click, then the rows get loaded via the CSV
   *  importer (or a puller, when those exist).
   *
   *  Rows are intentionally NOT in the manifest: 60k-row CSVs would
   *  blow past the express body limit and make installs synchronous-
   *  multi-second. Bundle authors point users at the row import
   *  separately. */
  catalogs: z
    .array(
      z.object({
        /** Stable id within the bundle (e.g. "rebrickable-colors").
         *  Used to find this catalog on uninstall + on re-install
         *  for in-place schema updates. */
        external_id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
        name: z.string().min(1),
        description: z.string().optional(),
        source_url: z.string().optional(),
        puller_id: z.string().optional(),
        schema: z
          .object({
            id_column: z.string().optional(),
            title_column: z.string().optional(),
            image_column: z.string().optional(),
            subtitle_column: z.string().optional(),
            description_column: z.string().optional(),
            field_renderers: z
              .record(
                z.enum(["text", "color-hex", "image-url", "url-link", "year", "boolean", "code"]),
              )
              .optional(),
            field_labels: z.record(z.string()).optional(),
            bindable_to_kinds: z.array(z.string()).optional(),
            semantic_type: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).optional(),
            hero_field: z.string().optional(),
            hero_renderer: z
              .enum(["text", "color-hex", "image-url", "url-link", "year", "boolean", "code"])
              .optional(),
          })
          .default({}),
      }),
    )
    .default([]),
  /** Optional lens contribution — turns this bundle into a Pillar-E-
   *  style specialisation. The nav reads installed bundles with
   *  provides_lens to render the parent-module's popover and the
   *  lens filter on the parent's list page. Replaces the previous
   *  pattern of declaring a Pillar-E module with `dependencies:
   *  ["machines"]`. */
  provides_lens: z
    .object({
      /** What kind this lens narrows. e.g. "machines:machine" */
      entity_kind: z.string(),
      /** Slug used in URLs like /machines?lens=3d-printers. */
      // Lens slug used in URLs like /machines?lens=3d-printers. Allow
      // leading digit so domain-natural names (3d-printers, 2d-cad,
      // 4-axis-cnc) work without ugly renames.
      name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/),
      /** Human label rendered in the popover + chip. */
      display_name: z.string(),
      /** v1.6 (lens-promotion.md §1.1): formalises the "rows belonging
       *  to me match this filter" predicate. Today companion app lens
       *  bundles use `metadata.category` informally; this makes it
       *  explicit. */
      discriminator: z
        .object({
          field: z.string().min(1),
          value: z.union([z.string(), z.number(), z.boolean()]),
        })
        .optional(),
      /** v1.6 (lens-promotion.md §1.3): promote the lens to a peer of
       *  the parent kind in the nav (instead of nesting beneath it). */
      presents_as_top_level: z.boolean().optional(),
      /** v1.6: when set + presents_as_top_level=true, the parent
       *  entity kind itself is hidden from the workspace's nav. The
       *  workspace can flip this back on at /configuration/presentation. */
      hide_parent: z.boolean().optional(),
      /** v1.6: lucide icon name for the nav chip. */
      icon: z.string().optional(),
      /** v1.6: override the bundle's name when rendering the nav
       *  entry. Falls back to display_name. */
      label_override: z.string().optional(),
    })
    .optional(),
});

export type BundleManifestT = z.infer<typeof BundleManifest>;

// ── The single source of validation truth ──────────────────────────
// Pure (no writes): structural (zod) + referential (kinds/actions/
// requires exist + are applicable) + dependency (modules registered/
// enabled) + collision (field-def name clashes). Called by BOTH the
// install endpoint and the validate-only endpoint, so the manifest is
// graded exactly once way — no drift. Error messages are MODEL-REPAIRABLE:
// they name the bad id and list the valid ones, so a candidate from any
// model can be fed its own errors and fix itself (the kernel-owns-
// correctness gate from the ai-bundle-builder spec).
export interface BundleValidationError {
  path: string;
  code: string;
  message: string;
  detail?: unknown;
}
export interface BundleValidationPreview {
  fields_added: Array<{ entity_kind: string; name: string; type: string; display_label: string }>;
  wires_added: Array<{ source_kind: string; action_id: string; trigger_type: string }>;
  modules_required: string[];
  modules_to_enable: string[];
}
export interface BundleValidationResult {
  valid: boolean;
  errors: BundleValidationError[];
  preview: BundleValidationPreview | null;
  /** The parsed manifest when structural validation passed — so the
   *  install path doesn't re-parse. Undefined on structural failure. */
  manifest?: BundleManifestT;
}

const moduleOf = (id: string): string | null => (id.includes(":") ? (id.split(":")[0] ?? null) : null);

export async function validateBundle(
  orgId: string,
  rawManifest: unknown,
  opts: { autoEnable?: boolean } = {},
): Promise<BundleValidationResult> {
  // 1. Structural.
  const parsed = BundleManifest.safeParse(rawManifest);
  if (!parsed.success) {
    return {
      valid: false,
      preview: null,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join(".") || "<root>",
        code: "invalid_bundle",
        message: i.message,
      })),
    };
  }
  const m = parsed.data;
  const errors: BundleValidationError[] = [];

  // 2. Referential — every referenced kind/action exists + is applicable.
  const knownKinds = await platform().entities.listKinds();
  const knownKindIds = new Set(knownKinds.map((k) => k.id));
  const kindList = [...knownKindIds].sort().join(", ") || "(none)";

  for (const f of m.field_defs) {
    if (!knownKindIds.has(f.entity_kind)) {
      errors.push({
        path: "field_defs.entity_kind",
        code: "unknown_entity_kind",
        message: `Unknown entity kind "${f.entity_kind}". Use one of: ${kindList}.`,
      });
    }
  }

  // Actions applicable to each referenced source_kind (resolves appliesTo).
  const referencedKinds = new Set<string>([...m.wires.map((w) => w.source_kind)]);
  const actionsByKind = new Map<string, Set<string>>();
  for (const kind of referencedKinds) {
    if (!knownKindIds.has(kind)) continue;
    const apps = await platform().actions.listApplicable(kind, orgId);
    actionsByKind.set(kind, new Set(apps.map((a) => a.id)));
  }
  for (const w of m.wires) {
    if (!knownKindIds.has(w.source_kind)) {
      errors.push({
        path: "wires.source_kind",
        code: "unknown_entity_kind",
        message: `Unknown entity kind "${w.source_kind}" in a wire. Use one of: ${kindList}.`,
      });
      continue;
    }
    const applicable = actionsByKind.get(w.source_kind) ?? new Set<string>();
    if (!applicable.has(w.action_id)) {
      const list = [...applicable].sort().join(", ") || "(none)";
      errors.push({
        path: "wires.action_id",
        code: "action_not_applicable",
        message: `Action "${w.action_id}" can't be wired to "${w.source_kind}". Actions available for "${w.source_kind}": ${list}.`,
      });
    }
  }

  // requires[] must name the module owning every referenced kind + action.
  const declaredRequires = new Set(m.requires.map((r) => r.module));
  const neededModules = new Set<string>();
  for (const f of m.field_defs) { const mod = moduleOf(f.entity_kind); if (mod) neededModules.add(mod); }
  for (const w of m.wires) {
    const k = moduleOf(w.source_kind); if (k) neededModules.add(k);
    const a = moduleOf(w.action_id); if (a) neededModules.add(a);
  }
  for (const mod of neededModules) {
    if (!declaredRequires.has(mod)) {
      errors.push({
        path: "requires",
        code: "missing_requires_module",
        message: `requires[] is missing module "${mod}" — a referenced kind or action belongs to it. Add { "module": "${mod}" }.`,
      });
    }
  }

  // 3. Dependency — required modules must be registered, then enabled.
  const allRequired = [...new Set([...declaredRequires, ...neededModules])];
  const modulesToEnable: string[] = [];
  if (allRequired.length > 0) {
    const enabledRows = await meta
      .selectFrom("org_modules")
      .select("module_name")
      .where("org_id", "=", orgId)
      .where("module_name", "in", allRequired)
      .execute();
    const enabledSet = new Set(enabledRows.map((r) => r.module_name));
    for (const mod of allRequired) {
      if (enabledSet.has(mod)) continue;
      if (!getEntry(mod)) {
        errors.push({
          path: "requires",
          code: "unknown_module",
          message: `Bundle requires module "${mod}" which isn't registered with this platform.`,
          detail: { missing_module: mod },
        });
        continue;
      }
      modulesToEnable.push(mod);
      if (!opts.autoEnable) {
        errors.push({
          path: "requires",
          code: "needs_enable",
          message: `Module "${mod}" is required but not enabled in this workspace.`,
          detail: { module: mod },
        });
      }
    }
  }

  // 4. Collision — field_defs that duplicate an existing (entity_kind,
  //    name). A bundle re-installing its OWN previous version doesn't
  //    collide with itself (install replaces it), so exclude rows owned
  //    by a bundle sharing this manifest's external id.
  if (m.field_defs.length > 0) {
    const selfBundles = await meta
      .selectFrom("bundles")
      .select("id")
      .where("org_id", "=", orgId)
      .where("external_id", "=", m.id)
      .execute();
    const selfIds = new Set(selfBundles.map((b) => b.id));
    const conflicts = await meta
      .selectFrom("module_field_defs")
      .select(["entity_kind", "name", "bundle_id", "source_module"])
      .where("org_id", "=", orgId)
      .where((eb) =>
        eb.or(m.field_defs.map((f) => eb.and([eb("entity_kind", "=", f.entity_kind), eb("name", "=", f.name)]))),
      )
      .execute();
    for (const c of conflicts) {
      if (c.bundle_id && selfIds.has(c.bundle_id)) continue;
      const ownedBy = c.bundle_id ? "another-bundle" : c.source_module ? `module:${c.source_module}` : "user-authored";
      errors.push({
        path: "field_defs.name",
        code: "field_def_collision",
        message: `Field "${c.entity_kind}.${c.name}" already exists in this workspace (${ownedBy.replace("-", " ")}). Choose a different field name.`,
        detail: { entity_kind: c.entity_kind, field_name: c.name, owned_by: ownedBy },
      });
    }
  }

  const preview: BundleValidationPreview = {
    fields_added: m.field_defs.map((f) => ({ entity_kind: f.entity_kind, name: f.name, type: f.type, display_label: f.display_label })),
    wires_added: m.wires.map((w) => ({ source_kind: w.source_kind, action_id: w.action_id, trigger_type: w.trigger_type })),
    modules_required: [...declaredRequires],
    modules_to_enable: modulesToEnable,
  };
  return { valid: errors.length === 0, errors, preview, manifest: m };
}

bundlesRouter.get(
  "/",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const rows = await meta
        .selectFrom("bundles")
        .select([
          "id",
          "external_id",
          "name",
          "version",
          "author",
          "description",
          "source_url",
          "installed_at",
          // The full manifest is needed by the nav so it can read
          // `provides_lens` for lens-contributing bundles. Cheap
          // to ship since manifests are small.
          "manifest",
        ])
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

      // v1.5: saved views from core-views' tenant table. Same filter
      // as wires + field defs — bundle-owned and module-owned rows
      // are excluded since re-install re-creates them; we only export
      // the user-authored ones.
      let savedViews: Array<{
        entity_kind: string;
        name: string;
        view_type: string;
        config: unknown;
        pinned: boolean;
        is_default: boolean;
      }> = [];
      let userCatalogs: Array<{
        id: string;
        name: string;
        description: string | null;
        source_url: string | null;
        puller_id: string | null;
        schema: unknown;
      }> = [];
      try {
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<BundleTenantDB>;
        savedViews = await tdb
          .selectFrom("core_views_views")
          .select(["entity_kind", "name", "view_type", "config", "pinned", "is_default"])
          .where("bundle_id", "is", null)
          .where("source_module", "is", null)
          // Workspace-shared only — private (owner_user_id set) views
          // are personal to the exporter and shouldn't ride along.
          .where("owner_user_id", "is", null)
          .execute();
        // Catalogs the user created in this workspace (not installed
        // via a bundle). Definitions only — row data stays in place.
        userCatalogs = await tdb
          .selectFrom("core_catalogs_catalogs")
          .select(["id", "name", "description", "source_url", "puller_id", "schema"])
          .where("bundle_external_id", "is", null)
          .execute();
      } catch (err) {
        console.error(`[bundle-export] tenant DB fetch failed for ${orgId}:`, err);
        // Continue without views/catalogs — partial exports are still useful.
      }

      // requires set = modules referenced by any exported wire's
      // kind/action, field def's kind, or saved view's kind. Keeps
      // the manifest re-installable on a fresh org without bringing
      // the user's whole module set along.
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
      for (const v of savedViews) {
        const m = v.entity_kind.split(":")[0];
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
        saved_views: savedViews.map((v) => ({
          entity_kind: v.entity_kind,
          name: v.name,
          view_type: v.view_type,
          config: (v.config ?? {}) as Record<string, unknown>,
          pinned: v.pinned,
          is_default: v.is_default,
        })),
        catalogs: userCatalogs.map((c) => ({
          // Derive a stable external_id from name — kebab-cased, ascii.
          // Bundle re-install upserts on (bundle.id + this), so as long
          // as the user doesn't rename the catalog between exports, the
          // round-trip is stable.
          external_id: c.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, ""),
          name: c.name,
          description: c.description ?? undefined,
          source_url: c.source_url ?? undefined,
          puller_id: c.puller_id ?? undefined,
          schema: (c.schema ?? {}) as Record<string, unknown>,
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

// POST /bundles/validate — grade a manifest WITHOUT applying it. Runs
// the same validateBundle() gate as /install (single source of truth),
// so a candidate that validates here is guaranteed installable. Always
// 200; validity + repairable errors + a preview are in the body. Used by
// the authoring module's candidate flow and the BuildPage live preview.
bundlesRouter.post(
  "/validate",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const Body = z.object({ manifest: z.unknown(), autoEnable: z.boolean().optional() });
      const body = Body.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: body.error.issues } });
        return;
      }
      const result = await validateBundle(req.tenant!.org.id, body.data.manifest, { autoEnable: body.data.autoEnable ?? false });
      res.json({ valid: result.valid, errors: result.errors, preview: result.preview });
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
        manifest: z.unknown(),
        confirm: z.boolean().optional(),
      });
      const body = ManifestBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: { code: "invalid_bundle", message: "Bad request body", details: body.error.issues } });
        return;
      }
      const confirm = !!body.data.confirm;

      // SINGLE SOURCE OF VALIDATION TRUTH — same helper the /validate
      // endpoint + the authoring module use. autoEnable = confirm: when
      // confirmed, modules that need enabling are reported in
      // preview.modules_to_enable (not a needs_enable error) and enabled
      // below. The HTTP error codes below preserve the prior contract the
      // bundle-install UI depends on.
      const v = await validateBundle(req.tenant!.org.id, body.data.manifest, { autoEnable: confirm });
      if (!v.valid) {
        const unknownModule = v.errors.find((e) => e.code === "unknown_module");
        if (unknownModule) {
          res.status(400).json({ error: { code: "unknown_module", message: unknownModule.message, details: unknownModule.detail } });
          return;
        }
        const needsEnable = v.errors.filter((e) => e.code === "needs_enable");
        if (needsEnable.length > 0) {
          const mods = needsEnable.map((e) => (e.detail as { module: string }).module);
          res.status(409).json({
            error: {
              code: "needs_enable",
              message: `This bundle requires module(s) not enabled in your workspace: ${mods.join(", ")}. Re-POST with confirm:true to enable and install in one step.`,
              details: { needs_enable: mods },
            },
          });
          return;
        }
        const collisions = v.errors.filter((e) => e.code === "field_def_collision");
        if (collisions.length > 0) {
          res.status(409).json({
            error: {
              code: "field_def_collision",
              message: collisions.map((e) => e.message).join(" "),
              details: { conflicts: collisions.map((e) => e.detail) },
            },
          });
          return;
        }
        res.status(400).json({ error: { code: "invalid_bundle", message: "Bundle manifest failed validation", details: { errors: v.errors } } });
        return;
      }
      const m = v.manifest!;

      // Confirmed path: enable the modules that need enabling, parents
      // before children (dependency order).
      const autoEnabled: string[] = [];
      const toEnable = [...(v.preview?.modules_to_enable ?? [])].sort(
        (a, b) => (getEntry(a)?.manifest.dependencies.length ?? 0) - (getEntry(b)?.manifest.dependencies.length ?? 0),
      );
      for (const name of toEnable) {
        await enableModuleForOrg(req.tenant!.org.id, name, { userId: req.session!.id });
        autoEnabled.push(name);
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

      // (Field-def collisions are checked inside validateBundle above.)

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
              // Propagate dropdown choices when the bundle supplies
              // them — Pillar-E specialisation bundles use this for
              // hotend / firmware / spindle etc.
              choices: f.choices
                ? (sql`${JSON.stringify(f.choices)}::jsonb` as unknown as string[])
                : null,
              renderer: (f as { renderer?: string | null }).renderer ?? null,
            })
            .execute();
        }
        return bundle;
      });

      // v1.6: bundle catalogs land in the tenant DB too (core-catalogs
      // module). Same pattern as saved_views: separate DB → can't share
      // the meta transaction. Upsert by (bundle_external_id,
      // external_id_within_bundle) — re-install refreshes the schema
      // config in place, rows survive.
      let catalogsInstalled = 0;
      if (m.catalogs.length > 0) {
        try {
          const tdb = (await getTenantDb(req.tenant!.org.id)) as unknown as Kysely<BundleTenantDB>;
          for (const c of m.catalogs) {
            const existing = await tdb
              .selectFrom("core_catalogs_catalogs")
              .select("id")
              .where("bundle_external_id", "=", `${m.id}/${c.external_id}`)
              .executeTakeFirst();
            if (existing) {
              await tdb
                .updateTable("core_catalogs_catalogs")
                .set({
                  name: c.name,
                  description: c.description ?? null,
                  source_url: c.source_url ?? null,
                  puller_id: c.puller_id ?? null,
                  schema: sql`${JSON.stringify(c.schema)}::jsonb`,
                  updated_at: new Date(),
                })
                .where("id", "=", existing.id)
                .execute();
            } else {
              await tdb
                .insertInto("core_catalogs_catalogs")
                .values({
                  name: c.name,
                  description: c.description ?? null,
                  source_url: c.source_url ?? null,
                  puller_id: c.puller_id ?? null,
                  schema: sql`${JSON.stringify(c.schema)}::jsonb`,
                  bundle_external_id: `${m.id}/${c.external_id}`,
                } as never)
                .execute();
            }
            catalogsInstalled++;
          }
        } catch (err) {
          console.error(
            `[bundle-install] catalogs insert failed for bundle ${inserted.id} (${inserted.external_id}):`,
            err,
          );
          // B2 from 2026-05-25-audit: don't fail the whole install;
          // mark partial + return a warning. The bundle row stays in
          // place + the workspace admin sees the partial state in the
          // bundles list. Re-install fixes it.
          await meta
            .updateTable("bundles")
            .set({
              install_status: "partial",
              install_warnings: sql`${JSON.stringify([
                {
                  step: "catalogs",
                  failed_count: m.catalogs.length - catalogsInstalled,
                  message: (err as Error).message,
                },
              ])}::jsonb` as never,
            })
            .where("id", "=", inserted.id)
            .execute();
        }
      }

      // v1.5: bundle saved_views land in core-views' tenant table,
      // which lives in a different Postgres DB from cobblr_meta. We
      // can't extend the meta transaction across DBs, so this runs
      // as a follow-up step. If it fails, the bundle is "installed"
      // (meta side) but missing its views — the user can re-install
      // (the existing-version uninstall path cleans up first) to
      // recover. Logged loud so the partial state is visible.
      let viewsInstalled = 0;
      if (m.saved_views.length > 0) {
        try {
          const tdb = (await getTenantDb(req.tenant!.org.id)) as unknown as Kysely<BundleTenantDB>;
          for (const v of m.saved_views) {
            await tdb
              .insertInto("core_views_views")
              .values({
                entity_kind: v.entity_kind,
                name: v.name,
                view_type: v.view_type,
                config: sql`${JSON.stringify(v.config)}::jsonb`,
                is_default: v.is_default ?? false,
                pinned: v.pinned ?? false,
                owner_user_id: null,
                bundle_id: inserted.id,
                source_module: null,
              } as never)
              .execute();
            viewsInstalled++;
          }
        } catch (err) {
          console.error(
            `[bundle-install] saved_views insert failed for bundle ${inserted.id} (${inserted.external_id}):`,
            err,
          );
          // B2: same pattern as the catalogs path — mark partial,
          // return success-ish with a warning. Re-install to recover.
          await meta
            .updateTable("bundles")
            .set({
              install_status: "partial",
              install_warnings: sql`coalesce(install_warnings, '[]'::jsonb) || ${JSON.stringify([
                {
                  step: "saved_views",
                  failed_count: m.saved_views.length - viewsInstalled,
                  message: (err as Error).message,
                },
              ])}::jsonb` as never,
            })
            .where("id", "=", inserted.id)
            .execute();
        }
      }

      // v1.6 (lens-promotion.md §1.3): if the bundle declares
       // provides_lens, write initial entity_kind_overrides rows so the
       // nav / breadcrumbs / search-chips render the bundle as a
       // top-level item with its chosen label + icon. Workspace edits
       // trump these defaults; insertOnly=true means a re-install
       // doesn't clobber a workspace's customisation.
      if (m.provides_lens) {
        const lens = m.provides_lens;
        try {
          await upsertOverride({
            orgId: req.tenant!.org.id,
            targetKind: "bundle",
            targetId: m.id,
            displayLabel: lens.label_override ?? lens.display_name,
            icon: lens.icon ?? null,
            insertOnly: true,
            config: {
              presents_as_top_level: lens.presents_as_top_level === true,
              parent_kind: lens.entity_kind,
              lens_slug: lens.name,
            },
          });
          if (lens.hide_parent) {
            // Parent kind gets a hidden=true override, scoped to
            // target_kind='entity_kind'. Workspace can flip back on at
            // /configuration/presentation.
            await upsertOverride({
              orgId: req.tenant!.org.id,
              targetKind: "entity_kind",
              targetId: lens.entity_kind,
              hidden: true,
              insertOnly: true,
            });
          }
        } catch (err) {
          console.error(
            `[bundle-install] lens override seed failed for ${inserted.id} (${inserted.external_id}):`,
            err,
          );
          // Continue — overrides are presentation, not data. Re-install
          // recovers.
        }
      }

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
          saved_views: viewsInstalled,
          catalogs: catalogsInstalled,
        },
      });
      res.status(201).json({
        bundle: inserted,
        applied: {
          wires: m.wires.length,
          field_defs: m.field_defs.length,
          catalogs: catalogsInstalled,
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
  // v1.5: bundles can also have installed saved views in the
  // tenant DB. Delete those FIRST (so they're gone whether or not
  // the meta-side delete succeeds), then drop the meta-side rows
  // in a transaction.
  const bundleRow = await meta
    .selectFrom("bundles")
    .select(["org_id", "external_id"])
    .where("id", "=", bundleId)
    .executeTakeFirst();
  if (bundleRow) {
    try {
      const tdb = (await getTenantDb(bundleRow.org_id)) as unknown as Kysely<BundleTenantDB>;
      await tdb
        .deleteFrom("core_views_views")
        .where("bundle_id", "=", bundleId)
        .execute();
    } catch (err) {
      console.error(
        `[bundle-uninstall] saved_views cleanup failed for bundle ${bundleId}:`,
        err,
      );
      // Continue — orphaned views are a smaller problem than a
      // half-uninstalled bundle row in meta.
    }
    // v1.6: drop catalogs whose bundle_external_id starts with
    // "<bundle-id>/" (the install prefix we wrote). Rows in
    // core_catalogs_entries cascade via the FK. This DOES delete
    // user-imported rows — same as bundle uninstall removing
    // user-edited field defs. Re-install restores the catalog shells
    // but not the rows.
    try {
      const tdb = (await getTenantDb(bundleRow.org_id)) as unknown as Kysely<BundleTenantDB>;
      await tdb
        .deleteFrom("core_catalogs_catalogs")
        .where("bundle_external_id", "like", `${bundleRow.external_id}/%`)
        .execute();
    } catch (err) {
      console.error(
        `[bundle-uninstall] catalogs cleanup failed for bundle ${bundleId}:`,
        err,
      );
    }
    // v1.6: lens override rows scoped to this bundle. Best-effort —
    // workspace edits to a bundle's row are also blown away here, but
    // re-install re-seeds them so the loss is recoverable. Don't
    // touch entity_kind override rows (those may be user-authored
    // for the parent kind regardless of which bundle set them).
    try {
      await deleteOverride(bundleRow.org_id, "bundle", bundleRow.external_id);
    } catch (err) {
      console.error(
        `[bundle-uninstall] override cleanup failed for ${bundleRow.external_id}:`,
        err,
      );
    }
  }
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
