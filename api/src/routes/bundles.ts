import { RecordTemplateSchema, ReceiptDraftSchema, RenewalBindingSchema } from "@cobblr/platform-contract/record-creation";
import { FieldAggregateSchema } from "@cobblr/platform-contract/field-aggregate";
import { ACTION_GROUPS, similarActionGroup } from "@cobblr/platform-contract/action-groups";
import { RecordActionLayout } from "@cobblr/platform-contract/action-groups-schema";
import { bundleFieldReference } from "../platform/bundle-field-reference.js";
// Bundles — publishable artifacts that bundle multiple wires +
// field defs into one install. Phase 4 C.2: export current org
// state, import + apply a bundle, uninstall cleanly.

import { Router } from "express";
import { bundleTableWords } from "@cobblr/platform-contract/bundle-words";
import { trackProductEvent } from "../platform/product-events.js";
import { parseWireFilter } from "../platform/wire-filter.js";
import { z } from "zod";
import { BindingAsk, BindingLabel } from "@cobblr/platform-contract/binding-ask";
import { chosenNoun, nounOptions, type NounChoiceDecl } from "@cobblr/platform-contract/kind-label";
import { fillInstanceNoun, storedNounChoices, withNounsFilled } from "../platform/noun-choice.js";
import { applyBundleLocations, previewBundleLocations } from "../platform/apply-bundle-locations.js";
import { describeKept, moduleRecordCount, previewPlaces, releaseUnclaimed, type ReleaseSummary } from "../platform/bundle-release.js";
import { resolveEnabledFeatures, featuresToOffer as pickFeaturesToOffer } from "../platform/feature-defaults.js";
import { sql, type Kysely } from "kysely";
import type { MetaDB } from "../db/schema.js";
import { platform, fieldTypeTakesUnit, CatalogSchemaConfig, packFieldIssues, FieldRoleSchema, FieldTypeSchema, isFieldScope, parseFieldScope, FaceSchema } from "@cobblr/platform-contract";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { describeBlock } from "../platform/approvals.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { withWorkspaceLock } from "../platform/workspace-lock.js";
import {
  assertActingRoleClearsActionFloor,
  ActionRoleFloorError,
} from "../platform/platform-actions.js";
import { getTenantDb } from "../db/tenant.js";
import { resolveAppViewRefs, type SeededView } from "./bundle-app-view-refs.js";
import * as activity from "../platform/activity.js";
import { enableModuleForOrg, isDefaultModule } from "../modules/enable.js";
import { canonicalModuleName, getEntry } from "../modules/registry.js";
import { getFlagshipManifest, listFlagshipManifests } from "../lib/flagship-bundles.js";
import { externalRegistry } from "./registry.js";
import { upsertOverride, deleteOverride } from "../platform/entity-kind-overrides.js";
import { createInstance, getInstance } from "../platform/instances.js";
import { checkInstalled, promisedInstances, type PromisedInstance } from "../platform/install-postcondition.js";
import { featureChange, diffLedger, describeFeatureChange, type FeatureManifest, type InstanceLedgerRow } from "../platform/bundle-feature-change.js";
import { SCAN_CATEGORY_SOURCE } from "../platform/reconcile-scan-category.js";
import { listNavHeadings, createNavHeading, addNavMember } from "../platform/nav-headings.js";
import { tearDownInstance, countInstanceItems, listInstances, instanceRowCount } from "../platform/instances.js";
import {
  recordClaims,
  type ResourceClaim,
  removeClaimsForSource,
  claimsForSource,
  countClaimsFor,
} from "../platform/bundle-claims.js";
import { bumpWorkspaceShape } from "../platform/workspace-shape.js";
import { bundleInstallSummary } from "../lib/bundle-install-summary.js";

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
    /** A user-invoked wire's own button label and what it asks before it
     *  runs (binding-ask.ts): the collection's shortcut on its records. */
    label: BindingLabel.optional(),
    ask: BindingAsk.optional(),
    /** What this wire does, in one sentence a person reads where the bundle
     *  is suggested ("Works with Lists"): a suggestion says only these, so a
     *  bundle with none touching a page is never suggested there. */
    says: z.string().trim().min(1).max(160).optional(),
    target: z
      .union([
        z.literal("self"),
        z.literal("none"),
        z.object({ rel: z.string().min(1), dir: z.enum(["in", "out"]).optional(), kind: z.string().optional() }),
      ])
      .optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.label || data.ask?.length) && data.trigger_type !== "user-invoked") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "label and ask are for a button (trigger_type 'user-invoked'); a wire that fires on its own has nobody to ask", path: ["label"] });
    }
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
    type: FieldTypeSchema,
    ref_kind: z.string().trim().min(1).optional(),
    required: z.boolean().optional(),
    position: z.number().int().optional(),
    choices: z.array(z.string()).optional(),
    renderer: z.string().optional(),
    template: z.string().max(2000).optional(),
    /** Plain-language one-line hint shown under the input ("the maker's named
     *  shade — e.g. 'Peacock Heather'") so jargon fields explain themselves. */
    help: z.string().max(280).optional(),
    /** The heading this field sits under on a record's sheet ("Printing",
     *  "Spool"), the same form-builder sections a person arranges by hand. A
     *  section is found by name or made on install and upgrade, in the order
     *  its first field appears; a field with none sits above the sections. */
    section: z.string().trim().min(1).max(60).optional(),
    /** The unit a type='number' value is measured in ("mm", "g") — free text,
     *  resolved against the units vocabulary at render/consume time. Declares
     *  physical semantics (a length-category unit IS a length), never derived
     *  from the field's name. */
    unit: z.string().trim().min(1).max(40).nullish(),
    /** Semantic DECODE role (P3 of the identifier-decoder registry):
     *  `identifier:<decoderId>` (this field holds a decodable code) or
     *  `decode:<key>` (fill from the decoder's <key> output). Optional +
     *  generic — see packages/platform-contract parseDecodeRole. */
    decode_role: z
      .string()
      .regex(/^(identifier:[a-z][a-z0-9_-]*|decode:[a-z][a-z0-9_-]*)$/i)
      .optional(),
    /** Semantic RECORD role. `category` marks the field that says what KIND of
     *  thing a record is WITHIN this table — the axis the scan matchmaker routes
     *  on, so a difference in kind is a category rather than a different table.
     *  `pack` marks the packaging-count field, filled from the scanned package.
     *  At most one of each per entity kind. */
    field_role: FieldRoleSchema.optional(),
    /** Whether what a person types becomes a choice (field-choices.ts). Every
     *  text field with choices a bundle ships declares it
     *  (lint:field-learns-declared). */
    learns: z.boolean().optional(),
    /** How it adds up in a group's summary (@cobblr/platform-contract/field-aggregate). */
    aggregate: FieldAggregateSchema.optional(),
  })
  .refine((f) => f.type !== "relation" || !!f.ref_kind, { message: "relation field_defs need a target kind", path: ["ref_kind"] })
  .refine((f) => f.type !== "computed" || (f.template && f.template.trim().length > 0), {
    message: "computed field_defs need a template",
    path: ["template"],
  })
  .refine((f) => f.field_role !== "category" || f.type === "text", {
    message: "a category field must be type='text' (its choices are the categories)",
    path: ["field_role"],
  })
  // Pack-dimension guardrail — shared with the contract + its unit test, so a
  // mislabeled or "usually buy"-framed pack field can never ship (see FIELD_ROLE_PACK).
  .superRefine((f, ctx) => {
    for (const issue of packFieldIssues(f)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message });
    }
  })
  .refine((f) => !f.unit || fieldTypeTakesUnit(f.type), {
    message: "unit is only valid on a number or measure field",
    path: ["unit"],
  });

const FieldOverrideEntry = z.object({
  entity_kind: z.string(),
  name: z.string(),
  display_label: z.string().optional(),
  hidden: z.boolean().optional(),
  position: z.number().int().optional(),
  /** Semantic DECODE role (P3) for this NATIVE field — stored in the override's
   *  `overrides` jsonb blob. `identifier:<decoderId>` or `decode:<key>`. Lets a
   *  bundle mark a relabeled native field (serial_number → "VIN") as the
   *  decoder's identifier / a fill target without a schema change. */
  decode_role: z
    .string()
    .regex(/^(identifier:[a-z][a-z0-9_-]*|decode:[a-z][a-z0-9_-]*)$/i)
    .optional(),
  /** Semantic RECORD role for this NATIVE field — same override seam as
   *  decode_role. Lets a bundle mark inventory's OWN `category` field as the
   *  table's grouping axis, or a native field as the `pack` count, with no
   *  schema change. */
  field_role: FieldRoleSchema.optional(),
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
  /** What a record of this table calls the things inside it ("Parts" for a
   *  computer, "In the bag" for a bag): the default for its Contents panel.
   *  A workspace's own word wins and an update never overwrites it. */
  contents_label: z.string().min(1).max(40).optional(),
  /** The service jobs a record of this table usually needs ("Oil change",
   *  "Nozzle swap"): where the maintenance panel's "What needs doing" starts,
   *  before the workspace's own jobs are offered beside them. */
  service_tasks: z.array(z.string().min(1).max(80)).max(40).optional(),
  /** One line under the table's title saying what goes in it ("markers,
   *  needles, safety eyes, stuffing, buttons"): for a name that does not say
   *  it on its own. */
  hint: z.string().min(1).max(160).optional(),
  /** The words the person may pick for what this table holds or counts
   *  (#3650). Labels, help and view names say {{noun}} / {{nouns}}, and the
   *  install fills them with the choice (platform/noun-choice.ts). `of: unit`
   *  sets qty_unit, so records follow a change; `of: item` sets item_noun. */
  noun: z
    .object({
      of: z.enum(["unit", "item"]),
      singular: z.string().min(1),
      plural: z.string().min(1),
      alternatives: z.array(z.object({ singular: z.string().min(1), plural: z.string().min(1) })).default([]),
    })
    .optional(),
  /** Each file dropped on this table becomes a record, the file attached to
   *  it with `role` (Yarn's Patterns: every PDF is a pattern). Files arrive
   *  through core-files' intake and land in `folder`; a zip's top folder fills
   *  `folder_field` when it names one of its choices; `ask` is asked once for
   *  the batch. See platform/instance-file-intake.ts. */
  /** An "Import from <service>" button on this table, through a sync
   *  connector (ConnectorImportDecl): the connector's id and, per section it
   *  offers, the table its rows land in. */
  connector_import: z
    .object({
      connector: z.string().min(1),
      label: z.string().min(1).optional(),
      sections: z.record(z.string().min(1)),
    })
    .optional(),
  file_intake: z
    .object({
      accept: z.array(z.string().min(1)).min(1),
      role: z.string().min(1),
      folder: z.string().min(1).optional(),
      folder_field: z.string().min(1).optional(),
      ask: z.array(z.string().min(1)).optional(),
      label: z.string().min(1).optional(),
      /** How to get the files out of a place, shown when the batch question
       *  is answered with it (FileIntakeGuide). */
      guides: z
        .array(
          z.object({
            when: z.object({ field: z.string().min(1), equals: z.string().min(1) }),
            title: z.string().min(1).max(120),
            steps: z.array(z.string().min(1).max(400)).min(1).max(12),
          }),
        )
        .max(20)
        .optional(),
    })
    .optional(),
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
  renewal_fields: RenewalBindingSchema.optional(),
  record_templates: z.array(RecordTemplateSchema).max(30).optional(),
  receipt_draft: ReceiptDraftSchema.optional(),
  board_revisions: z.object({ package_kind: z.string().min(3).max(120), blank_kind: z.string().min(3).max(120), stencil_kind: z.string().min(3).max(120), placed_kind: z.string().min(3).max(120).optional() }).optional(),
  paste_tracking: z.boolean().optional(),
  package_receiving: z.object({ identity_field: z.string().min(1).max(80), storage_tracking: z.boolean().default(false) }).optional(),
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
  /** The faces this collection wears, chosen by the bundle: a Groceries table
   *  is stock + perishable and nothing else, so its records never carry a
   *  serial-number box or a service log. Keys left out are derived from
   *  signal; a boolean here wins either way (docs/architecture/faces.md). */
  faces: z.record(FaceSchema, z.boolean()).optional(),
  /** The links a record in this table makes, in words (#3875): a mod is
   *  "installed on" a printer and "uses part" a part. `kind` is what the link
   *  stores, `label` reads from this record ("installed on Ender 3"), `inverse`
   *  from the other end ("has installed"), and `to` names what it can point at:
   *  module kinds (`machines:machine`) or table names (`3d-printers`). The
   *  Link dialog offers them first and lists the targets without a search. */
  links: z
    .array(
      z.object({
        kind: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
        label: z.string().min(1).max(60),
        inverse: z.string().min(1).max(60),
        date_summary: z.object({ label: z.string().min(1).max(60), field: z.string().min(1).max(80), format: z.enum(["date", "month-year"]) }).optional(),
        to: z.array(z.string().min(1).max(80)).min(1),
      }),
    )
    .optional(),
  field_defs: z.array(FieldDefEntry).default([]),
  field_overrides: z.array(FieldOverrideEntry).default([]),
  saved_views: z.array(SavedViewEntry).default([]),
  wires: z.array(WireEntry).default([]),
}).superRefine((instance, ctx) => {
  for (const [i, template] of (instance.record_templates ?? []).entries()) {
    for (const name of Object.keys(template.fields)) {
      const def = instance.field_defs.find(f => f.name === name);
      if (!def || def.type === "secret" || def.type === "computed") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["record_templates", i, "fields", name], message: "A starter template sets editable ordinary fields declared on this collection" });
    }
  }
});

