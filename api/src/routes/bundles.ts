// Bundles — publishable artifacts that bundle multiple wires +
// field defs into one install. Phase 4 C.2: export current org
// state, import + apply a bundle, uninstall cleanly.

import { Router } from "express";
import { trackProductEvent } from "../platform/product-events.js";
import { parseWireFilter } from "../platform/wire-filter.js";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as activity from "../platform/activity.js";
import { enableModuleForOrg } from "../modules/enable.js";
import { getEntry } from "../modules/registry.js";
import { upsertOverride, deleteOverride } from "../platform/entity-kind-overrides.js";
import { createInstance, getInstance } from "../platform/instances.js";
import { listNavHeadings, createNavHeading, addNavMember } from "../platform/nav-headings.js";
import { tearDownInstance, countInstanceItems } from "../platform/instances.js";
import { disableModuleForOrg } from "../modules/enable.js";
import {
  recordClaims,
  removeClaimsForSource,
  claimsForSource,
  countClaimsFor,
} from "../platform/bundle-claims.js";

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
// core-apps lives in the same tenant DB. Bundles can seed WorkspaceApps
// (e.g. the Outfit Planner) idempotently on install.
interface CoreAppsAppsRow {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  visible_capability: string | null;
  pages: unknown;
  theme: unknown | null;
  created_by: string | null;
}
interface BundleTenantDB {
  core_views_views: CoreViewsViewsRow;
  core_catalogs_catalogs: CoreCatalogsCatalogsRow;
  core_apps_apps: CoreAppsAppsRow;
}

export const bundlesRouter = Router({ mergeParams: true });

// ── Reusable element schemas — used by the manifest BASE arrays and, Phase 2,
// by each optional feature's same-shaped arrays. ──────────────────────────────
const RequireEntry = z.object({ module: z.string(), version: z.string().optional() });

const WireEntry = z
  .object({
    source_kind: z.string(),
    action_id: z.string(),
    trigger_type: z
      .enum(["user-invoked", "event", "on-create", "on-update", "on-delete", "schedule"])
      .default("user-invoked"),
    trigger_event: z.string().optional(),
    trigger_schedule: z.string().optional(),
    template: z.string().optional(),
    filter: z.record(z.unknown()).optional(),
    args: z.record(z.unknown()).optional(),
    target: z
      .union([
        z.literal("self"),
        z.literal("none"),
        z.object({ rel: z.string().min(1), dir: z.enum(["in", "out"]).optional(), kind: z.string().optional() }),
      ])
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.trigger_type === "event" && !data.trigger_event) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "trigger_event is required when trigger_type is 'event'", path: ["trigger_event"] });
    }
    if (data.trigger_type === "schedule" && !data.trigger_schedule) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "trigger_schedule (an RRULE) is required when trigger_type is 'schedule'", path: ["trigger_schedule"] });
    }
  });

const FieldDefEntry = z
  .object({
    entity_kind: z.string(),
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    display_label: z.string(),
    type: z.enum(["text", "number", "boolean", "date", "url", "computed"]),
    required: z.boolean().optional(),
    position: z.number().int().optional(),
    choices: z.array(z.string()).optional(),
    renderer: z.string().optional(),
    template: z.string().max(2000).optional(),
    /** Plain-language one-line hint shown under the input ("the maker's named
     *  shade — e.g. 'Peacock Heather'") so jargon fields explain themselves. */
    help: z.string().max(280).optional(),
    /** The unit a type='number' value is measured in ("mm", "g") — free text,
     *  resolved against the units vocabulary at render/consume time. Declares
     *  physical semantics (a length-category unit IS a length), never derived
     *  from the field's name. */
    unit: z.string().trim().min(1).max(40).nullish(),
  })
  .refine((f) => f.type !== "computed" || (f.template && f.template.trim().length > 0), {
    message: "computed field_defs need a template",
    path: ["template"],
  })
  .refine((f) => !f.unit || f.type === "number", {
    message: "unit is only valid for type='number'",
    path: ["unit"],
  });

const FieldOverrideEntry = z.object({
  entity_kind: z.string(),
  name: z.string(),
  display_label: z.string().optional(),
  hidden: z.boolean().optional(),
  position: z.number().int().optional(),
});

const SavedViewEntry = z.object({
  entity_kind: z.string(),
  name: z.string().min(1),
  view_type: z.string().min(1).default("list"),
  config: z.record(z.unknown()).default({}),
  pinned: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

/** A module INSTANCE a bundle creates on install — a skinned copy of a
 *  multi-instance module (e.g. an "inventory" instance named "Yarn"). Its
 *  field_defs/overrides/saved_views/wires are applied scoped to the instance's
 *  entity kind `<instance_name>:item`, so they live ONLY on that instance. The
 *  instance gets its own nav entry (display_name + glyph) + add flow. `item_noun`
 *  drives the "New <noun>" button + create-modal title; `qty_unit` the default unit. */
const InstanceEntry = z.object({
  module: z.string().min(1),
  instance_name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  display_name: z.string().min(1),
  glyph: z.string().optional(),
  item_noun: z.string().optional(),
  qty_unit: z.string().optional(),
  /** When this instance's items belong to a parent "type" in another instance
   *  (e.g. Spools → Filament types), the create/edit forms show a parent picker
   *  and write an `instance-of` pairing. `instance` is the parent instance name.
   *
   *  `key_fields` (+ optional `copy_fields`) turn this into an AUTO-lift: when an
   *  item is created carrying those fields (a scan/import that filled them — not
   *  a manual parent-picker create that leaves them empty), the kernel
   *  find-or-creates the parent type by those keys and links it, so a scanned
   *  spool lands in the type→spool model instead of as a flat row. Same params
   *  the `inventory:lift-to-type` migration uses. */
  parent: z
    .object({
      instance: z.string().min(1),
      label: z.string().optional(),
      relationship_kind: z.string().optional(),
      key_fields: z.array(z.string()).optional(),
      copy_fields: z.array(z.string()).optional(),
    })
    .optional(),
  /** Visually group this instance with its sibling instances in the navbar.
   *  Every instance sharing the same `key` renders as one connected element —
   *  a quiet `label` stem followed by each member's name as a segment (the
   *  stem prefix is stripped from each, so "Filament Types" shows as "Types"
   *  under a "Filament" stem). Purely presentational + generic — any bundle
   *  can group its instances; nothing module-specific. */
  nav_group: z
    .object({
      key: z.string().min(1).max(80),
      label: z.string().min(1).max(80),
    })
    .optional(),
  /** Domain terms that sharpen scan ROUTING to this instance (yarn →
   *  ["yarn","skein","wool","ball-band"]). Surfaced into the scan menu + the
   *  matchmaker prompt; purely additive — routing still works off noun + fields
   *  when absent. */
  scan_keywords: z.array(z.string().min(1).max(60)).max(40).optional(),
  field_defs: z.array(FieldDefEntry).default([]),
  field_overrides: z.array(FieldOverrideEntry).default([]),
  saved_views: z.array(SavedViewEntry).default([]),
  wires: z.array(WireEntry).default([]),
});

/** A WorkspaceApp a bundle seeds on install (e.g. Wardrobe → the Outfit
 *  Planner). `pages`/`blocks` follow the core-apps AppDefinition shape (a
 *  custom block carries its own HTML); validated structurally here, deeply by
 *  core-apps when rendered. Requires the core-apps module (declare it in the
 *  bundle/feature `requires`). Idempotent on slug. */
const AppPageEntry = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1).max(160),
  blocks: z.array(z.record(z.unknown())).max(50),
});
const AppEntry = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(120),
  icon: z.string().max(40).optional(),
  visible_capability: z.string().max(120).nullable().optional(),
  pages: z.array(AppPageEntry).max(30).default([]),
  theme: z.record(z.unknown()).nullable().optional(),
});