/** A WorkspaceApp a bundle seeds on install (e.g. Wardrobe → the Outfit
 *  Planner). `pages`/`blocks` follow the core-apps AppDefinition shape (a
 *  custom block carries its own HTML); validated structurally here, deeply by
 *  core-apps when rendered. Requires the core-apps module (declare it in the
 *  bundle/feature `requires`). Idempotent on slug. */
/** A place a bundle offers to set up. One level of nesting, which covers every
 *  real case (a room with things in it) and keeps the install preview readable.
 *  Applied find-or-create per CHILD, so an existing Kitchen is merged into
 *  rather than duplicated, and its existing contents are left alone. */
const LocationEntry = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(["area", "container"]).default("container"),
  children: z
    .array(z.object({ name: z.string().min(1).max(80), kind: z.enum(["area", "container"]).default("container") }))
    .default([]),
});

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

// A catalog SHELL (name + schema config, no rows). Shared by the top-level
// manifest and by opt-in features (so "Link to Rebrickable" installs the
// catalogs only when that box is checked).
const CatalogEntry = z.object({
  external_id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1),
  description: z.string().optional(),
  source_url: z.string().optional(),
  puller_id: z.string().optional(),
  // The canonical catalog-schema shape — same zod the core-catalogs module
  // validates writes with. Shared (not a hand-kept copy) so a new key can't be
  // silently stripped here on install (the field_map / exclude_from_global_search
  // trap). Strict on purpose. Add keys in @cobblr/platform-contract.
  schema: CatalogSchemaConfig.default({}),
});

export const BundleManifest = z.object({
  record_actions: z.record(RecordActionLayout).default({}),
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  /** Release date of this version (ISO) + plain-language changelog, shown on
   *  the update prompt. Display-only; stored in the manifest jsonb. */
  released_at: z.string().optional(),
  changelog: z.string().max(2000).optional(),
  /** What changed in each version, newest first. An update shows every entry
   *  between the installed version and this one, so somebody three versions
   *  behind reads all three. lint:versions refuses a version bump that adds
   *  no entry for the new version: without it the prompt showed the notes of
   *  a release months older than the one on offer. Display-only. */
  releases: z
    .array(z.object({ version: z.string().min(1), released_at: z.string().optional(), notes: z.string().min(1).max(2000) }))
    .max(100)
    .optional(),
  /** The bundle's own routing vocabulary: what its things are CALLED. Read by
   *  the per-scan offer for a bundle not yet installed (lib/flagship-bundles.ts)
   *  and, since 2026-09-12, unioned into each provided table's words at install
   *  so the installed table knows what the offer knew. Larger cap than an
   *  instance's list on purpose: this is the whole domain's vocabulary. Without
   *  this key the parse dropped it and the install never saw it. */
  scan_keywords: z.array(z.string().min(1).max(60)).max(400).optional(),
  /** Why this manifest declares fields on a module's BASE kind rather than on
   *  an instance of its own. A specialisation is an instance, and a copy of a
   *  bundle's fields on the base kind cost twice (#2787, #2849, #2860), so
   *  lint:bundle-fields-on-own-kinds refuses base-kind fields unless the
   *  manifest says why here. Display-free; stored with the manifest. */
  base_kind_fields_reason: z.string().min(1).max(300).optional(),
  /** Catalog tier — where this bundle is OFFERED (see lib/flagship-bundles.ts):
   *  `core` (default when absent) is suggested per-scan AND browsable in the
   *  marketplace; `extended` is browsable but NOT suggested per-scan (it only
   *  surfaces when a user goes looking); `disabled` is hidden everywhere. Existing
   *  installs of a demoted bundle keep working — only the OFFER is withdrawn, never
   *  the data. Lets the shipped catalog be curated down to a small, unambiguous
   *  core without deleting a bundle's work. */
  catalog: z.enum(["core", "extended", "disabled"]).optional(),
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
        kind: z.literal("integration").optional(),
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
        provides_locations: z.array(LocationEntry).default([]),
        provides_apps: z.array(AppEntry).default([]),
        /** Catalog shells this feature installs when its box is checked (e.g.
         *  the Rebrickable catalogs behind "Link to Rebrickable"). */
        catalogs: z.array(CatalogEntry).default([]),
      }),
    )
    .default([]),
  /** Module instances this bundle creates on install (skinned copies of a
   *  multi-instance module — see InstanceEntry). Features can declare their own. */
  provides_instances: z.array(InstanceEntry).default([]),
  /** Places this bundle offers to set up (Kitchen with a Fridge in it). Applied
   *  find-or-create per child: an existing Kitchen is merged into, never
   *  duplicated, and whatever is already inside it stays. Usually declared on a
   *  FEATURE so it is a question rather than an imposition — a workspace may be
   *  an office, a van, or somebody who does not want the appliance modelled. */
  provides_locations: z.array(LocationEntry).default([]),
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
  catalogs: z.array(CatalogEntry).default([]),
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
  /** Places this bundle would set up, and - just as important - which of them
   *  ALREADY exist and will be merged into rather than duplicated. Showing only
   *  the new rows would leave a user guessing whether their Kitchen is about to
   *  be cloned. */
  locations_planned: Array<{
    name: string;
    parent_name: string | null;
    kind: "area" | "container";
    exists: boolean;
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
  /** Optional features this version declares that the workspace has never been
   *  asked about. NOT enabled - carried so a surface can offer them. Empty on a
   *  first install, where the checkboxes were on screen anyway. */
  featuresToOffer?: Array<{ key: string; name?: string; question?: string; description?: string }>;
}

/**
 * What this workspace already has installed of this bundle, if anything.
 *
 * Returns null when nothing is installed, which is what makes a first install
 * distinguishable from an update - and that distinction is the whole point:
 * `default: true` may switch a feature on for the former and never for the
 * latter. Returning an empty array for both would reintroduce the bug.
 */
async function readInstalledFeatures(
  orgId: string,
  externalId: string,
): Promise<{ enabled: string[]; declared: Array<{ key: string; default?: boolean }> | null } | null> {
  const row = await meta
    .selectFrom("bundles")
    .select(["enabled_features", "manifest"])
    .where("org_id", "=", orgId)
    .where("external_id", "=", externalId)
    .executeTakeFirst();
  if (!row) return null;
  const raw = row.manifest as unknown;
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const declared = (parsed as { features?: Array<{ key: string; default?: boolean }> } | null)?.features ?? null;
  return { enabled: (row.enabled_features as string[] | null) ?? [], declared };
}

const moduleOf = (id: string): string | null => (id.includes(":") ? (id.split(":")[0] ?? null) : null);

/** The module that OWNS a kind. A kind is `<module>:...` OR `<instance>:item`,
 *  and for an INSTANCE the prefix is the instance NAME, not a module
 *  (`bookshelf:item` belongs to `inventory`, not a module called `bookshelf`).
 *  So resolve the prefix through `instanceModule` (instance_name → module_name)
 *  before trusting it. Taking the bare `:`-prefix as a module is a recurring
 *  bug: it made "enable Bookshelf labels" fail with `unknown_module bookshelf`,
 *  because the labels wire's `bookshelf:item` source_kind demanded a nonexistent
 *  `bookshelf` module. Reach for THIS, never `split(":")[0]`, whenever the module
 *  name feeds a require/enable/exists decision on a kind that could be an
 *  instance. `moduleOf` alone is safe only for `<module>:<action>` ids. */
function moduleForKind(kind: string, instanceModule: ReadonlyMap<string, string>): string | null {
  const prefix = moduleOf(kind);
  return prefix && instanceModule.has(prefix) ? instanceModule.get(prefix)! : prefix;
}

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
    // Without this a feature could declare places and they would never be
    // applied - the exact silent-inert failure a default-off feature makes
    // hardest to notice.
    provides_locations: [...(full.provides_locations ?? []), ...on.flatMap((f) => f.provides_locations ?? [])],
    catalogs: [...(full.catalogs ?? []), ...on.flatMap((f) => f.catalogs ?? [])],
  };
}

/** A manifest as stored or as sent: the parsed shape, or a loose JSON copy of
 *  it (a snapshot's jsonb). Only the keys that declare fields and wires. */
interface DeclaringManifest {
  field_defs?: ReadonlyArray<{ entity_kind: string; name: string }>;
  wires?: readonly unknown[];
  provides_instances?: ReadonlyArray<{
    instance_name: string;
    field_defs?: ReadonlyArray<{ name: string }>;
    wires?: readonly unknown[];
  }>;
  features?: readonly DeclaringManifest[];
}

/** Every field a manifest declares, wherever it declares it: the base kinds,
 *  each table it provides (stored under `<instance_name>:item`, the kind the
 *  install writes), and every optional feature. A reader that walks
 *  `field_defs` alone sees an instance bundle as having no fields at all, and
 *  then reads each of its fields as "removed by the update". */
export function declaredFieldDefs<F extends { name: string }>(
  m: DeclaringManifest & { field_defs?: ReadonlyArray<F & { entity_kind: string }>; provides_instances?: ReadonlyArray<{ instance_name: string; field_defs?: readonly F[] }> },
): Array<{ entity_kind: string; def: F }> {
  const out: Array<{ entity_kind: string; def: F }> = [];
  const walk = (x: DeclaringManifest) => {
    for (const f of (x.field_defs ?? []) as ReadonlyArray<F & { entity_kind: string }>) out.push({ entity_kind: f.entity_kind, def: f });
    for (const inst of x.provides_instances ?? []) {
      for (const f of (inst.field_defs ?? []) as readonly F[]) out.push({ entity_kind: `${inst.instance_name}:item`, def: f });
    }
    for (const feat of x.features ?? []) walk(feat);
  };
  walk(m);
  return out;
}