/** Compare dotted numeric versions ("0.3.2" vs "0.4.0"). <0 if a<b, 0 if equal,
 *  >0 if a>b. Non-numeric/absent segments sort as 0. Good enough for bundle
 *  version gating (semver-lite — no pre-release tags in bundle versions). */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const BundleManifest = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  /** Release date of this version (ISO) + plain-language changelog, shown on
   *  the update prompt. Display-only; stored in the manifest jsonb. */
  released_at: z.string().optional(),
  changelog: z.string().max(2000).optional(),
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
  requires: z.array(RequireEntry).default([]),
  wires: z.array(WireEntry).default([]),
  field_defs: z.array(FieldDefEntry).default([]),
  /** Presentation overrides for a kind's NATIVE fields — RELABEL + SHOW/HIDE. */
  field_overrides: z.array(FieldOverrideEntry).default([]),
  /** v1.5: bundle ships saved views, tagged with the bundle's id. */
  saved_views: z.array(SavedViewEntry).default([]),
  /** Phase 2: opt-in features. The BASE arrays above always apply; each
   *  feature contributes its same-shaped arrays when its key is in the
   *  install's enabled_features. Definitions are stored in the manifest so
   *  features can be toggled later (PATCH /bundles/:id/features). */
  features: z
    .array(
      z.object({
        key: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        /** Display-only: the question form of the feature, shown in the
         *  install modal ("Want to track your designs too?"). Never read by
         *  resolveManifestFeatures — it just rides in the stored manifest. */
        question: z.string().optional(),
        default: z.boolean().optional(),
        requires: z.array(RequireEntry).default([]),
        wires: z.array(WireEntry).default([]),
        field_defs: z.array(FieldDefEntry).default([]),
        field_overrides: z.array(FieldOverrideEntry).default([]),
        saved_views: z.array(SavedViewEntry).default([]),
        provides_instances: z.array(InstanceEntry).default([]),
        provides_apps: z.array(AppEntry).default([]),
      }),
    )
    .default([]),
  /** Module instances this bundle creates on install (skinned copies of a
   *  multi-instance module — see InstanceEntry). Features can declare their own. */
  provides_instances: z.array(InstanceEntry).default([]),
  /** Data migrations the bundle OWNS. When the user upgrades from a version
   *  below `to_version` to this manifest's version (or higher), each migration's
   *  `action` runs automatically + idempotently against their data — so a
   *  structural bundle change (e.g. flat → type→instances) carries its own data
   *  move, no manual script. First-party bundles invoke registered generic
   *  actions (e.g. inventory:lift-to-type); never arbitrary code. */
  migrations: z
    .array(
      z.object({
        to_version: z.string().min(1),
        action: z.string().min(1),
        args: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
  /** WorkspaceApps this bundle seeds on install (e.g. the Outfit Planner). */
  provides_apps: z.array(AppEntry).default([]),
  /** Navbar headings the bundle creates on install — a named parent entry
   *  (e.g. "Machines") whose members are module and/or instance nav entries.
   *  Members may reference entries this bundle creates OR ones that already
   *  exist in the workspace ("move Digifab under Machines"). Idempotent by
   *  heading name; attaching a member MOVES it (a nav entry lives under at
   *  most one heading — same semantics as the Headings builder UI). */
  nav_headings: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        icon: z.string().max(80).optional(),
        members: z
          .array(
            z.object({
              target_kind: z.enum(["module", "instance"]),
              target_id: z.string().min(1).max(160),
            }),
          )
          .default([]),
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
       *  to me match this filter" predicate. Today lens
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
  /** Named instances this bundle creates (e.g. a "Bookshelf" of Assets) — each
   *  its own nav entry + page. Their fields live here, NOT in fields_added, so
   *  the plan must show them or it silently under-reports the whole build. */
  instances_created: Array<{
    module: string;
    instance_name: string;
    display_name: string;
    item_noun: string | null;
    fields: Array<{ name: string; type: string; display_label: string }>;
    wires: number;
  }>;
  /** Navbar parent headings this bundle creates + what moves under each. */
  nav_headings: Array<{ name: string; members: Array<{ target_kind: string; target_id: string }> }>;
  /** Phase 2 — when this is a self-upgrade and the new version changes a field the
   *  user customized. The user layer survives by construction; this lets the
   *  install offer keep-yours (default) / take-theirs per field. Empty on a fresh
   *  install or when nothing the user touched changed. */
  upgrade_conflicts: Array<{
    entity_kind: string;
    name: string;
    field_label: string;
    attr: "label" | "choices" | "removed";
    yours: string | string[] | null;
    theirs: string | string[] | null;
  }>;
}
export interface BundleValidationResult {
  valid: boolean;
  errors: BundleValidationError[];
  preview: BundleValidationPreview | null;
  /** The RESOLVED manifest (base + enabled features merged) when structural
   *  validation passed — this is what the install applies. Undefined on
   *  structural failure. */
  manifest?: BundleManifestT;
  /** The FULL parsed manifest (features intact) — stored on the bundle row so
   *  features can be toggled later. */
  fullManifest?: BundleManifestT;
  /** The feature keys that were resolved into `manifest`. */
  enabledFeatures?: string[];
}

const moduleOf = (id: string): string | null => (id.includes(":") ? (id.split(":")[0] ?? null) : null);

/** Merge instance declarations that target the same (module, instance_name) into
 *  ONE — so a FEATURE that re-declares an existing instance only to attach a wire
 *  (e.g. yarn's shopping-list re-declares `yarn` to add a low-stock wire, with no
 *  `item_noun`) doesn't clobber the base instance's identity (item_noun /
 *  display_name / glyph …) back to the generic default ("part"). First entry wins
 *  on scalars — the base comes first, so its identity is authoritative; arrays
 *  (field_defs, field_overrides, wires, saved_views) concatenate. */
function mergeInstances(
  list: BundleManifestT["provides_instances"],
): BundleManifestT["provides_instances"] {
  const ARRAY_KEYS = ["field_defs", "field_overrides", "wires", "saved_views"];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const raw of list as unknown as Record<string, unknown>[]) {
    const key = `${String(raw.module)}::${String(raw.instance_name)}`;
    const ex = byKey.get(key);
    if (!ex) {
      const copy: Record<string, unknown> = { ...raw };
      for (const k of ARRAY_KEYS) copy[k] = [...((raw[k] as unknown[]) ?? [])];
      byKey.set(key, copy);
      continue;
    }
    for (const k of ARRAY_KEYS) ex[k] = [...((ex[k] as unknown[]) ?? []), ...((raw[k] as unknown[]) ?? [])];
    // Scalars: fill only what the base left undefined (base identity wins).
    for (const [k, v] of Object.entries(raw)) {
      if (!ARRAY_KEYS.includes(k) && (ex[k] === undefined || ex[k] === null)) ex[k] = v;
    }
  }
  return [...byKey.values()] as unknown as BundleManifestT["provides_instances"];
}

/** Merge a bundle's BASE manifest with its enabled optional features into one
 *  resolved manifest (arrays concatenated, requires dedup-unioned by module,
 *  instances merged by name). Mirrors the web-side resolveBundleManifest. */
export function resolveManifestFeatures(full: BundleManifestT, enabledKeys: string[]): BundleManifestT {
  const on = full.features.filter((f) => enabledKeys.includes(f.key));
  if (on.length === 0) return full;
  const seen = new Set<string>();
  const requires = [...full.requires, ...on.flatMap((f) => f.requires)].filter((r) =>
    seen.has(r.module) ? false : (seen.add(r.module), true),
  );
  return {
    ...full,
    requires,
    wires: [...full.wires, ...on.flatMap((f) => f.wires)],
    field_defs: [...full.field_defs, ...on.flatMap((f) => f.field_defs)],
    field_overrides: [...full.field_overrides, ...on.flatMap((f) => f.field_overrides)],
    saved_views: [...full.saved_views, ...on.flatMap((f) => f.saved_views)],
    provides_instances: mergeInstances([...full.provides_instances, ...on.flatMap((f) => f.provides_instances)]),
    provides_apps: [...full.provides_apps, ...on.flatMap((f) => f.provides_apps)],
  };
}

export async function validateBundle(
  orgId: string,
  rawManifest: unknown,
  opts: { autoEnable?: boolean; enabledFeatures?: string[] } = {},
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
  const full = parsed.data;
  // Phase 2: resolve BASE + enabled optional features; everything below
  // validates/previews the resolved set. Default = features marked default:true
  // when the caller doesn't specify an explicit set.
  const enabledFeatures =
    opts.enabledFeatures ?? full.features.filter((f) => f.default).map((f) => f.key);
  const m = resolveManifestFeatures(full, enabledFeatures);
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
    // B7: a bundle-shipped condition must be a valid structured filter —
    // a typo'd op shouldn't install as a wire that silently never fires
    // (the engine ignores malformed filters by design).
    if (w.filter != null) {
      const { error } = parseWireFilter(w.filter);
      if (error) {
        errors.push({ path: "wires.filter", code: "invalid_wire_filter", message: error });
      }
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
      .selectFrom("module_field_defs as fd")
      .leftJoin("bundles as b", "b.id", "fd.bundle_id")
      .select([
        "fd.entity_kind as entity_kind",
        "fd.name as name",
        "fd.bundle_id as bundle_id",
        "fd.source_module as source_module",
        "b.name as bundle_name",
      ])
      .where("fd.org_id", "=", orgId)
      .where((eb) =>
        eb.or(m.field_defs.map((f) => eb.and([eb("fd.entity_kind", "=", f.entity_kind), eb("fd.name", "=", f.name)]))),
      )
      .execute();
    // Group conflicts by the owning bundle/module so the user gets ONE
    // actionable message per owner ("remove Yarn Stash first") instead of a
    // wall of one-error-per-field telling them to "choose a different name"
    // (which they can't, installing a superset like Yarn Studio over Yarn Stash).
    // `label` is the friendly fragment for the human message ("the “Yarn
    // Stash” bundle"); `ownerRef` is the stable machine id consumers assert
    // on (`bundle:<name>` / `module:<name>` / `workspace`). Both are kept —
    // the grouped message is for the UI, the per-field structured conflicts
    // are the API contract (see the C.2 collision test).
    const byOwner = new Map<
      string,
      { label: string; ownerRef: string; isBundle: boolean; entries: Array<{ entity_kind: string; name: string }> }
    >();
    for (const c of conflicts) {
      if (c.bundle_id && selfIds.has(c.bundle_id)) continue;
      const key = c.bundle_id ? `b:${c.bundle_id}` : c.source_module ? `m:${c.source_module}` : "user";
      const label = c.bundle_id
        ? `the “${c.bundle_name ?? "another"}” bundle`
        : c.source_module
          ? `the ${c.source_module} module`
          : "your workspace";
      const ownerRef = c.bundle_id
        ? `bundle:${c.bundle_name ?? "unknown"}`
        : c.source_module
          ? `module:${c.source_module}`
          : "workspace";
      const e = byOwner.get(key) ?? { label, ownerRef, isBundle: !!c.bundle_id, entries: [] };
      e.entries.push({ entity_kind: c.entity_kind, name: c.name });
      byOwner.set(key, e);
    }
    for (const { label, ownerRef, isBundle, entries } of byOwner.values()) {
      const fields = entries.map((x) => x.name);
      errors.push({
        path: "field_defs.name",
        code: "field_def_collision",
        message: isBundle
          ? `These fields already exist from ${label}: ${fields.join(", ")}. Remove that bundle first (Bundles → installed → Remove), then install this one.`
          : `These fields already exist from ${label}: ${fields.join(", ")}. Rename them here or remove the existing ones first.`,
        detail: {
          owned_by: ownerRef,
          fields,
          conflicts: entries.map((x) => ({ entity_kind: x.entity_kind, field_name: x.name, owned_by: ownerRef })),
        },
      });
    }
  }

  // 5. Phase 2 — upgrade conflicts. When this manifest is a NEWER version of an
  //    already-installed bundle and the update CHANGES (or removes) a field the
  //    USER customized (a native_field_overrides row, bundle_id null), surface it.
  //    The user layer always survives (the bundle never writes user rows); this is
  //    the heads-up so the install can offer keep-yours / take-theirs per field.
  const upgradeConflicts: BundleValidationPreview["upgrade_conflicts"] = [];
  {
    const installed = await meta
      .selectFrom("bundles")
      .select("id")
      .where("org_id", "=", orgId)
      .where("external_id", "=", m.id)
      .execute();
    if (installed.length > 0) {
      const selfIds = installed.map((b) => b.id);
      const curDefs = await meta
        .selectFrom("module_field_defs")
        .select(["entity_kind", "name", "display_label", "choices"])
        .where("org_id", "=", orgId)
        .where("bundle_id", "in", selfIds)
        .execute();
      const curByKey = new Map(curDefs.map((d) => [`${d.entity_kind} ${d.name}`, d]));
      const newByKey = new Map(m.field_defs.map((f) => [`${f.entity_kind} ${f.name}`, f]));
      const userOvrs = await meta
        .selectFrom("native_field_overrides")
        .select(["entity_kind", "name", "display_label", "overrides"])
        .where("org_id", "=", orgId)
        .where("bundle_id", "is", null)
        .execute();
      const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      for (const o of userOvrs) {
        const key = `${o.entity_kind} ${o.name}`;
        const cur = curByKey.get(key);
        if (!cur) continue; // not a field this bundle owns — nothing to reconcile
        const fieldLabel = o.display_label ?? cur.display_label ?? o.name;
        const incoming = newByKey.get(key);
        if (!incoming) {
          upgradeConflicts.push({ entity_kind: o.entity_kind, name: o.name, field_label: fieldLabel, attr: "removed", yours: o.display_label ?? null, theirs: null });
          continue;
        }
        if (o.display_label != null && incoming.display_label !== cur.display_label) {
          upgradeConflicts.push({ entity_kind: o.entity_kind, name: o.name, field_label: fieldLabel, attr: "label", yours: o.display_label, theirs: incoming.display_label });
        }
        const userChoices = o.overrides?.choices ?? null;
        if (userChoices != null && !sameJson(incoming.choices, cur.choices)) {
          upgradeConflicts.push({ entity_kind: o.entity_kind, name: o.name, field_label: fieldLabel, attr: "choices", yours: userChoices, theirs: incoming.choices ?? null });
        }
      }
    }
  }

  const preview: BundleValidationPreview = {
    fields_added: m.field_defs.map((f) => ({ entity_kind: f.entity_kind, name: f.name, type: f.type, display_label: f.display_label })),
    wires_added: m.wires.map((w) => ({ source_kind: w.source_kind, action_id: w.action_id, trigger_type: w.trigger_type })),
    instances_created: m.provides_instances.map((i) => ({
      module: i.module,
      instance_name: i.instance_name,
      display_name: i.display_name,
      item_noun: i.item_noun ?? null,
      fields: i.field_defs.map((f) => ({ name: f.name, type: f.type, display_label: f.display_label })),
      wires: i.wires.length,
    })),
    nav_headings: m.nav_headings.map((h) => ({ name: h.name, members: h.members.map((mem) => ({ target_kind: mem.target_kind, target_id: mem.target_id })) })),
    modules_required: [...declaredRequires],
    modules_to_enable: modulesToEnable,
    upgrade_conflicts: upgradeConflicts,
  };
  return { valid: errors.length === 0, errors, preview, manifest: m, fullManifest: full, enabledFeatures };
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
          // Which opt-in features are on — so the UI can show feature state
          // without a per-bundle detail fetch.
          "enabled_features",
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
        .select(["entity_kind", "name", "display_label", "type", "required", "position", "unit"])
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
      if (!result.valid) {
        // Thesis telemetry: a rejected artifact is a WALL for whoever authored
        // it (human paste or AI build) — counted, never blocking.
        trackProductEvent({
          orgId: req.tenant!.org.id,
          userId: req.session?.id ?? null,
          event: "validation_rejected",
          detail: { source: "bundles/validate", error_codes: result.errors.map((e) => e.code) },
        });
      }
      res.json({ valid: result.valid, errors: result.errors, preview: result.preview });
    } catch (err) {
      next(err);
    }
  },
);