/** Every wire a manifest declares: base, per table, per feature. */
export function declaredWireCount(m: DeclaringManifest): number {
  let n = (m.wires ?? []).length;
  for (const inst of m.provides_instances ?? []) n += (inst.wires ?? []).length;
  for (const feat of m.features ?? []) n += declaredWireCount(feat);
  return n;
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
  // validates/previews the resolved set.
  //
  // `default: true` is a FIRST-INSTALL concept - it means "most people setting
  // this up want this", and the checkbox is on screen when they press the
  // button. On an UPDATE nobody is asked anything, so falling back to the new
  // version's defaults silently opts a workspace into something it has never
  // seen. That shipped: a groceries update turned on a feature that CREATES
  // PLACES and made a Fridge, Freezer and Pantry inside a Kitchen somebody had
  // already arranged. See platform/feature-defaults.ts.
  const priorInstall = await readInstalledFeatures(orgId, full.id);
  const resolvedFeatures = resolveEnabledFeatures({
    declared: full.features,
    ...(opts.enabledFeatures !== undefined ? { requested: opts.enabledFeatures } : {}),
    installed: priorInstall?.enabled ?? null,
  });
  const enabledFeatures = resolvedFeatures.enabled;
  const offer = pickFeaturesToOffer(full.features, priorInstall?.enabled ?? null, priorInstall?.declared ?? null);
  const selected = resolveManifestFeatures(full, enabledFeatures);
  const m = {
    ...selected,
    requires: selected.requires.map(r => ({ ...r, module: canonicalModuleName(r.module) })),
    provides_instances: selected.provides_instances.map(i => ({ ...i, module: canonicalModuleName(i.module) })),
  };
  const errors: BundleValidationError[] = [];
  for (const [kind, layout] of Object.entries(m.record_actions)) {
    const declared = new Set<string>(ACTION_GROUPS.map((g) => g.id));
    for (const g of layout.groups) {
      const existing = similarActionGroup(g.id) ?? similarActionGroup(g.label);
      if (existing && g.id !== existing.id) errors.push({ path: `record_actions.${kind}.groups`, code: "similar_action_group", message: `Looks like ${existing.label}; use ${existing.id} instead of creating ${g.label}.` });
      else if (!declared.has(g.id) && !g.id.startsWith(`bundle:${m.id}/`)) errors.push({ path: `record_actions.${kind}.groups`, code: "action_group_namespace", message: "New bundle groups use bundle:<bundle id>/<group> ids." });
      declared.add(g.id);
    }
    for (const [id, action] of Object.entries(layout.actions)) if (action.group && !declared.has(action.group)) errors.push({ path: `record_actions.${kind}.actions.${id}`, code: "unknown_action_group", message: "Choose a registered group or declare a group in this bundle." });
  }


  // 2. Referential — every referenced kind/action exists + is applicable.
  const knownKinds = await platform().entities.listKinds();
  const knownKindIds = new Set(knownKinds.map((k) => k.id));
  const kindList = [...knownKindIds].sort().join(", ") || "(none)";

  // A kind like `bookshelf:item` names an INSTANCE, not a registered kind: it
  // doesn't exist in the registry at validate time (this bundle, or a prior one,
  // creates the instance), but post-install it IS a real kind — the instance's
  // module PRIMARY. Build the instance→module map (this bundle's own
  // provides_instances + instances the workspace already has) and resolve a
  // referenced kind to what it will BE, so a top-level wire/field on an instance
  // kind validates instead of being rejected as unknown. This is the exact bug
  // behind "enable Bookshelf labels": the merged `labels` feature wires
  // `bookshelf:item`, which the base install never surfaced. (The
  // provides_instances wire loop below already did this for INSTANCE wires; this
  // extends it to the top level, where merged features land.)
  const primaryByModule = new Map(
    knownKinds.filter((k) => k.is_primary).map((k) => [k.module_name, k] as const),
  );
  const instanceModule = new Map<string, string>();
  for (const pi of m.provides_instances) instanceModule.set(pi.instance_name, pi.module);
  for (const inst of await listInstances(orgId)) instanceModule.set(inst.instance_name, inst.module_name);
  // The REGISTERED kind a referenced kind validates as: itself if known, else —
  // ONLY for the canonical instance form `<instance>:item` (entities.ts) whose
  // prefix is a known instance — the primary of that instance's module, else
  // null (genuinely unknown). The `:item` guard matters: `inventory:prat` is a
  // TYPO, not an instance kind, and must stay unknown even though `inventory`
  // resolves to a module.
  const resolvedKind = (kind: string): string | null => {
    if (knownKindIds.has(kind)) return kind;
    const [prefix, suffix] = kind.split(":");
    if (suffix !== "item" || !prefix) return null;
    const mod = instanceModule.get(prefix);
    const primary = mod ? primaryByModule.get(mod) : undefined;
    return primary ? primary.id : null;
  };

  for (const f of [...m.field_defs, ...m.provides_instances.flatMap((i) => i.field_defs)]) {
    if (f.ref_kind && !resolvedKind(f.ref_kind)) errors.push({ path: "field_defs.ref_kind", code: "unknown_entity_kind", message: `Unknown relation target "${f.ref_kind}".` });
  }

  for (const f of m.field_defs) {
    // A trait SCOPE (`@physical`) is not a registered kind, deliberately: it
    // matches a CLASS of kinds through the same predicate actions use, so new
    // kinds inherit the field with no migration. Checking it against the kind
    // registry rejected every fields-only pack, which is the shape a shared
    // custom field takes. Validate the traits instead of the kind id.
    if (isFieldScope(f.entity_kind)) {
      if (parseFieldScope(f.entity_kind).length === 0) {
        errors.push({
          path: "field_defs.entity_kind",
          code: "unknown_field_scope",
          message: `"${f.entity_kind}" names no known trait. Use a scope like "@physical".`,
        });
      }
      continue;
    }
    if (!resolvedKind(f.entity_kind)) {
      errors.push({
        path: "field_defs.entity_kind",
        code: "unknown_entity_kind",
        message: `Unknown entity kind "${f.entity_kind}". Use one of: ${kindList}.`,
      });
    }
  }

  // Actions applicable to each referenced source_kind (resolves appliesTo). An
  // instance kind resolves to its module primary — instances share the module's
  // actions, so applicability is the same.
  const referencedKinds = new Set<string>(
    m.wires.map((w) => resolvedKind(w.source_kind)).filter((k): k is string => k !== null),
  );
  // The wires are judged against the workspace as this install will leave it:
  // what it has on, plus every module the bundle requires or its wires' actions
  // belong to, since the install enables those before it wires anything. A
  // module that will NOT be enabled (unregistered, or an update that may not
  // enable) is reported by the dependency check below, once, by name.
  const turnsOn = [
    ...new Set([
      ...m.requires.map((r) => r.module),
      ...m.wires.map((w) => moduleOf(w.action_id)),
      ...m.provides_instances.flatMap((i) => i.wires.map((w) => moduleOf(w.action_id))),
    ]),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  const actionsByKind = new Map<string, Set<string>>();
  for (const kind of referencedKinds) {
    const apps = await platform().actions.listApplicable(kind, orgId, { alsoOn: turnsOn });
    actionsByKind.set(kind, new Set(apps.map((a) => a.id)));
  }
  for (const w of m.wires) {
    const rk = resolvedKind(w.source_kind);
    if (rk === null) {
      errors.push({
        path: "wires.source_kind",
        code: "unknown_entity_kind",
        message: `Unknown entity kind "${w.source_kind}" in a wire. Use one of: ${kindList}.`,
      });
      continue;
    }
    const applicable = actionsByKind.get(rk) ?? new Set<string>();
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

  // Instance wires were never validated: referencedKinds above collects only
  // top-level m.wires, so a provides_instances wire could name an action that
  // can't apply and still install clean — then silently never fire. Its
  // source_kind (`<instance>:item`) doesn't exist yet at validate time (this
  // bundle creates it), so check against the kind the instance will BE: its
  // module's primary. (primaryByModule is built up top, with instanceModule.)
  for (const inst of m.provides_instances) {
    const primary = primaryByModule.get(inst.module);
    if (!primary) continue; // an unknown module is already reported elsewhere
    const applicable = new Set(
      (await platform().actions.listApplicable(primary.id, orgId, { alsoOn: turnsOn })).map((a) => a.id),
    );
    for (const w of inst.wires) {
      if (!applicable.has(w.action_id)) {
        const list = [...applicable].sort().join(", ") || "(none)";
        errors.push({
          path: "provides_instances.wires.action_id",
          code: "action_not_applicable",
          message: `Action "${w.action_id}" can't be wired to instance "${inst.instance_name}" (a ${primary.id}). Actions available: ${list}.`,
        });
      }
      if (w.filter != null) {
        const { error } = parseWireFilter(w.filter);
        if (error) {
          errors.push({ path: "provides_instances.wires.filter", code: "invalid_wire_filter", message: error });
        }
      }
    }
  }

  // requires[] must name the module owning every referenced kind + action.
  // moduleForKind resolves an instance-kind prefix to its owning module
  // (instanceModule, built up top) — `bookshelf:item` -> `inventory`, not a
  // module named `bookshelf`. Splitting on ":" and trusting the prefix was the
  // dependency half of the "enable Bookshelf labels" bug (unknown_module
  // bookshelf); the referential half (unknown_entity_kind) is resolvedKind above.
  const declaredRequires = new Set(m.requires.map((r) => r.module));
  const neededModules = new Set<string>();
  for (const f of m.field_defs) { const mod = moduleForKind(f.entity_kind, instanceModule); if (mod) neededModules.add(mod); }
  for (const w of m.wires) {
    const k = moduleForKind(w.source_kind, instanceModule); if (k) neededModules.add(k);
    // action_id is always `<module>:<action>` — a real module, never an instance.
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
  const allRequired = [...new Set([...declaredRequires, ...neededModules].map(canonicalModuleName))];
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
      if (getEntry(mod)?.manifest.retirement) {
        errors.push({ path: "requires", code: "module_retired", message: `Module "${mod}" is retired. ${getEntry(mod)!.manifest.retirement!.reason}` });
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
      // The scan platform auto-creates a placeholder `category` axis on the scan
      // fallback table (reconcile-scan-category, a platform sentinel source). It's a
      // PLACEHOLDER — a bundle shipping its own `category` field for the same kind
      // SUPERSEDES it, so it must never count as a collision. (12 flagship bundles
      // ship `category`; without this each would 409 on any workspace the reconcile
      // touched.) The install replaces the placeholder with the bundle's field.
      // NULL-safe: a USER field has source_module NULL, and `NOT(NULL = x)` is
      // NULL (drops the row), which would silently hide every real user collision.
      .where((eb) => eb.or([eb("fd.source_module", "is", null), eb("fd.source_module", "!=", SCAN_CATEGORY_SOURCE)]))
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
      const curByKey = new Map(curDefs.map((d) => [`${d.entity_kind}\x00${d.name}`, d]));
      const newByKey = new Map(declaredFieldDefs(m).map(({ entity_kind, def }) => [`${entity_kind}\x00${def.name}`, def]));
      const userOvrs = await meta
        .selectFrom("native_field_overrides")
        .select(["entity_kind", "name", "display_label", "overrides"])
        .where("org_id", "=", orgId)
        .where("bundle_id", "is", null)
        .execute();
      const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      for (const o of userOvrs) {
        const key = `${o.entity_kind}\x00${o.name}`;
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
        // Your list already carries every option the update offers: keeping
        // it loses nothing, so there is nothing to decide.
        const nothingNewForYou = (incoming.choices ?? []).every((c) => userChoices?.includes(c));
        if (userChoices != null && !sameJson(incoming.choices, cur.choices) && !nothingNewForYou) {
          upgradeConflicts.push({ entity_kind: o.entity_kind, name: o.name, field_label: fieldLabel, attr: "choices", yours: userChoices, theirs: incoming.choices ?? null });
        }
      }
    }
  }

  // What the places would do to THIS workspace, resolved against what is
  // already there. Computed by the same planner the applier uses, so the
  // preview and the write cannot drift apart.
  let locationsPlanned: BundleValidationPreview["locations_planned"] = [];
  if ((m.provides_locations ?? []).length > 0) {
    try {
      const plan = await previewBundleLocations(orgId, m.provides_locations);
      locationsPlanned = plan.map((p) => ({
        name: p.name,
        parent_name: p.parentName,
        kind: p.kind,
        exists: p.exists,
      }));
    } catch {
      // A preview that cannot read the tree says nothing rather than guessing.
      locationsPlanned = [];
    }
  }

  const preview: BundleValidationPreview = {
    fields_added: m.field_defs.map((f) => ({ entity_kind: f.entity_kind, name: f.name, type: f.type, display_label: f.display_label })),
    wires_added: m.wires.map((w) => ({ source_kind: w.source_kind, action_id: w.action_id, trigger_type: w.trigger_type })),
    locations_planned: locationsPlanned,
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
  return {
    valid: errors.length === 0,
    errors,
    preview,
    manifest: m,
    fullManifest: full,
    enabledFeatures,
    featuresToOffer: offer.map((f) => {
      const d = full.features.find((x) => x.key === f.key);
      return {
        key: f.key,
        ...(d?.name ? { name: d.name } : {}),
        ...(d?.question ? { question: d.question } : {}),
        ...(d?.description ? { description: d.description } : {}),
      };
    }),
  };
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
        .select(["entity_kind", "name", "display_label", "type", "required", "position", "unit", "ref_kind"])
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
      // Resolve instance-kind prefixes to their owning module (see
      // moduleForKind): a wire/field/view on `bookshelf:item` references the
      // `inventory` module, not a `bookshelf` one. Without this the filter below
      // drops the instance prefix and the exported manifest silently omits the
      // owning module from requires — so re-installing it on a fresh org fails.
      const exportInstanceModule = new Map(
        (await listInstances(orgId)).map((i) => [i.instance_name, i.module_name] as const),
      );
      const referencedModules = new Set<string>();
      for (const w of wires) {
        const srcMod = moduleForKind(w.source_kind, exportInstanceModule);
        const actMod = moduleOf(w.action_id);
        if (srcMod) referencedModules.add(srcMod);
        if (actMod) referencedModules.add(actMod);
      }
      for (const f of fieldDefs) {
        const m = moduleForKind(f.entity_kind, exportInstanceModule);
        if (m) referencedModules.add(m);
      }
      for (const v of savedViews) {
        const m = moduleForKind(v.entity_kind, exportInstanceModule);
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
      // UTC-DAY OK: the manifest's capture stamp, not a claim about anybody's calendar.
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
          ref_kind: f.ref_kind ?? undefined,
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

// GET /passed — the bundles this workspace installed and later took out. A
// suggestion ("Works with Lists") is never made for one: the workspace has
// already tried it and said no.
bundlesRouter.get(
  "/passed",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      const rows = await meta
        .selectFrom("bundle_snapshots")
        .select("external_id")
        .distinct()
        .where("org_id", "=", req.tenant!.org.id)
        .where("reason", "=", "uninstalled")
        .execute();
      res.json({ items: rows.map((r) => r.external_id) });
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
// AI-REACH: a read. Always 200, writes nothing: it answers whether a candidate
// bundle would install. Installing it is the route with the door.
bundlesRouter.post(
  "/validate",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      // ROLE: any member (a read: whether a bundle would install; installing has its own check)
      const Body = z.object({
        manifest: z.unknown(),
        autoEnable: z.boolean().optional(),
        // Preview the bundle WITH these optional features on — the same set the
        // install modal would send. Without it, /validate only ever checks the
        // base manifest, so a feature that only fails when enabled (e.g. a wire
        // on an instance kind) passes here and breaks on the real toggle.
        enabled_features: z.array(z.string()).optional(),
      });
      const body = Body.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "Bad request body", details: body.error.issues } });
        return;
      }
      const result = await validateBundle(req.tenant!.org.id, body.data.manifest, {
        autoEnable: body.data.autoEnable ?? false,
        ...(body.data.enabled_features !== undefined ? { enabledFeatures: body.data.enabled_features } : {}),
      });
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
/** ONE row shape for a bundle-declared field def, whether it is scoped to a
 *  module kind or to an instance's `<name>:item`. The two install loops used
 *  to build this literal separately, and the instance copy lost `field_role`:
 *  a groceries app filed eight items and dated none, because the expiry stamp
 *  reads the role and the role never arrived (2026-09-02). Roles ride here. */
/** The form-builder section each named `section` of a set of field defs is
 *  filed under, for one kind: found by name, or made after the kind's last
 *  section, in the order the sections first appear among the fields (by
 *  position). A person's own sections are left as they are. */
async function bundleSectionIds(
  trx: Kysely<MetaDB>,
  orgId: string,
  entityKind: string,
  defs: ReadonlyArray<{ section?: string; position?: number }>,
): Promise<Map<string, string>> {
  const names: string[] = [];
  for (const f of [...defs].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (f.section && !names.includes(f.section)) names.push(f.section);
  }
  const out = new Map<string, string>();
  if (!names.length) return out;
  const have = await trx.selectFrom("field_sections").select(["id", "name", "position"]).where("org_id", "=", orgId).where("entity_kind", "=", entityKind).execute();
  let next = have.reduce((m, r) => Math.max(m, r.position), -1) + 1;
  for (const name of names) {
    const found = have.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (found) {
      out.set(name, found.id);
      continue;
    }
    const made = await trx.insertInto("field_sections").values({ org_id: orgId, entity_kind: entityKind, name, position: next }).returning("id").executeTakeFirstOrThrow();
    have.push({ id: made.id, name, position: next++ });
    out.set(name, made.id);
  }
  return out;
}

type PriorDefs = { field_defs?: Array<{ entity_kind?: string; name?: string; section?: string }>; provides_instances?: Array<{ instance_name?: string; field_defs?: Array<{ name?: string; section?: string }> }> };

/** The section each of these installed versions' fields sits in, where it is
 *  not the one that version declared: a person put it there (or took it out
 *  of one), so it is theirs to keep. Keyed `<kind>\u0000<name>`. */
async function personPlacedSections(
  orgId: string,
  versions: ReadonlyArray<{ id: string; manifest: unknown }>,
): Promise<Map<string, string | null>> {
  const declared = new Map<string, string>();
  for (const v of versions) {
    const pm = (typeof v.manifest === "string" ? JSON.parse(v.manifest) : v.manifest) as (PriorDefs & { features?: PriorDefs[] }) | null;
    for (const part of [pm, ...(pm?.features ?? [])]) {
      for (const f of part?.field_defs ?? []) if (f.entity_kind && f.name && f.section) declared.set(`${f.entity_kind}\u0000${f.name}`, f.section);
      for (const inst of part?.provides_instances ?? []) {
        for (const f of inst.field_defs ?? []) if (inst.instance_name && f.name && f.section) declared.set(`${inst.instance_name}:item\u0000${f.name}`, f.section);
      }
    }
  }
  const rows = await meta
    .selectFrom("module_field_defs as d")
    .leftJoin("field_sections as s", "s.id", "d.section_id")
    .select(["d.entity_kind", "d.name", "d.section_id", "s.name as section_name"])
    .where("d.org_id", "=", orgId)
    .where("d.bundle_id", "in", versions.map((v) => v.id))
    .execute();
  const out = new Map<string, string | null>();
  for (const r of rows) {
    const key = `${r.entity_kind}\u0000${r.name}`;
    const was = declared.get(key)?.toLowerCase() ?? null;
    if ((r.section_name?.toLowerCase() ?? null) !== was) out.set(key, r.section_id);
  }
  return out;
}

function fieldDefRow(
  orgId: string,
  entityKind: string,
  f: z.infer<typeof FieldDefEntry>,
  bundleId: string,
  sections?: ReadonlyMap<string, string>,
  kept?: ReadonlyMap<string, string | null>,
) {
  const key = `${entityKind}\u0000${f.name}`;
  return {
    section_id: kept?.has(key) ? (kept.get(key) ?? null) : (f.section && sections?.get(f.section)) || null,
    org_id: orgId,
    entity_kind: entityKind,
    name: f.name,
    display_label: f.display_label,
    type: f.type,
    ref_kind: bundleFieldReference(f.type, f.ref_kind),
    required: f.required ?? false,
    position: f.position ?? 0,
    bundle_id: bundleId,
    // Dropdown choices when the bundle supplies them (specialisation bundles
    // use this for hotend / firmware / spindle etc.).
    choices: f.choices ? JSON.stringify(f.choices) : null,
    renderer: (f as { renderer?: string | null }).renderer ?? null,
    template: f.type === "computed" ? f.template ?? null : null,
    help: f.help ?? null,
    unit: fieldTypeTakesUnit(f.type) ? f.unit ?? null : null,
    decode_role: (f as { decode_role?: string | null }).decode_role ?? null,
    field_role: (f as { field_role?: string | null }).field_role ?? null,
    learns: (f as { learns?: boolean | null }).learns ?? null,
    aggregate: f.aggregate ?? null,
  };
}

/** The `overrides` jsonb for a native-field override: a decode role (P3) and
 *  a record role, the native twins of module_field_defs.decode_role /
 *  .field_role. Merged, so a co-located `choices` on a bundle row survives;
 *  null when the override carries neither, so the default '{}' stands. */
function roleOverridesBlob(fo: { decode_role?: string; field_role?: string }) {
  return fo.decode_role || fo.field_role
    ? sql`(
        coalesce(${fo.decode_role ? sql`jsonb_build_object('decode_role', ${fo.decode_role}::text)` : sql`'{}'::jsonb`}, '{}'::jsonb)
        || coalesce(${fo.field_role ? sql`jsonb_build_object('field_role', ${fo.field_role}::text)` : sql`'{}'::jsonb`}, '{}'::jsonb)
      )`
    : null;
}

/** What the person chose for one conflicting item: keep theirs as they have
 *  it, take the update's, or (for a list of options) keep both lists. */
export const ConflictResolutionSchema = z
  .object({
    entity_kind: z.string().min(1),
    name: z.string().min(1),
    attr: z.enum(["label", "choices", "removed"]),
    choice: z.enum(["mine", "theirs", "both"]),
  })
  .refine((r) => r.choice !== "both" || r.attr === "choices", {
    message: "keep both applies to a list of options only; a name or a removed field is yours or the update's",
  });
export type ConflictResolution = z.infer<typeof ConflictResolutionSchema>;

/** Apply one answer to the person's own override row (bundle_id null). Only
 *  the part in conflict moves: taking the update's options leaves a renamed
 *  label alone. "both" exists only for options (the schema refuses it
 *  elsewhere), where it is the union with the person's own first. */
async function resolveUpgradeConflict(
  orgId: string,
  r: ConflictResolution,
  conflicts: BundleValidationPreview["upgrade_conflicts"],
): Promise<void> {
  if (r.choice === "mine") return;
  const c = conflicts.find((x) => x.entity_kind === r.entity_kind && x.name === r.name && x.attr === r.attr);
  if (!c) return; // not a conflict this update has: nothing of theirs to take
  const row = meta
    .updateTable("native_field_overrides")
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", r.entity_kind)
    .where("name", "=", r.name)
    .where("bundle_id", "is", null);
  if (r.attr === "removed") {
    await meta
      .deleteFrom("native_field_overrides")
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", r.entity_kind)
      .where("name", "=", r.name)
      .where("bundle_id", "is", null)
      .execute();
    return;
  }
  if (r.attr === "label") {
    await row.set({ display_label: null, updated_at: sql`now()` }).execute();
    return;
  }
  const yours = Array.isArray(c.yours) ? c.yours : [];
  const theirs = Array.isArray(c.theirs) ? c.theirs : [];
  if (r.choice === "theirs") {
    await row.set({ overrides: sql`overrides - 'choices'`, updated_at: sql`now()` }).execute();
    return;
  }
  const both = [...yours, ...theirs.filter((t) => !yours.includes(t))];
  await row
    .set({ overrides: sql`jsonb_set(overrides, '{choices}', ${JSON.stringify(both)}::jsonb)`, updated_at: sql`now()` })
    .execute();
}

/** Apply a validated bundle: one install per workspace at a time (see
 *  withWorkspaceLock), so a double press or a retried request is a reinstall,
 *  never a 500 on a unique key half way through. */
export async function applyValidatedBundle(...args: Parameters<typeof applyValidatedBundleUnlocked>): ReturnType<typeof applyValidatedBundleUnlocked> {
  return withWorkspaceLock(args[0], "bundle-apply", () => applyValidatedBundleUnlocked(...args));
}

async function applyValidatedBundleUnlocked(
  orgId: string,
  sess: { id: string; display_name?: string | null; auth_method: "session" | "api_token" | "system"; api_token_id?: string | null },
  v: BundleValidationResult,
  opts: {
    takeTheirs?: Array<{ entity_kind: string; name: string }>;
    /** One answer per upgrade conflict, from the update's conflict view.
     *  Absent for a conflict: keep yours. */
    resolutions?: ConflictResolution[];
    /** The word picked for a table that offers them, by instance name
     *  ("yarn" → "skein"). Absent: the stored choice, else the default. */
    nounChoices?: Record<string, string>;
    /** Re-applying a bundle that is already installed (a feature save, a
     *  word change) is not an install: false writes no "installed" row, so
     *  one install never reads "installed ×2" on the dashboard (#4145). The
     *  caller logs what it did instead. */
    logInstall?: boolean;
  } = {},
): Promise<{
  bundle: { id: string; external_id: string; name: string; version: string };
  applied: {
    wires: number; field_defs: number; field_overrides: number; catalogs: number;
    auto_enabled_modules: string[]; migrations: Array<{ to_version: string; action: string; result: unknown }>;
    /** The tables this apply CREATED, and the ones it found already there.
     *  An install is idempotent over instances; the report is not allowed
     *  to be (the toast said "added a table" over a table that existed). */
    instances_created: string[]; instances_existing: string[];
  };
}> {
  // The words each table's person picked, filled into its labels before any
  // write, so every reader of the stored defs says the chosen word. The
  // stored manifest keeps the {{noun}} tokens, so a later change re-fills.
  const storedChoices = await storedNounChoices(orgId);
  const m = withNounsFilled(v.manifest!, (name) => opts.nounChoices?.[name] ?? storedChoices.get(name) ?? null);
  // Apply the RESOLVED manifest (m); store the FULL manifest (features
  // intact) + which features were enabled, so they can be toggled later.
  const fullManifest = v.fullManifest ?? v.manifest!;
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

  for (const r of opts.resolutions ?? []) await resolveUpgradeConflict(orgId, r, v.preview?.upgrade_conflicts ?? []);

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
  // This install switched these on, so it claims them: an uninstall switches
  // them off again when nothing else claims them and they hold nothing (#3918).
  // A module that was already on is not in this list and never claimed here.
  await recordClaims(orgId, m.id, autoEnabled.map((name) => ({ resource_type: "module" as const, resource_key: name })));

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
  // The count unit each instance's records defaulted to in the PREVIOUS
  // version ("skein"). When a version changes it ("ball"), the records still
  // on the old default follow; one someone set to anything else is theirs.
  const priorInstanceUnits = new Map<string, string>();
  const priorBundle =
    existing.length > 0
      ? [...existing].sort((a, b) => cmpVersion(a.version, b.version)).at(-1)
      : null;
  if (priorBundle) {
    const rawPm = priorBundle.manifest;
    type PriorInstance = { instance_name?: string; display_name?: string; qty_unit?: string; noun?: NounChoiceDecl };
    const pm = (typeof rawPm === "string" ? JSON.parse(rawPm) : rawPm) as
      | { provides_instances?: PriorInstance[]; features?: Array<{ provides_instances?: PriorInstance[] }> }
      | null;
    // A feature's tables too: Yarn's Designs table is an optional feature's
    // instance, and reading only the top level left it saying "Designs" after
    // the version that renamed it to Patterns.
    // As they were ON SCREEN: a table whose person picked "skein" had skein
    // as its unit, whatever the manifest's default said.
    const priorInstances = [...(pm?.provides_instances ?? []), ...(pm?.features ?? []).flatMap((f) => f.provides_instances ?? [])].map((pi) =>
      pi.noun && pi.instance_name ? fillInstanceNoun(pi, chosenNoun(pi.noun, { singular: storedChoices.get(pi.instance_name) ?? null })) : pi,
    );
    for (const pi of priorInstances) {
      if (pi.instance_name && typeof pi.display_name === "string") {
        priorInstanceLabels.set(pi.instance_name, pi.display_name);
      }
      if (pi.instance_name && typeof pi.qty_unit === "string" && pi.qty_unit.trim()) {
        priorInstanceUnits.set(pi.instance_name, pi.qty_unit.trim());
      }
    }
  }
  // Where a person moved one of this bundle's fields ("Spool" → "Printing",
  // or out of any section), keyed kind + name. The replace below re-inserts
  // every def, so without this an update would put their fields back where
  // the bundle first had them. A field still in the section the previous
  // version gave it follows the new version's.
  const keptSections = existing.length > 0 ? await personPlacedSections(orgId, existing) : new Map<string, string | null>();
  for (const old of existing) {
    await uninstallBundleId(old.id, { snapshotReason: "replaced" });
  }

  // Set up the places this bundle offers. Find-or-create per CHILD, so a
  // workspace that already has a Kitchen gets a Fridge added INSIDE it rather
  // than a second Kitchen alongside - and whatever was already in that Kitchen
  // is left exactly where it is. Failure here never fails the install: places
  // are a convenience, and a bundle whose fields and wires landed is still
  // useful without them.
  if ((m.provides_locations ?? []).length > 0) {
    try {
      const made = await applyBundleLocations(orgId, m.provides_locations);
      // Claim only the places this install MADE; a Kitchen that was already
      // there is the workspace's, and an uninstall never touches it.
      await recordClaims(orgId, m.id, made.createdIds.map((id) => ({ resource_type: "place" as const, resource_key: id })));
    } catch (err) {
      console.error(`[bundles] locations for ${m.id} not applied:`, (err as Error).message);
    }
  }

  // Create the module instances this bundle ships (skinned copies of a
  // multi-instance module — e.g. a "Yarn" instance of inventory). Their
  // field defs / views / wires are applied below scoped to `<name>:item`.
  // Idempotent: skip createInstance if the instance already exists; the nav
  // override is insert-only so a re-install won't clobber a user's rename.
  const instancesCreated: string[] = [];
  const instancesExisting: string[] = [];
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
      instancesCreated.push(inst.instance_name);
    } else {
      instancesExisting.push(inst.instance_name);
    }
    // The table's routing vocabulary is BOTH lists, deduped: the instance's own
    // words and the manifest's. The offer for a not-yet-installed bundle has
    // merged them since 2026-08-19 (flagshipBundleMenu: "a bundle's declared
    // vocabulary should not vanish because it grew a table"), but the install
    // wrote only the instance's, so an installed Groceries knew 40 words while
    // the offer knew 150, and the dashboard's sample cola filed into plain
    // Inventory in a sandbox whose Groceries declared "cola" one level up
    // (2026-09-12). The instance's words come first so a table-specific term
    // wins any first-match read.
    const tableWords = bundleTableWords(inst.scan_keywords, m.scan_keywords);
    const instConfig: Record<string, unknown> = { renewal_fields: inst.renewal_fields ?? null, record_templates: inst.record_templates ?? null, receipt_draft: inst.receipt_draft ?? null, item_noun: inst.item_noun ?? null, qty_unit: inst.qty_unit ?? null, parent: inst.parent ?? null, package_receiving: inst.package_receiving ?? null, paste_tracking: inst.paste_tracking ?? false, board_revisions: inst.board_revisions ?? null, nav_group: inst.nav_group ?? null, scan_keywords: tableWords.length ? tableWords : null, faces: inst.faces ?? null, file_intake: inst.file_intake ?? null, connector_import: (inst as { connector_import?: unknown }).connector_import ?? null, noun: inst.noun ?? null, hint: inst.hint ?? null, links: inst.links ?? null, noun_choice: (inst as { noun_choice?: unknown }).noun_choice ?? null, contents_label_default: inst.contents_label ?? null, service_tasks_default: inst.service_tasks ?? null };
    // Creation-time stock signal: a bundle that declares a MEASURED unit (a
    // qty_unit that isn't blank or "each" — filament in kg, yarn in skeins)
    // carries stock character before any data exists, so latch it to stock at
    // install. A catalog bundle (qty_unit "each" or unset) omits the key and
    // discloses lean until it takes a stock-shaped write. Derived from the
    // declared field, not a use-case flag. See one-record-substrate.md.
    const declaredUnit = typeof inst.qty_unit === "string" ? inst.qty_unit.trim() : "";
    if (declaredUnit !== "" && declaredUnit !== "each") instConfig.stock_latched = true;
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
    // on an already-installed instance. MERGE rather than replace (`config ||
    // instConfig`): bundle-owned keys refresh, but keys the bundle never sets —
    // the user's `stock` override and a data-set `stock_latched` — survive the
    // upgrade instead of being wiped (a replace clobbered them).
    await meta
      .updateTable("entity_kind_overrides")
      .set({ config: sql`coalesce(config, '{}'::jsonb) || ${JSON.stringify(instConfig)}::jsonb` as never, updated_at: new Date() })
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
    // A bundle-owned change of the default count unit reaches the records that
    // still carry the old default. The module that owns the rows moves them;
    // the kernel only says what changed (yarn went from skein to ball: nobody
    // knew what a skein was).
    const priorUnit = priorInstanceUnits.get(inst.instance_name);
    const newUnit = typeof inst.qty_unit === "string" ? inst.qty_unit.trim() : "";
    if (priorUnit && newUnit && priorUnit !== newUnit) {
      await platform().events.emit("platform.instance.default-unit-changed", {
        orgId,
        module: inst.module,
        instance: inst.instance_name,
        from: priorUnit,
        to: newUnit,
      });
    }
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
        // The installed bundle keeps its id through an update or a feature
        // change: an open sheet, a link or a bookmark holding it stays good.
        ...(priorBundle ? { id: priorBundle.id } : {}),
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
          label: w.label ?? null,
          ask: w.ask?.length ? sql`${JSON.stringify(w.ask)}::jsonb` : null,
          bundle_id: bundle.id,
          target: w.target
            ? sql`${JSON.stringify(w.target)}::jsonb`
            : sql`'"self"'::jsonb`,
        })
        .execute();
    }
    // Replace the platform category placeholder (reconcile-scan-category) with the
    // bundle's own field for any kind this bundle defines — so the bundle's
    // definition wins and there's never a duplicate `category` axis or a unique
    // collision. (The collision pre-check already excludes the platform sentinel.)
    if (m.field_defs.length) {
      await trx
        .deleteFrom("module_field_defs")
        .where("org_id", "=", orgId)
        .where("source_module", "=", SCAN_CATEGORY_SOURCE)
        .where((eb) =>
          eb.or(m.field_defs.map((f) => eb.and([eb("entity_kind", "=", f.entity_kind), eb("name", "=", f.name)]))),
        )
        .execute();
    }
    const baseSections = new Map<string, Map<string, string>>();
    for (const kind of new Set(m.field_defs.map((f) => f.entity_kind))) {
      baseSections.set(kind, await bundleSectionIds(trx, orgId, kind, m.field_defs.filter((d) => d.entity_kind === kind)));
    }
    for (const f of m.field_defs) {
      // Q6: collisions were pre-checked above and the install
      // would have already failed with 409 field_def_collision.
      // Plain insert; the unique constraint will surface any
      // unexpected races as a 500 (and the transaction rolls
      // back).
      // check-then-insert: applyValidatedBundle runs one install per workspace at a time (withWorkspaceLock).
      await trx.insertInto("module_field_defs").values(fieldDefRow(orgId, f.entity_kind, f, bundle.id, baseSections.get(f.entity_kind), keptSections)).execute();
    }
    // Native-field overrides (relabel / show-hide). Upsert so a bundle can
    // reshape a field another bundle already touched (last writer wins);
    // tagged with bundle_id so uninstall cleans them up.
    for (const fo of m.field_overrides) {
      // A decode role (P3) and a record role ride in the open-ended `overrides`
      // jsonb blob (the native twins of module_field_defs.decode_role /
      // .field_role) — merged, so a co-located `choices` on a bundle row
      // survives. Absent → the default '{}' stands.
      const foBlob = roleOverridesBlob(fo);
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
          ...(foBlob ? { overrides: foBlob as never } : {}),
        })
        .onConflict((c) =>
          c
            .columns(["org_id", "entity_kind", "name"])
            .doUpdateSet({
              display_label: fo.display_label ?? null,
              hidden: fo.hidden ?? false,
              position: fo.position ?? 0,
              bundle_id: bundle.id,
              ...(foBlob
                ? { overrides: sql`coalesce(native_field_overrides.overrides, '{}'::jsonb) || ${foBlob}` as never }
                : {}),
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
            label: w.label ?? null,
            ask: w.ask?.length ? sql`${JSON.stringify(w.ask)}::jsonb` : null,
            bundle_id: bundle.id,
            target: w.target ? sql`${JSON.stringify(w.target)}::jsonb` : sql`'"self"'::jsonb`,
          })
          .execute();
      }
      const instSections = await bundleSectionIds(trx, orgId, kind, inst.field_defs);
      for (const f of inst.field_defs) {
        // check-then-insert: applyValidatedBundle runs one install per workspace at a time (withWorkspaceLock).
        await trx.insertInto("module_field_defs").values(fieldDefRow(orgId, kind, f, bundle.id, instSections, keptSections)).execute();
      }
      for (const fo of inst.field_overrides) {
        const foBlob = roleOverridesBlob(fo);
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
            ...(foBlob ? { overrides: foBlob as never } : {}),
          })
          .onConflict((c) =>
            c
              .columns(["org_id", "entity_kind", "name"])
              .doUpdateSet({
                display_label: fo.display_label ?? null,
                hidden: fo.hidden ?? false,
                position: fo.position ?? 0,
                bundle_id: bundle.id,
                ...(foBlob
                  ? { overrides: sql`coalesce(native_field_overrides.overrides, '{}'::jsonb) || ${foBlob}` as never }
                  : {}),
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
      // Hosted-eligibility: search + lookup + bom all route to the shared service
      // now, so a NEW catalog whose dataset the resolver holds installs as
      // source='hosted' (rows served from the service, not copied per tenant).
      // Matched by semantic_type / external_id against /datasets. Best-effort:
      // resolver down → all local. Re-install never changes an existing catalog's
      // source (a user's override stands). See docs/architecture/shared-reference-catalogs.md §4.5.
      const catResolver = (process.env.COBBLR_CATALOG_RESOLVER_URL ?? "").replace(/\/+$/, "");
      const hostedKinds = new Set<string>();
      const hostedDatasets: string[] = [];
      if (catResolver) {
        try {
          const dres = await fetch(`${catResolver}/datasets`, {
            headers: { Authorization: `Bearer ${process.env.COBBLR_CATALOG_RESOLVER_TOKEN ?? ""}` },
          });
          if (dres.ok) {
            const ds = (await dres.json()) as Array<{ dataset: string; kinds: string[] }>;
            for (const d of ds) {
              hostedDatasets.push(d.dataset);
              for (const k of d.kinds ?? []) hostedKinds.add(k);
            }
          }
        } catch {
          /* resolver unreachable → nothing eligible → all local */
        }
      }
      const hostedSourceFor = (c: (typeof m.catalogs)[number]): "hosted" | "local" => {
        const st = (c.schema as { semantic_type?: string } | undefined)?.semantic_type;
        if (st && hostedKinds.has(st)) return "hosted";
        if (hostedDatasets.some((d) => c.external_id.startsWith(d))) return "hosted";
        return "local";
      };
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
              source: hostedSourceFor(c),
              schema: sql`${JSON.stringify(c.schema)}::jsonb`,
              bundle_external_id: `${m.id}/${c.external_id}`,
            } as never)
            // Two installs at once both found no catalog by this name: the first stands.
            .onConflict((oc) => oc.doNothing())
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
          // jsonb-replace-ok: warnings are re-derived per install; stale ones must NOT survive
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
  // Keyed for the app-block view references below: a bundle app names the view
  // it wants, and only this insert knows the id that name got in THIS workspace.
  const seededViews: SeededView[] = [];
  if (allViews.length > 0) {
    try {
      const tdb = (await getTenantDb(orgId)) as unknown as Kysely<BundleTenantDB>;
      for (const v of allViews) {
        const inserted_view = await tdb
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
          .returning(["id", "name", "entity_kind"])
          .executeTakeFirst();
        if (inserted_view) seededViews.push(inserted_view as SeededView);
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
        // Bind any `view_name` reference to the id that view actually got in
        // this workspace. Unresolved names are logged and the block is left as
        // authored: the App Player will reject it, which is the honest outcome
        // and exactly what lint:bundle-app-view-refs prevents ever reaching here.
        const { pages, unresolved } = resolveAppViewRefs(app.pages, seededViews);
        if (unresolved.length > 0) {
          console.error(
            `[bundle-install] app "${app.slug}" references unknown saved view(s) ${unresolved.join(", ")} in bundle ${inserted.external_id}`,
          );
        }
        await tdb
          .insertInto("core_apps_apps")
          .values({
            slug: app.slug,
            name: app.name,
            icon: app.icon ?? null,
            visible_capability: app.visible_capability ?? null,
            pages: sql`${JSON.stringify(pages)}::jsonb` as never,
            theme: app.theme ? (sql`${JSON.stringify(app.theme)}::jsonb` as never) : null,
            created_by: null,
          } as never)
          // Two installs at once both found no app: the second keeps the first.
          .onConflict((oc) => oc.column("slug").doNothing())
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
    // Per-action role FLOOR for the migration invoke (audit M-ACTION-PARITY). A
    // migration runs a bundle-DECLARED action with the INSTALLER's authority; a
    // crafted bundle that names an owner-only platform:* action (e.g.
    // rename-workspace) as a migration would otherwise let a non-owner installer
    // perform it, bypassing the floor the /actions/invoke route holds. Install
    // already requires owner/admin, so this only bites the owner-only sliver.
    // Look the installer's CURRENT role up once. Skipped for system provisioning
    // (auth_method 'system' has no user being impersonated — a trusted infra
    // install, e.g. a managed app), where there is no membership row to read.
    const enforceFloor = sess.auth_method !== "system";
    const installerRole = enforceFloor
      ? ((
          await meta
            .selectFrom("org_memberships")
            .select("role")
            .where("org_id", "=", orgId)
            .where("user_id", "=", sess.id)
            .executeTakeFirst()
        )?.role ?? null)
      : null;
    for (const mig of m.migrations) {
      if (cmpVersion(priorVersion, mig.to_version) >= 0) continue; // already past it
      try {
        // Refuse a floored action the installer cannot clear before it runs.
        // A no-op for every module migration (they carry no floor); the caught
        // ActionRoleFloorError is logged as a refusal and the install continues.
        if (enforceFloor) assertActingRoleClearsActionFloor(mig.action, installerRole);
        const result = await platform().actions.invoke(mig.action, {
          orgId: orgId,
          userId: sess.id,
          entity: { kind: "inventory:part", id: "" },
          event: { name: "bundle.upgraded", payload: {}, actor, timestamp: new Date().toISOString(), trigger_type: "event" },
          args: mig.args,
        });
        migrationsRun.push({ to_version: mig.to_version, action: mig.action, result });
      } catch (err) {
        const why = err instanceof ActionRoleFloorError ? "refused (role floor)" : "failed";
        console.error(`[bundle-install] migration ${mig.action} (→${mig.to_version}) ${why} for ${inserted.id}:`, (err as Error).message);
      }
    }
  }
  // Installed: its collections, fields and views are part of the shape now.
  await bumpWorkspaceShape(orgId);
  // The activity says installed only once it is: written last, so a step
  // that throws first (an outage mid-install) leaves no "installed" for an
  // install the person was told had failed.
  // Credit the installer the caller named. The row used to read the request
  // context only, so an install run outside a request (an automatic bundle
  // update, an approval applied later) had no actor and read "someone
  // installed Yarn" on the dashboard (#3833). A system install (the automatic
  // update) is the platform's own work: no user, and the feed says "Cobblr".
  if (opts.logInstall !== false) await activity.log({
    orgId: orgId,
    userId: sess.auth_method === "system" ? null : sess.id,
    authMethod: sess.auth_method,
    apiTokenId: sess.api_token_id ?? null,
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
  return {
    bundle: inserted,
    applied: {
      wires: totalWires,
      field_defs: totalFieldDefs,
      field_overrides: m.field_overrides.length,
      catalogs: catalogsInstalled,
      auto_enabled_modules: autoEnabled,
      migrations: migrationsRun,
      instances_created: instancesCreated,
      instances_existing: instancesExisting,
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
      // modules, adds field defs + automation wires. The admin tier only (an
      // editor is in it); a member or a read-only guest must not. See
      // 2026-06-10 audit #3. The refusal is an ASK, not a dead end: it names
      // the bundle and whether an admin can be asked to install it (#3073).
      if (!roleSatisfies(req.tenant!.role, ["owner", "admin"])) {
        const asked = (req.body ?? {}) as { id?: unknown; manifest?: { id?: unknown } };
        const bundleId = typeof asked.id === "string" ? asked.id : typeof asked.manifest?.id === "string" ? asked.manifest.id : null;
        const blocked = await describeBlock({
          orgId: req.tenant!.org.id,
          userId: req.session!.id,
          role: req.tenant!.role,
          remedies: bundleId ? [{ kind: "install", key: bundleId }] : [],
          doing: "Installing this",
        });
        res.status(403).json({
          error: { code: "forbidden", message: blocked.sentence, details: { your_role: req.tenant!.role }, blocked },
        });
        return;
      }
      // Q5 (wires-and-bundles.md): `requires` is now an "install" not
      // a "check." If the bundle needs modules the workspace doesn't
      // have enabled, return 409 with `needs_enable` instead of
      // auto-enabling silently. Caller re-POSTs with `confirm:true`
      // to proceed.
      const ManifestBody = z.object({
        /** The bundle, whole. Or, instead, its `id`: resolved from this
         *  deployment's own catalog first, then the external registry when one
         *  is configured; an id nothing here knows answers a coded 409 naming
         *  the missing registry and this door (#2922). */
        manifest: z.unknown().optional(),
        id: z.string().min(1).max(200).optional(),
        confirm: z.boolean().optional(),
        /** Phase 2: which optional features to install. Omitted on a FIRST
         *  install → the features' own default:true set. Omitted on an UPDATE
         *  → whatever is already on, never the new version's defaults; see
         *  platform/feature-defaults.ts. `[]` is an explicit "none of them". */
        enabled_features: z.array(z.string()).optional(),
        /** Upgrade conflicts (preview.upgrade_conflicts) the user chose to
         *  "take theirs" on: drop the user override so the new bundle wins. */
        take_theirs: z.array(z.object({ entity_kind: z.string(), name: z.string() })).optional(),
        /** One answer per upgrade conflict (keep mine / take theirs / keep
         *  both for a list of options). Absent for a conflict: keep mine. */
        resolutions: z.array(ConflictResolutionSchema).max(500).optional(),
        /** The word picked for each table that offers them (#3650), by
         *  instance name: { yarn: "skein" }. Omitted: the stored choice on
         *  an update, the bundle's default on a first install. */
        noun_choices: z.record(z.string().max(40), z.string().min(1).max(60)).optional(),
      });
      const body = ManifestBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: { code: "invalid_bundle", message: "Bad request body", details: body.error.issues } });
        return;
      }
      const confirm = !!body.data.confirm;
      let manifestIn: unknown = body.data.manifest;
      if (manifestIn === undefined) {
        if (!body.data.id) {
          res.status(400).json({ error: { code: "invalid_bundle", message: "Send the bundle as `manifest`, or its `id` to install from the catalog." } });
          return;
        }
        manifestIn = await getFlagshipManifest(body.data.id);
        if (manifestIn === null || manifestIn === undefined) {
          const registry = externalRegistry();
          if (!registry) {
            res.status(409).json({
              error: {
                code: "registry_unavailable",
                message: `This deployment has no bundle registry configured, so "${body.data.id}" cannot be installed by id here (its own catalog holds ${listFlagshipManifests("all").length} bundles and this is not one of them); send the manifest instead (\`manifest\` from bundles/<name>.json).`,
                details: { id: body.data.id, door: "manifest", registry: false },
              },
            });
          } else {
            res.status(404).json({
              error: { code: "bundle_not_found", message: `No bundle "${body.data.id}" in this deployment's catalog or the registry at ${registry}.`, details: { id: body.data.id, registry } },
            });
          }
          return;
        }
      }

      // SINGLE SOURCE OF VALIDATION TRUTH — same helper the /validate
      // endpoint + the authoring module use. autoEnable = confirm: when
      // confirmed, modules that need enabling are reported in
      // preview.modules_to_enable (not a needs_enable error) and enabled
      // below. The HTTP error codes below preserve the prior contract the
      // bundle-install UI depends on.
      const v = await validateBundle(req.tenant!.org.id, manifestIn, {
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
        const groupErrors = v.errors.filter((e) => e.code.includes("action_group"));
        res.status(400).json({ error: { code: "invalid_bundle", message: groupErrors.length ? groupErrors.map((e) => e.message).join(" ") : "Bundle manifest failed validation", details: { errors: v.errors } } });
        return;
      }
      const result = await applyValidatedBundle(
        req.tenant!.org.id,
        { id: req.session!.id, display_name: req.session!.display_name ?? null, auth_method: req.session!.auth_method, api_token_id: req.session!.api_token_id ?? null },
        v,
        { takeTheirs: body.data.take_theirs, resolutions: body.data.resolutions, nounChoices: body.data.noun_choices },
      );
      // DID IT ACTUALLY DO IT?
      //
      // The summary below is built from the MANIFEST - "this bundle provides an
      // instance called tea" - so it reports what was asked for, and nothing
      // compares that against what exists afterwards.
      //
      // The tenant-side work is best-effort by design (`install_status:
      // "partial"` exists because an install can half-succeed), so a partial
      // install answers 201 with a summary that reads exactly like a whole one.
      // A workspace can hold a bundle listed as installed with no table to file
      // into, and nothing says so.
      //
      // This reads the instances back and names the promised ones that are
      // missing. Not a throw - a partial install is recoverable, not an error.
      // The point is that it stops being invisible.
      const promised = promisedInstances(v.fullManifest ?? v.manifest!, v.enabledFeatures ?? []);
      let postcondition: ReturnType<typeof checkInstalled> = { missing: [], ok: true, message: "" };
      if (promised.length > 0) {
        const present = new Set<string>();
        for (const p of promised) {
          try {
            if (await getInstance(req.tenant!.org.id, p.instance_name)) present.add(p.instance_name);
          } catch {
            // Unreadable is not the same as absent, but for this report it has
            // to count as "cannot prove it is there", which is the honest read.
          }
        }
        postcondition = checkInstalled(promised, present);
        if (!postcondition.ok) {
          console.error(`[bundles] ${v.manifest!.id}: ${postcondition.message}`);
        }
      }

      // Same summary the scan-side install returns, built once here so the
      // two surfaces cannot drift on what an install is said to have done.
      res.status(201).json({
        ...result,
        installed: bundleInstallSummary(v.manifest!, result.applied),
        // Present ONLY when something promised is missing, so a healthy install
        // says nothing extra and a broken one cannot be read as healthy.
        ...(postcondition.ok ? {} : { incomplete: { missing: postcondition.missing, message: postcondition.message } }),
        // What this version adds that nobody agreed to. NOT installed - handed
        // back so the surface can ask instead of the update deciding.
        features_to_offer: v.featuresToOffer ?? [],
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Every involved instance as it stands right now: id and exact row count.
 *  Read from the workspace, never inferred from the manifest, so the report
 *  after a change can only be true. */
async function instanceLedger(orgId: string, involved: readonly PromisedInstance[]): Promise<InstanceLedgerRow[]> {
  const rows: InstanceLedgerRow[] = [];
  for (const p of involved) {
    const inst = await getInstance(orgId, p.instance_name);
    if (!inst) continue;
    let records: number | null = null;
    try {
      records = await instanceRowCount(orgId, p.instance_name);
    } catch (err) {
      console.error(`[bundles] row count for ${p.instance_name} failed:`, (err as Error).message);
    }
    rows.push({ instance_name: p.instance_name, module: inst.module_name, id: inst.id, records });
  }
  return rows;
}

// PATCH /:id/features — turn a bundle's optional features on or off. The ONE
// door for a feature change: re-applies the stored manifest with the new set
// on the upgrade path (applyValidatedBundle replaces the prior install with
// snapshot reason "replaced" and no teardown), so fields, wires and views move
// and the bundle's tables keep their rows and their ids. The client used to
// compose this as DELETE then install, and the DELETE tore the tables down:
// two yarn records vanished under a dialog that promised "your entities stay"
// (#2889). The route reads every involved table before and after and reports
// what it kept, so the promise is checked, not assumed. A table only a
// turned-off feature set up goes when it holds nothing and stays, with its
// records, when it does not.
// AI-REACH: changes workspace composition (enables modules, moves fields,
// wires and views) behind the bundle dialog's own confirmation; owner/admin,
// the same door as install.
// PUT /bundles/noun — change the word a table's things are called
// (#3650). The installed bundle is applied again, as a feature change is, with
// the new word: its labels are re-filled from the stored manifest's tokens,
// and where the word is the unit the records still on the old one follow
// (platform.instance.default-unit-changed), so every screen says it at once.
//
// AI-REACH: a presentation choice made in the table's settings or at install;
// it re-applies a bundle, which is the person's to do, not an agent's.
bundlesRouter.put(
  "/noun",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      const Body = z.object({ instance: z.string().min(1).max(80), singular: z.string().min(1).max(60) });
      const body = Body.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "instance and singular are required.", details: body.error.issues } });
        return;
      }
      const orgId = req.tenant!.org.id;
      // The installed bundle that offers words for this table: the table's
      // settings know the table, not which bundle made it.
      type Full = {
        provides_instances?: Array<{ instance_name?: string; noun?: NounChoiceDecl }>;
        features?: Array<{ provides_instances?: Array<{ instance_name?: string; noun?: NounChoiceDecl }> }>;
      };
      const rows = await meta.selectFrom("bundles").select(["id", "manifest", "enabled_features"]).where("org_id", "=", orgId).execute();
      let bundle: (typeof rows)[number] | null = null;
      let full: Full = {};
      let offer: NounChoiceDecl | undefined;
      for (const r of rows) {
        const f = (typeof r.manifest === "string" ? JSON.parse(r.manifest) : r.manifest) as Full;
        const o = [...(f.provides_instances ?? []), ...(f.features ?? []).flatMap((x) => x.provides_instances ?? [])].find(
          (i) => i.instance_name === body.data.instance && i.noun,
        )?.noun;
        if (o) {
          bundle = r;
          full = f;
          offer = o;
          break;
        }
      }
      if (!bundle) {
        res.status(404).json({ error: { code: "noun_not_offered", message: "This table does not offer a choice of word." } });
        return;
      }
      const want = body.data.singular.trim().toLowerCase();
      const word = offer ? nounOptions(offer).find((o) => o.singular.toLowerCase() === want) : undefined;
      if (!offer || !word) {
        res.status(400).json({
          error: {
            code: "noun_not_offered",
            message: offer
              ? `This table offers ${nounOptions(offer).map((o) => `"${o.singular}"`).join(", ")}.`
              : "This table does not offer a choice of word.",
          },
        });
        return;
      }
      const v = await validateBundle(orgId, full, { autoEnable: true, enabledFeatures: (bundle.enabled_features as string[] | null) ?? [] });
      if (!v.valid) {
        res.status(409).json({ error: { code: "invalid_bundle", message: v.errors.map((e) => e.message).join(" "), details: { errors: v.errors } } });
        return;
      }
      const result = await applyValidatedBundle(
        orgId,
        { id: req.session!.id, display_name: req.session!.display_name ?? null, auth_method: req.session!.auth_method, api_token_id: req.session!.api_token_id ?? null },
        v,
        { nounChoices: { [body.data.instance]: word.singular }, logInstall: false },
      );
      await activity.log({
        orgId,
        action: "bundle_word_changed",
        ref: { module: null, entityType: "bundle", entityId: result.bundle.id },
        diff: { name: result.bundle.name, external_id: result.bundle.external_id, instance: body.data.instance, word: word.singular },
      });
      await bumpWorkspaceShape(orgId);
      res.json({ bundle: result.bundle, instance: body.data.instance, noun: word });
    } catch (err) {
      next(err);
    }
  },
);

bundlesRouter.patch(
  "/:id/features",
  requireAuth,
  withTenant,
  async (req, res, next) => {
    try {
      if (!requireRole(req, res, "owner", "admin")) return;
      const Body = z.object({ enabled_features: z.array(z.string()) });
      const body = Body.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "enabled_features: string[] required", details: body.error.issues } });
        return;
      }
      const orgId = req.tenant!.org.id;
      const bundle = await meta
        .selectFrom("bundles")
        .select(["id", "external_id", "name", "version", "manifest", "enabled_features"])
        .where("id", "=", req.params.id ?? "")
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (!bundle) {
        res.status(404).json({ error: { code: "not_found", message: "bundle not found" } });
        return;
      }
      const rawManifest = bundle.manifest;
      const fullManifest = (typeof rawManifest === "string" ? JSON.parse(rawManifest) : rawManifest) as FeatureManifest;
      const before = (bundle.enabled_features as string[] | null) ?? [];
      const change = featureChange(fullManifest, before, body.data.enabled_features);
      const ledgerBefore = await instanceLedger(orgId, change.involved);

      // The install route's gate, unchanged: a set that no longer validates
      // (a module gone, a field the workspace now owns) is answered with the
      // errors, and nothing has moved yet.
      const v = await validateBundle(orgId, fullManifest, { autoEnable: true, enabledFeatures: body.data.enabled_features });
      if (!v.valid) {
        res.status(409).json({ error: { code: "invalid_bundle", message: v.errors.map((e) => e.message).join(" "), details: { errors: v.errors } } });
        return;
      }
      const result = await applyValidatedBundle(
        orgId,
        { id: req.session!.id, display_name: req.session!.display_name ?? null, auth_method: req.session!.auth_method, api_token_id: req.session!.api_token_id ?? null },
        v,
        { logInstall: false },
      );

      // A table only the turned-off feature set up: gone when empty (nothing
      // to lose, and an empty table left in the nav reads as a table the
      // person did not ask for), kept when it holds anything at all.
      const removedEmpty: string[] = [];
      for (const r of change.released) {
        const row = ledgerBefore.find((x) => x.instance_name === r.instance_name);
        if (row && row.records === 0) {
          await tearDownInstance(orgId, r.instance_name);
          removedEmpty.push(r.instance_name);
        }
      }

      const ledgerAfter = await instanceLedger(orgId, change.involved);
      const diff = diffLedger(ledgerBefore, ledgerAfter);
      const kept = diff.kept;
      const gone = diff.gone.filter((n) => !removedEmpty.includes(n));
      const broken = diff.re_created.length > 0 || diff.lost_records.length > 0 || gone.length > 0;
      const summary = describeFeatureChange(change, diff, removedEmpty);
      if (broken) {
        console.error(`[bundles] ${bundle.external_id} feature change did not keep every table: ${summary}${gone.length ? `; GONE: ${gone.join(", ")}` : ""}`);
      }
      await activity.log({
        orgId,
        action: "bundle_features_changed",
        ref: { module: null, entityType: "bundle", entityId: result.bundle.id },
        diff: {
          name: bundle.name,
          external_id: bundle.external_id,
          version: bundle.version,
          turned_on: change.turned_on,
          turned_off: change.turned_off,
          kept: kept.map((k) => ({ instance: k.instance_name, records: k.records })),
          removed_empty: removedEmpty,
          ...(broken ? { re_created: diff.re_created, lost_records: diff.lost_records, gone } : {}),
          summary,
        },
      });
      res.json({
        ...result,
        installed: bundleInstallSummary(v.manifest!, result.applied),
        features: { enabled: v.enabledFeatures ?? [], turned_on: change.turned_on, turned_off: change.turned_off },
        kept: kept.map((k) => ({ instance_name: k.instance_name, id: k.id, records: k.records })),
        removed_empty: removedEmpty,
        // Present ONLY when a table did not come through as it went in, so a
        // healthy change says nothing extra and a broken one cannot be read
        // as healthy (same shape as the install's postcondition).
        ...(broken ? { incomplete: { re_created: diff.re_created, lost_records: diff.lost_records, gone, message: summary } } : {}),
      });
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
export async function previewBundleUninstall(
  orgId: string,
  externalId: string,
): Promise<{
  instances: { name: string; display_name: string; item_count: number }[];
  modules: string[];
  /** The same modules, as a person reads them. */
  module_names: string[];
  /** Places this bundle made that an uninstall removes (they are empty). */
  places: { id: string; name: string }[];
  /** What it would leave, and why: a place in use, a module with records. */
  kept: { type: "module" | "place"; name: string; reason: string }[];
}> {
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
  const kept: { type: "module" | "place"; name: string; reason: string }[] = [];
  const goingInstances = new Set(instances.map((i) => i.name));
  for (const c of claims.filter((x) => x.resource_type === "module")) {
    if ((await countClaimsFor(orgId, "module", c.resource_key)) > 1) continue;
    // A module every workspace is born with stays, whoever switched it on.
    const def = getEntry(c.resource_key);
    if (def && isDefaultModule(def)) continue;
    const label = getEntry(c.resource_key)?.manifest.displayName ?? c.resource_key;
    // Records in the module's own kinds (a collection going with this
    // uninstall takes its records with it, so those do not count).
    // The named collections of one module that outlive this uninstall; the
    // default one is the module itself.
    // registry-filter-ok: one module's surviving collections, not a listing
    const survivors = (await listInstances(orgId, c.resource_key)).filter((i) => !i.is_default && !goingInstances.has(i.instance_name));
    if (survivors.length > 0) {
      kept.push({ type: "module", name: label, reason: `${survivors.map((i) => i.display_name).join(", ")} still ${survivors.length === 1 ? "uses" : "use"} it` });
      continue;
    }
    const held = await moduleRecordCount(orgId, c.resource_key, { skipInstances: goingInstances });
    if (held === null || held > 0) {
      kept.push({ type: "module", name: label, reason: held ? `${held} record${held === 1 ? " uses" : "s use"} it` : "what it holds could not be checked" });
      continue;
    }
    modules.push(c.resource_key);
  }
  const placeIds: string[] = [];
  for (const c of claims.filter((x) => x.resource_type === "place")) {
    if ((await countClaimsFor(orgId, "place", c.resource_key)) <= 1) placeIds.push(c.resource_key);
  }
  const plan = await previewPlaces(orgId, placeIds);
  for (const k of plan.kept) kept.push({ type: "place", ...k });
  return {
    instances,
    modules,
    module_names: modules.map((m) => getEntry(m)?.manifest.displayName ?? m),
    places: plan.going,
    kept,
  };
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
          const m = (typeof r.manifest === "string" ? JSON.parse(r.manifest) : r.manifest) as DeclaringManifest | null;
          return {
            id: r.id,
            external_id: r.external_id,
            name: r.name,
            version: r.version,
            reason: r.reason,
            enabled_features: r.enabled_features,
            created_at: r.created_at,
            counts: {
              field_defs: m ? declaredFieldDefs(m).length : 0,
              wires: m ? declaredWireCount(m) : 0,
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
      // Same summary the scan-side install returns, built once here so the
      // two surfaces cannot drift on what an install is said to have done.
      res.status(201).json({ ...result, installed: bundleInstallSummary(v.manifest!, result.applied) });
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
      // Records go only when the caller SAYS so. This route tore down the
      // bundle's instances and their rows on every DELETE, and the feature
      // dialog's "Save feature changes" was composed as DELETE + install: two
      // yarn records vanished on staging under a dialog that promised "your
      // entities stay" (#2889). The uninstall dialog's confirmation, which
      // names what it deletes, sends `delete_data=1`; nothing else does, so an
      // older web image that still composes a feature change from two calls
      // cannot delete through this api. Without the flag the bundle's fields,
      // wires and views go and its instances and records stay, exactly as an
      // upgrade leaves them.
      const deleteData = req.query.delete_data === "1" || (req.body as { delete_data?: unknown } | undefined)?.delete_data === true;
      res.status(200).json(await removeBundle(req.tenant!.org.id, bundle, { deleteData }));
    } catch (err) {
      next(err);
    }
  },
);