// Apply a VALIDATED bundle (the result of validateBundle, must be .valid) to a
// workspace: enable modules, create instances, insert field defs / wires /
// overrides / views / catalogs / apps, and run upgrade data-migrations. Extracted
// from POST /install so provisioning (managed apps) + the route share ONE apply.
export async function applyValidatedBundle(
  orgId: string,
  sess: { id: string; display_name?: string | null; auth_method: "session" | "api_token" | "system"; api_token_id?: string | null },
  v: BundleValidationResult,
  opts: { takeTheirs?: Array<{ entity_kind: string; name: string }> } = {},
): Promise<{
  bundle: { id: string; external_id: string; name: string; version: string };
  applied: {
    wires: number; field_defs: number; field_overrides: number; catalogs: number;
    auto_enabled_modules: string[]; migrations: Array<{ to_version: string; action: string; result: unknown }>;
  };
}> {
  const m = v.manifest!;
  // Apply the RESOLVED manifest (m); store the FULL manifest (features
  // intact) + which features were enabled, so they can be toggled later.
  const fullManifest = v.fullManifest ?? m;
  const enabledFeatures = v.enabledFeatures ?? [];

  // Phase 2 — "take theirs": drop the user override for each chosen field so
  // the incoming bundle version wins. (Default is keep-yours, which needs no
  // action — the user layer survives the re-push by construction.)
  for (const t of opts.takeTheirs ?? []) {
    await meta
      .deleteFrom("native_field_overrides")
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", t.entity_kind)
      .where("name", "=", t.name)
      .where("bundle_id", "is", null)
      .execute();
  }

  // Confirmed path: enable the modules that need enabling, parents
  // before children (dependency order).
  const autoEnabled: string[] = [];
  const toEnable = [...(v.preview?.modules_to_enable ?? [])].sort(
    (a, b) => (getEntry(a)?.manifest.dependencies.length ?? 0) - (getEntry(b)?.manifest.dependencies.length ?? 0),
  );
  for (const name of toEnable) {
    await enableModuleForOrg(orgId, name, { userId: sess.id });
    autoEnabled.push(name);
  }

  // Already installed? Replace ANY existing version of the same bundle
  // (external_id) — not just the same version — so installing a newer
  // version SUPERSEDES the old one (the update path) and a re-install is
  // idempotent. Removing the old set first frees its field defs/views so
  // the new set applies cleanly; the user's entities (parts, etc.) stay.
  const existing = await meta
    .selectFrom("bundles")
    .select(["id", "version", "manifest"])
    .where("org_id", "=", orgId)
    .where("external_id", "=", m.id)
    .execute();
  // The highest previously-installed version = the migration's FROM. Null on
  // a fresh install (no data to migrate → migrations skipped below).
  const priorVersion =
    existing.length > 0
      ? existing.map((e) => e.version).sort(cmpVersion).at(-1) ?? null
      : null;
  // The display_name each instance carried in the PREVIOUS bundle version,
  // keyed by instance_name. Used below to propagate a bundle-OWNED rename
  // (Filament types → Filament Types) to existing installs without clobbering
  // a user's own rename: if the stored nav label still equals the prior
  // bundle's label, the user never touched it, so the new name is safe.
  const priorInstanceLabels = new Map<string, string>();
  const priorBundle =
    existing.length > 0
      ? [...existing].sort((a, b) => cmpVersion(a.version, b.version)).at(-1)
      : null;
  if (priorBundle) {
    const rawPm = priorBundle.manifest;
    const pm = (typeof rawPm === "string" ? JSON.parse(rawPm) : rawPm) as
      | { provides_instances?: Array<{ instance_name?: string; display_name?: string }> }
      | null;
    for (const pi of pm?.provides_instances ?? []) {
      if (pi.instance_name && typeof pi.display_name === "string") {
        priorInstanceLabels.set(pi.instance_name, pi.display_name);
      }
    }
  }
  for (const old of existing) {
    await uninstallBundleId(old.id, { snapshotReason: "replaced" });
  }

  // Create the module instances this bundle ships (skinned copies of a
  // multi-instance module — e.g. a "Yarn" instance of inventory). Their
  // field defs / views / wires are applied below scoped to `<name>:item`.
  // Idempotent: skip createInstance if the instance already exists; the nav
  // override is insert-only so a re-install won't clobber a user's rename.
  for (const inst of m.provides_instances) {
    const existingInst = await getInstance(orgId, inst.instance_name);
    if (!existingInst) {
      await createInstance({
        orgId: orgId,
        moduleName: inst.module,
        instanceName: inst.instance_name,
        displayName: inst.display_name,
        isDefault: false,
      });
    }
    const instConfig = { item_noun: inst.item_noun ?? null, qty_unit: inst.qty_unit ?? null, parent: inst.parent ?? null, nav_group: inst.nav_group ?? null, scan_keywords: inst.scan_keywords ?? null };
    await upsertOverride({
      orgId: orgId,
      targetKind: "instance",
      targetId: `${inst.module}:${inst.instance_name}`,
      displayLabel: inst.display_name,
      icon: inst.glyph ?? null,
      config: instConfig,
      insertOnly: true,
    });
    // `config` is bundle-OWNED (item_noun / qty_unit / parent) — not a
    // user-edited field like display_label. insertOnly above preserves a
    // user's rename, but the config must still UPDATE on upgrade so a new
    // version's additions (e.g. the parent picker introduced in 0.4.0) land
    // on an already-installed instance.
    await meta
      .updateTable("entity_kind_overrides")
      .set({ config: sql`${JSON.stringify(instConfig)}::jsonb` as never, updated_at: new Date() })
      .where("org_id", "=", orgId)
      .where("target_kind", "=", "instance")
      .where("target_id", "=", `${inst.module}:${inst.instance_name}`)
      .execute();
    // Propagate a bundle-OWNED rename of the instance's nav label to existing
    // installs — but ONLY when the user hasn't renamed it themselves. The
    // insert-only upsert above preserves ANY current label; here we update it
    // to the new name iff (a) the bundle actually changed the label this
    // version and (b) the stored label still equals what the PREVIOUS bundle
    // version set (so the user never touched it). A genuine user rename — any
    // other stored value — won't match the WHERE and is left intact.
    const priorLabel = priorInstanceLabels.get(inst.instance_name);
    if (priorLabel && priorLabel !== inst.display_name) {
      await meta
        .updateTable("entity_kind_overrides")
        .set({ display_label: inst.display_name, updated_at: new Date() })
        .where("org_id", "=", orgId)
        .where("target_kind", "=", "instance")
        .where("target_id", "=", `${inst.module}:${inst.instance_name}`)
        .where("display_label", "=", priorLabel)
        .execute();
    }
  }

  // Provenance claims so uninstall can refcount: this bundle owns each instance
  // it ships + the module each instance lives on. Idempotent — a re-install or
  // upgrade re-records harmlessly. See platform/bundle-claims.ts.
  if (m.provides_instances.length > 0) {
    await recordClaims(
      orgId,
      m.id,
      m.provides_instances.flatMap((inst) => [
        { resource_type: "instance" as const, resource_key: inst.instance_name },
        { resource_type: "module" as const, resource_key: inst.module },
      ]),
    );
  }

  // (Field-def collisions are checked inside validateBundle above.)

  const inserted = await meta.transaction().execute(async (trx) => {
    const bundle = await trx
      .insertInto("bundles")
      .values({
        org_id: orgId,
        external_id: m.id,
        name: m.name,
        version: m.version,
        author: m.author ?? null,
        description: m.description ?? null,
        source_url: null,
        manifest: sql`${JSON.stringify(fullManifest)}::jsonb`,
        enabled_features: enabledFeatures,
      })
      .returning(["id", "external_id", "name", "version"])
      .executeTakeFirstOrThrow();

    for (const w of m.wires) {
      await trx
        .insertInto("entity_action_bindings")
        .values({
          org_id: orgId,
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
          org_id: orgId,
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
          template: f.type === "computed" ? f.template ?? null : null,
          help: f.help ?? null,
          unit: f.type === "number" ? f.unit ?? null : null,
        })
        .execute();
    }
    // Native-field overrides (relabel / show-hide). Upsert so a bundle can
    // reshape a field another bundle already touched (last writer wins);
    // tagged with bundle_id so uninstall cleans them up.
    for (const fo of m.field_overrides) {
      await trx
        .insertInto("native_field_overrides")
        .values({
          org_id: orgId,
          entity_kind: fo.entity_kind,
          name: fo.name,
          display_label: fo.display_label ?? null,
          hidden: fo.hidden ?? false,
          position: fo.position ?? 0,
          bundle_id: bundle.id,
        })
        .onConflict((c) =>
          c
            .columns(["org_id", "entity_kind", "name"])
            .doUpdateSet({
              display_label: fo.display_label ?? null,
              hidden: fo.hidden ?? false,
              position: fo.position ?? 0,
              bundle_id: bundle.id,
              updated_at: new Date(),
            })
            // Never overwrite a USER override (bundle_id null) on re-push: the
            // user layer wins + survives bundle upgrades (bundle-overrides Phase 1).
            .where("native_field_overrides.bundle_id", "is not", null),
        )
        .execute();
    }

    // Per-instance contributions — same shapes, but scoped to the
    // instance's entity kind `<instance_name>:item` so they live ONLY on
    // that instance (the Yarn instance shows yarn fields; the base
    // inventory is untouched). saved_views run in the tenant-DB block below.
    for (const inst of m.provides_instances) {
      const kind = `${inst.instance_name}:item`;
      for (const w of inst.wires) {
        await trx
          .insertInto("entity_action_bindings")
          .values({
            org_id: orgId,
            source_kind: kind,
            action_id: w.action_id,
            trigger_type: w.trigger_type,
            trigger_event: w.trigger_event ?? null,
            trigger_schedule: w.trigger_schedule ?? null,
            template: w.template ?? null,
            filter: w.filter ? sql`${JSON.stringify(w.filter)}::jsonb` : null,
            args: w.args ? sql`${JSON.stringify(w.args)}::jsonb` : null,
            bundle_id: bundle.id,
            target: w.target ? sql`${JSON.stringify(w.target)}::jsonb` : sql`'"self"'::jsonb`,
          })
          .execute();
      }
      for (const f of inst.field_defs) {
        await trx
          .insertInto("module_field_defs")
          .values({
            org_id: orgId,
            entity_kind: kind,
            name: f.name,
            display_label: f.display_label,
            type: f.type,
            required: f.required ?? false,
            position: f.position ?? 0,
            bundle_id: bundle.id,
            choices: f.choices
              ? (sql`${JSON.stringify(f.choices)}::jsonb` as unknown as string[])
              : null,
            renderer: (f as { renderer?: string | null }).renderer ?? null,
            template: f.type === "computed" ? f.template ?? null : null,
            help: f.help ?? null,
            unit: f.type === "number" ? f.unit ?? null : null,
          })
          .execute();
      }
      for (const fo of inst.field_overrides) {
        await trx
          .insertInto("native_field_overrides")
          .values({
            org_id: orgId,
            entity_kind: kind,
            name: fo.name,
            display_label: fo.display_label ?? null,
            hidden: fo.hidden ?? false,
            position: fo.position ?? 0,
            bundle_id: bundle.id,
          })
          .onConflict((c) =>
            c
              .columns(["org_id", "entity_kind", "name"])
              .doUpdateSet({
                display_label: fo.display_label ?? null,
                hidden: fo.hidden ?? false,
                position: fo.position ?? 0,
                bundle_id: bundle.id,
                updated_at: new Date(),
              })
              // Never overwrite a USER override (bundle_id null) on re-push.
              .where("native_field_overrides.bundle_id", "is not", null),
          )
          .execute();
      }
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
      const tdb = (await getTenantDb(orgId)) as unknown as Kysely<BundleTenantDB>;
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
  // Base views (declared entity_kind) + per-instance views (scoped to
  // `<instance_name>:item`) are applied the same way.
  const allViews = [
    ...m.saved_views,
    ...m.provides_instances.flatMap((inst) =>
      inst.saved_views.map((v) => ({ ...v, entity_kind: `${inst.instance_name}:item` })),
    ),
  ];
  if (allViews.length > 0) {
    try {
      const tdb = (await getTenantDb(orgId)) as unknown as Kysely<BundleTenantDB>;
      for (const v of allViews) {
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

  // Seed bundle-provided WorkspaceApps (e.g. Wardrobe → the Outfit
  // Planner). Idempotent on slug — skip if one already exists so a
  // re-install doesn't clobber a workspace's edits. Needs core-apps
  // enabled (declare it in the bundle/feature requires) so the table
  // exists; a miss is logged, non-fatal.
  if (m.provides_apps.length > 0) {
    try {
      const tdb = (await getTenantDb(orgId)) as unknown as Kysely<BundleTenantDB>;
      for (const app of m.provides_apps) {
        const exists = await tdb
          .selectFrom("core_apps_apps")
          .select("id")
          .where("slug", "=", app.slug)
          .executeTakeFirst();
        if (exists) continue;
        await tdb
          .insertInto("core_apps_apps")
          .values({
            slug: app.slug,
            name: app.name,
            icon: app.icon ?? null,
            visible_capability: app.visible_capability ?? null,
            pages: sql`${JSON.stringify(app.pages)}::jsonb` as never,
            theme: app.theme ? (sql`${JSON.stringify(app.theme)}::jsonb` as never) : null,
            created_by: null,
          } as never)
          .execute();
      }
    } catch (err) {
      console.error(`[bundle-install] provides_apps insert failed for bundle ${inserted.id}:`, err);
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
        orgId: orgId,
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
          orgId: orgId,
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

  // Navbar headings the bundle declares: create each (idempotent by name,
  // case-insensitive) and attach members. Runs AFTER instances exist so a
  // member can reference an instance this same bundle created. addNavMember
  // MOVES a target that already sits under another heading.
  for (const h of m.nav_headings) {
    try {
      const existingHeadings = await listNavHeadings(orgId);
      const found = existingHeadings.find((e) => e.name.toLowerCase() === h.name.toLowerCase());
      const heading = found ?? (await createNavHeading({ orgId, name: h.name, icon: h.icon ?? null }));
      for (const mem of h.members) {
        await addNavMember({ orgId, headingId: heading.id, targetKind: mem.target_kind, targetId: mem.target_id });
      }
    } catch (err) {
      // Presentation, not data — a bad member id must not fail the install.
      console.error(`[bundle-install] nav heading "${h.name}" failed:`, err);
    }
  }

  // Count instance-scoped field_defs/wires too — an instance bundle (e.g.
  // Yarn) carries ALL its fields on `provides_instances`, with an empty base
  // `field_defs`. Counting only the base reported "Added 0 fields" even
  // though the Yarn table got colorway/fibre/weight/… (applied above).
  const instanceFieldDefs = m.provides_instances.reduce((n, inst) => n + inst.field_defs.length, 0);
  const instanceWires = m.provides_instances.reduce((n, inst) => n + inst.wires.length, 0);
  const totalFieldDefs = m.field_defs.length + instanceFieldDefs;
  const totalWires = m.wires.length + instanceWires;
  await activity.log({
    orgId: orgId,
    action: "bundle_installed",
    ref: { module: null, entityType: "bundle", entityId: inserted.id },
    diff: {
      external_id: m.id,
      version: m.version,
      name: m.name,
      wires: totalWires,
      field_defs: totalFieldDefs,
      saved_views: viewsInstalled,
      catalogs: catalogsInstalled,
    },
  });
  // Run the bundle's OWN data migrations whose to_version we just crossed —
  // only on an UPGRADE (priorVersion set + below to_version). A fresh install
  // runs none (no data to move). Idempotent: the migration actions skip
  // already-migrated rows, so a re-upgrade is safe. Non-fatal: a failed
  // migration logs + the install still succeeds (re-install retries).
  const migrationsRun: Array<{ to_version: string; action: string; result: unknown }> = [];
  if (priorVersion && m.migrations.length > 0) {
    const actor = {
      user_id: sess.id,
      display_name: sess.display_name ?? null,
      auth_method: sess.auth_method,
      api_token_id: sess.api_token_id ?? null,
      api_token_name: null,
    };
    for (const mig of m.migrations) {
      if (cmpVersion(priorVersion, mig.to_version) >= 0) continue; // already past it
      try {
        const result = await platform().actions.invoke(mig.action, {
          orgId: orgId,
          userId: sess.id,
          entity: { kind: "inventory:part", id: "" },
          event: { name: "bundle.upgraded", payload: {}, actor, timestamp: new Date().toISOString(), trigger_type: "event" },
          args: mig.args,
          entityKind: "inventory:part",
          entityId: "",
        });
        migrationsRun.push({ to_version: mig.to_version, action: mig.action, result });
      } catch (err) {
        console.error(`[bundle-install] migration ${mig.action} (→${mig.to_version}) failed for ${inserted.id}:`, (err as Error).message);
      }
    }
  }
  return {
    bundle: inserted,
    applied: {
      wires: totalWires,
      field_defs: totalFieldDefs,
      field_overrides: m.field_overrides.length,
      catalogs: catalogsInstalled,
      auto_enabled_modules: autoEnabled,
      migrations: migrationsRun,
    },
  };
}

bundlesRouter.post(
  "/install",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // Installing a bundle changes workspace composition — enables
      // modules, adds field defs + automation wires. Owner/admin only; a
      // read-only guest / plain member must not. See 2026-06-10 audit #3.
      if (!requireRole(req, res, "owner", "admin")) return;
      // Q5 (wires-and-bundles.md): `requires` is now an "install" not
      // a "check." If the bundle needs modules the workspace doesn't
      // have enabled, return 409 with `needs_enable` instead of
      // auto-enabling silently. Caller re-POSTs with `confirm:true`
      // to proceed.
      const ManifestBody = z.object({
        manifest: z.unknown(),
        confirm: z.boolean().optional(),
        /** Phase 2: which optional features to install. Omitted → the
         *  features' own default:true set (validateBundle's fallback). */
        enabled_features: z.array(z.string()).optional(),
        /** Upgrade conflicts (preview.upgrade_conflicts) the user chose to
         *  "take theirs" on: drop the user override so the new bundle wins. */
        take_theirs: z.array(z.object({ entity_kind: z.string(), name: z.string() })).optional(),
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
      const v = await validateBundle(req.tenant!.org.id, body.data.manifest, {
        autoEnable: confirm,
        enabledFeatures: body.data.enabled_features,
      });
      if (!v.valid) {
        trackProductEvent({
          orgId: req.tenant!.org.id,
          userId: req.session?.id ?? null,
          event: "validation_rejected",
          detail: { source: "bundles/install", error_codes: v.errors.map((e) => e.code) },
        });
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
              details: {
                conflicts: collisions.flatMap(
                  (e) => (e.detail as { conflicts?: Array<{ entity_kind: string; field_name: string; owned_by: string }> }).conflicts ?? [],
                ),
              },
            },
          });
          return;
        }
        res.status(400).json({ error: { code: "invalid_bundle", message: "Bundle manifest failed validation", details: { errors: v.errors } } });
        return;
      }
      const result = await applyValidatedBundle(
        req.tenant!.org.id,
        { id: req.session!.id, display_name: req.session!.display_name ?? null, auth_method: req.session!.auth_method, api_token_id: req.session!.api_token_id ?? null },
        v,
        { takeTheirs: body.data.take_theirs },
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// GET /:id/uninstall-preview — what an uninstall WOULD remove: the bundle's
// instances no other source still claims (with item counts) + the modules that
// would be disabled. Powers the uninstall-confirm warning so a user knows data
// is about to be deleted before they confirm.
bundlesRouter.get(
  "/:id/uninstall-preview",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      const bundle = await meta
        .selectFrom("bundles")
        .select(["id", "external_id"])
        .where("id", "=", req.params.id ?? "")
        .where("org_id", "=", req.tenant!.org.id)
        .executeTakeFirst();
      if (!bundle) {
        res.status(404).json({ error: { code: "not_found", message: "bundle not found" } });
        return;
      }
      res.json(await previewBundleUninstall(req.tenant!.org.id, bundle.external_id));
    } catch (err) {
      next(err);
    }
  },
);

/** The instances (no other source claims them) + modules that an uninstall of
 *  this bundle would tear down — same refcount the teardown uses (<= 1 claim ⇒
 *  only this bundle ⇒ removed). */
async function previewBundleUninstall(
  orgId: string,
  externalId: string,
): Promise<{ instances: { name: string; display_name: string; item_count: number }[]; modules: string[] }> {
  const claims = await claimsForSource(orgId, externalId);
  const instances: { name: string; display_name: string; item_count: number }[] = [];
  for (const c of claims.filter((x) => x.resource_type === "instance")) {
    if ((await countClaimsFor(orgId, "instance", c.resource_key)) <= 1) {
      const inst = await getInstance(orgId, c.resource_key);
      if (inst && !inst.is_default) {
        instances.push({
          name: c.resource_key,
          display_name: inst.display_name ?? c.resource_key,
          item_count: (await countInstanceItems(orgId, inst.module_name, c.resource_key)) ?? 0,
        });
      }
    }
  }
  const modules: string[] = [];
  for (const c of claims.filter((x) => x.resource_type === "module")) {
    if ((await countClaimsFor(orgId, "module", c.resource_key)) <= 1) modules.push(c.resource_key);
  }
  return { instances, modules };
}

// ── Version history (audit F3): list snapshots + revert to one ─────
// Every removed bundle row (update-replace / uninstall / revert) is kept in
// bundle_snapshots by uninstallBundleId(); these endpoints read that history
// and re-apply a chosen version through the SAME validate+apply path as any
// install — a revert that no longer validates (modules/kinds changed since)
// comes back 409 with the errors instead of half-applying.
bundlesRouter.get(
  "/history/:externalId",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const rows = await meta
        .selectFrom("bundle_snapshots")
        .select(["id", "external_id", "name", "version", "reason", "enabled_features", "created_at", "manifest"])
        .where("org_id", "=", req.tenant!.org.id)
        .where("external_id", "=", req.params.externalId!)
        .orderBy("created_at", "desc")
        .limit(50)
        .execute();
      res.json({
        items: rows.map((r) => {
          const m = (typeof r.manifest === "string" ? JSON.parse(r.manifest) : r.manifest) as {
            field_defs?: unknown[];
            wires?: unknown[];
            provides_instances?: unknown[];
          } | null;
          return {
            id: r.id,
            external_id: r.external_id,
            name: r.name,
            version: r.version,
            reason: r.reason,
            enabled_features: r.enabled_features,
            created_at: r.created_at,
            counts: {
              field_defs: m?.field_defs?.length ?? 0,
              wires: m?.wires?.length ?? 0,
              instances: m?.provides_instances?.length ?? 0,
            },
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  },
);

bundlesRouter.post(
  "/history/:snapshotId/revert",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      const snap = await meta
        .selectFrom("bundle_snapshots")
        .selectAll()
        .where("id", "=", req.params.snapshotId!)
        .where("org_id", "=", req.tenant!.org.id)
        .executeTakeFirst();
      if (!snap) {
        res.status(404).json({ error: { code: "not_found", message: "No such snapshot." } });
        return;
      }
      const manifest = typeof snap.manifest === "string" ? JSON.parse(snap.manifest) : snap.manifest;
      const v = await validateBundle(req.tenant!.org.id, manifest, {
        autoEnable: true,
        enabledFeatures: snap.enabled_features,
      });
      if (!v.valid) {
        res.status(409).json({
          error: {
            code: "revert_invalid",
            message:
              "This version no longer validates against the workspace (modules or kinds may have changed since). Nothing was changed.",
            details: v.errors,
          },
        });
        return;
      }
      // applyValidatedBundle replaces any currently-installed version — which
      // itself snapshots as 'replaced', so a revert is also undoable.
      const result = await applyValidatedBundle(
        req.tenant!.org.id,
        { id: req.session!.id, display_name: req.session!.display_name ?? null, auth_method: req.session!.auth_method, api_token_id: req.session!.api_token_id ?? null },
        v,
      );
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "bundle_reverted",
        ref: { module: null, entityType: "bundle", entityId: result.bundle.id },
        diff: { name: snap.name, to_version: snap.version, snapshot_id: snap.id },
      });
      res.status(201).json(result);
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
      if (!requireRole(req, res, "owner", "admin")) return;
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: { code: "missing_id", message: "id required" } });
        return;
      }
      const bundle = await meta
        .selectFrom("bundles")
        .select(["id", "name"])
        .where("id", "=", id)
        .where("org_id", "=", req.tenant!.org.id)
        .executeTakeFirst();
      if (!bundle) {
        res.status(404).json({ error: { code: "not_found", message: "bundle not found" } });
        return;
      }
      await uninstallBundleId(bundle.id, { teardownResources: true });
      await activity.log({
        orgId: req.tenant!.org.id,
        action: "bundle_uninstalled",
        ref: { module: null, entityType: "bundle", entityId: bundle.id },
        // The bundle row is gone after uninstall, so carry its name so the
        // activity feed reads "bundle uninstalled · <name>" (mirrors install).
        diff: { name: bundle.name },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

async function uninstallBundleId(
  bundleId: string,
  opts?: { teardownResources?: boolean; snapshotReason?: "replaced" | "uninstalled" },
): Promise<void> {
  // v1.5: bundles can also have installed saved views in the
  // tenant DB. Delete those FIRST (so they're gone whether or not
  // the meta-side delete succeeds), then drop the meta-side rows
  // in a transaction.
  const bundleRow = await meta
    .selectFrom("bundles")
    .select(["org_id", "external_id", "name", "version", "manifest", "enabled_features"])
    .where("id", "=", bundleId)
    .executeTakeFirst();
  if (bundleRow) {
    // Version history (audit F3): before anything is deleted, keep the FULL
    // stored manifest + enabled features so this exact version can be
    // re-validated and re-applied later ("revert"). EVERY removal path goes
    // through here — update-replace, explicit uninstall, revert-overwrite —
    // so one write point covers them all. Best-effort: history must never
    // block an uninstall.
    try {
      await meta
        .insertInto("bundle_snapshots")
        .values({
          org_id: bundleRow.org_id,
          external_id: bundleRow.external_id,
          name: bundleRow.name,
          version: bundleRow.version,
          reason: opts?.snapshotReason ?? "uninstalled",
          manifest: sql`${JSON.stringify(bundleRow.manifest)}::jsonb`,
          enabled_features: bundleRow.enabled_features ?? [],
        })
        .execute();
    } catch (err) {
      console.error(`[bundle-uninstall] snapshot failed for ${bundleRow.external_id}:`, err);
    }
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
      .deleteFrom("native_field_overrides")
      .where("bundle_id", "=", bundleId)
      .execute();
    await trx
      .deleteFrom("bundles")
      .where("id", "=", bundleId)
      .execute();
  });

  // Refcount teardown — ONLY on a real uninstall, NOT the upgrade-path cleanup
  // (applyValidatedBundle calls this to drop a prior version before reinstalling;
  // tearing resources down there would delete instance data mid-upgrade). Drop
  // this bundle's provenance claims, then tear down each resource no OTHER source
  // (another bundle, or the user) still claims. Instances first (so a now-unused
  // module is left with no named instances), then modules.
  if (opts?.teardownResources && bundleRow) {
    const claims = await claimsForSource(bundleRow.org_id, bundleRow.external_id);
    await removeClaimsForSource(bundleRow.org_id, bundleRow.external_id);
    for (const c of claims.filter((x) => x.resource_type === "instance")) {
      if ((await countClaimsFor(bundleRow.org_id, "instance", c.resource_key)) === 0) {
        await tearDownInstance(bundleRow.org_id, c.resource_key);
      }
    }
    for (const c of claims.filter((x) => x.resource_type === "module")) {
      if ((await countClaimsFor(bundleRow.org_id, "module", c.resource_key)) === 0) {
        try {
          await disableModuleForOrg(bundleRow.org_id, c.resource_key);
        } catch (err) {
          // disableModuleForOrg refuses foundational / dependency-pinned modules —
          // leave those enabled; not an error for the uninstall.
          console.error(`[bundle-uninstall] could not disable ${c.resource_key}:`, err);
        }
      }
    }
  }
}