/** Remove an installed bundle: the one door the Bundles page and the
 *  assistant both go through, so what is removed, what is logged and what
 *  comes back as Undo cannot differ between them. Records go only when
 *  `deleteData` says so; without it the bundle's fields, wires and views go
 *  and its tables and records stay. */
export async function removeBundle(
  orgId: string,
  bundle: { id: string; name: string },
  { deleteData }: { deleteData: boolean },
): Promise<{ removed: ReleaseSummary["removed"]; kept: ReleaseSummary["kept"]; kept_words: string[]; undo_snapshot_id?: string }> {
  const released = await uninstallBundleId(bundle.id, deleteData ? { teardownResources: true } : { snapshotReason: "uninstalled" });
  await activity.log({
    orgId,
    action: "bundle_uninstalled",
    ref: { module: null, entityType: "bundle", entityId: bundle.id },
    // The bundle row is gone after uninstall, so carry its name so the
    // activity feed reads "bundle uninstalled · <name>" (mirrors install).
    diff: {
      name: bundle.name,
      ...(released ? { removed: released.removed.map((r) => r.name), kept: released.kept.map((k) => k.name) } : {}),
    },
  });
  // What it put back and what it kept, in words, so the dialog can say
  // "Kept Pantry: 12 things live there" instead of "done".
  return {
    removed: released?.removed ?? [],
    kept: released?.kept ?? [],
    kept_words: describeKept(released?.kept ?? []),
    // Undo: reverting this snapshot puts the bundle back as it was. Only
    // when its records were kept; deleted records cannot come back.
    ...(released?.snapshotId && !deleteData ? { undo_snapshot_id: released.snapshotId } : {}),
  };
}

async function uninstallBundleId(
  bundleId: string,
  opts?: { teardownResources?: boolean; snapshotReason?: "replaced" | "uninstalled" },
): Promise<(ReleaseSummary & { snapshotId?: string }) | null> {
  let summary: (ReleaseSummary & { snapshotId?: string }) | null = null;
  let snapshotId: string | undefined;
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
        .returning("id")
        .executeTakeFirst()
        .then((r) => {
          snapshotId = r?.id;
        });
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
    // core_catalogs_entries cascade via the FK — and EVERY entry is
    // user-imported: bundles ship catalog SHELLS only (rows are never in
    // the manifest), the importer writes the rows. So this delete is pure
    // user-data loss and must ONLY run on a REAL uninstall — NEVER on the
    // upgrade-replace path (applyValidatedBundle → uninstallBundleId(old,
    // {snapshotReason:"replaced"}) with NO teardownResources). On upgrade
    // the shell is left in place and applyValidatedBundle's idempotent
    // catalog upsert refreshes it (UPDATE by bundle_external_id), so the
    // user's imported rows survive — "updates self-heal, never reset user
    // data." Gated identically to the instance/module refcount teardown
    // below, for the same reason. Without this gate a patch/minor
    // auto-apply silently destroys imported rows, and a version that DROPS
    // a catalog deletes them with no re-seed at all (the silent data-loss
    // edge this branch closes).
    if (opts?.teardownResources) {
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
    // Places and modules nothing else claims any more go back, unless a
    // person has used them since: an empty place is removed, a module with no
    // records is switched off, and whatever stays is said, with why (#3918).
    const unclaimed: ResourceClaim[] = [];
    for (const c of claims.filter((x) => x.resource_type !== "instance")) {
      if ((await countClaimsFor(bundleRow.org_id, c.resource_type, c.resource_key)) === 0) unclaimed.push(c);
    }
    summary = await releaseUnclaimed(bundleRow.org_id, unclaimed);
  } else if (opts?.snapshotReason === "uninstalled" && bundleRow) {
    // A plain uninstall keeps the bundle's tables and their records, so its
    // instance claims stay; what it switched on and the places it made are
    // released the same way, under the same "unless used" rule, so a person
    // who removes Groceries is not left with Lists and an empty Kitchen.
    const claims = (await claimsForSource(bundleRow.org_id, bundleRow.external_id)).filter((c) => c.resource_type !== "instance");
    await meta
      .deleteFrom("bundle_resource_claims")
      .where("org_id", "=", bundleRow.org_id)
      .where("source", "=", bundleRow.external_id)
      .where("resource_type", "in", ["module", "place"])
      .execute();
    const unclaimed: ResourceClaim[] = [];
    for (const c of claims) {
      if ((await countClaimsFor(bundleRow.org_id, c.resource_type, c.resource_key)) === 0) unclaimed.push(c);
    }
    summary = await releaseUnclaimed(bundleRow.org_id, unclaimed);
  }
  if (bundleRow) await bumpWorkspaceShape(bundleRow.org_id);
  if (snapshotId) summary = { ...(summary ?? { removed: [], kept: [] }), snapshotId };
  return summary;
}
