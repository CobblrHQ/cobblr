// Boot reconcile: every workspace's scan FALLBACK table gets a category axis.
//
// Without a field declaring `field_role: 'category'`, the matchmaker has no way
// to say "this is an electrical part and that is a plumbing part" other than by
// routing them to DIFFERENT TABLES — which is exactly what it did, scattering
// five electrical parts across four near-synonym tables. The axis is the fix, so
// every workspace needs one, including the ones that already exist.
//
// Self-healing per CLAUDE.md §8.1: signup only provisions what existed when the
// workspace was created, so a change every workspace needs must reconcile at
// boot. A user must never have to run anything.
//
// BORN WITH: reconcileScanCategoryFor (from enableModuleForOrg when the
// module's primary kind is physical, which is the moment a workspace gains a
// table a scan lands in, through every door: signup, a later enable, an app
// being provisioned). A workspace
// that only the boot pass served was born without its axis and stayed so
// until the next deploy (#3252, found on a first-run walk): its scans landed
// on the fallback table with no category grouping, and the form that asks
// "Category" twice (#3148) only ever appeared on a workspace older than the
// last restart. The boot pass stays as the heal for workspaces made before
// the seam, and for a change to the words; the per-org call is the same plan
// on one workspace.
//
// Scoped deliberately to the module's DEFAULT instance when it is the fallback. A specialised table (Yarn,
// Vehicles) is already one kind of thing — a category axis there is noise. The
// catch-all is the one table that holds many kinds and therefore needs to tell
// them apart. Categories hang off the fallback; a category that outgrows it gets
// promoted to its own instance.

import { sql } from "kysely";
import { TRAIT_PRESETS, type PresetName } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";
import { planScanCategoryAxes } from "./scan-category-plan.js";
import { getEntityWriterFor } from "./entities.js";
import { forgetAxis } from "./category-axis.js";
import { evictTenantPool } from "../db/tenant.js";

const CATEGORY_FIELD = "category";

/** `source_module` marker for the PLATFORM-created scan category placeholder. An
 *  `@`-prefixed sentinel, not a real module name (so the kernel isn't naming a
 *  module, and it can never collide with one): it tags the field as platform state
 *  — excluded from user exports, and superseded by any bundle's own category
 *  field on bundle install. */
export const SCAN_CATEGORY_SOURCE = "@scan-category";

/** The tables a scan lands in, per module, and which of them keep their own
 *  categories: from the loaded manifests, which are eager. */
export function scanFallbackKinds(): { scanByModule: Map<string, string>; ownCategoryKinds: Set<string> } {
  // Each domain module's PRIMARY entity kind is the table a scan lands in
  // (inventory:part, machines:machine, assets:asset). Derive it from the loaded
  // MANIFESTS — which are eager — NOT from the runtime scan registry.
  //
  // The registry (`listScannable()`) is populated by each module's `api()` bundle
  // calling `registerScannable`, and `api()` is a LAZY dynamic import that hasn't
  // run at boot. So `listScannable()` is empty here, `scanByModule` was empty, and
  // this reconcile early-returned in 0ms for EVERY workspace — the category axis
  // was never created anywhere, and #1049's whole category-routing feature sat
  // inert in production. The manifest is the boot-safe source of truth (the §8.1
  // rule: a boot reconcile reads eager manifest data, not a lazy runtime registry).
  const scanByModule = new Map<string, string>();
  const ownCategoryKinds = new Set<string>();
  for (const e of listEntries()) {
    const primary = e.manifest.provides?.entityKinds?.find((k) => k.primary);
    // PHYSICAL kinds only — a scan is of a physical thing. inventory:part /
    // assets:asset / machines:machine are physical; sales:order / purchases:order
    // / projects:project are digital records and must NOT get a scan category axis
    // (it's useless there, and it collided with those modules' bundles). Read the
    // tangibility off the kind's declared profile.
    const profile = primary?.profile as PresetName | undefined;
    const physical = profile ? TRAIT_PRESETS[profile]?.tangibility === "physical" : false;
    if (primary && physical) {
      scanByModule.set(e.manifest.name, primary.id);
      if (primary.categoryAxis) ownCategoryKinds.add(primary.id);
    }
  }
  return { scanByModule, ownCategoryKinds };
}

/** Whether enabling this module gives a workspace a table a scan lands in,
 *  and so a table that needs the axis. */
export function moduleHasScanFallback(moduleName: string): boolean {
  return scanFallbackKinds().scanByModule.has(moduleName);
}

/** The same plan, for ONE workspace, at the moment it gains a scan fallback
 *  table: what enabling such a module calls, so a workspace is born with its
 *  axis rather than waiting for a restart (#3252). Never throws: the axis is
 *  a self-heal, and an enable must not fail on it; the boot pass catches up
 *  on anything it missed. */
export async function reconcileScanCategoryFor(orgId: string): Promise<void> {
  try {
    await reconcileScanCategoryFields({ onlyOrgId: orgId });
  } catch (err) {
    console.error(`[reconcile] scan category axis for org ${orgId} failed (the boot pass will retry):`, (err as Error)?.message ?? err);
  }
}

/** `onlyOrgId` scopes the pass to one workspace: the per-org door above, and
 *  the test-support door (behind which a pass that walks every workspace
 *  relabels fields in every other test's workspace mid-flight,
 *  lint:test-support-doors-scoped). Boot never passes it. */
export async function reconcileScanCategoryFields(opts: { onlyOrgId?: string } = {}): Promise<void> {
  const { scanByModule, ownCategoryKinds } = scanFallbackKinds();
  if (scanByModule.size === 0) return;

  // ONE pass over every instance + every existing category field. A workspace
  // that's already complete costs no extra query and opens no tenant pool.
  let instancesQ = meta
    .selectFrom("workspace_module_instances")
    .select(["org_id", "module_name", "instance_name", "is_default", "is_scan_fallback"])
    .where("module_name", "in", [...scanByModule.keys()]);
  if (opts.onlyOrgId) instancesQ = instancesQ.where("org_id", "=", opts.onlyOrgId);
  const instances = await instancesQ.execute();
  if (instances.length === 0) return;

  let existingQ = meta
    .selectFrom("module_field_defs")
    .select(["org_id", "entity_kind", "name", "field_role", "source_module", "display_label"])
    .where((eb) => eb.or([eb("field_role", "=", "category"), eb("name", "=", CATEGORY_FIELD)]));
  if (opts.onlyOrgId) existingQ = existingQ.where("org_id", "=", opts.onlyOrgId);
  const existing = await existingQ.execute();

  const plan = planScanCategoryAxes(instances, existing, scanByModule, CATEGORY_FIELD, SCAN_CATEGORY_SOURCE, ownCategoryKinds);

  let healed = 0;
  for (const { org_id, kind } of plan.adopt) {
    try {
      // A `category` field already exists (a bundle made one): adopt it as the
      // axis rather than creating a second, competing one. Two grouping fields
      // would be worse than none: the matchmaker would have to guess.
      await meta
        .updateTable("module_field_defs")
        .set({ field_role: "category" })
        .where("org_id", "=", org_id)
        .where("entity_kind", "=", kind)
        .where("name", "=", CATEGORY_FIELD)
        .execute();
      healed++;
      console.log(`[reconcile] scan category axis: org ${org_id} kind ${kind} (adopted)`);
    } catch (err) {
      console.error(`[reconcile] scan category axis failed for ${org_id}::${kind}:`, (err as Error)?.message ?? err);
    }
  }
  for (const { org_id, kind, label, help } of plan.add) {
    try {
      await meta
        .insertInto("module_field_defs")
        .values({
          org_id,
          entity_kind: kind,
          name: CATEGORY_FIELD,
          display_label: label,
          // Text + choices: the choices ARE the taxonomy, and they grow from the
          // user's own data. The kernel never ships a list of categories.
          type: "text",
          choices: sql`'[]'::jsonb` as never,
          field_role: "category",
          // PLATFORM-MANAGED, not the user's own field. `source_module` tags it
          // as contributed-by-core-scan, which (a) EXCLUDES it from a workspace
          // export (otherwise the export captured it and re-importing onto an
          // org that also auto-created it collided) and (b) lets it be
          // reconciled/cleaned as platform state, not user data.
          source_module: SCAN_CATEGORY_SOURCE,
          help,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      healed++;
      console.log(`[reconcile] scan category axis: org ${org_id} kind ${kind}`);
    } catch (err) {
      // One workspace's failure must never block the rest.
      console.error(`[reconcile] scan category axis failed for ${org_id}::${kind}:`, (err as Error)?.message ?? err);
    }
  }
  // A placeholder that landed on a specialised table (a Yarn made the app's
  // fallback) is withdrawn: that table is one kind of thing, and the axis
  // only filled it with catalog paths. The def goes; a value an item may
  // carry in its metadata is inert without the def.
  let withdrawn = 0;
  for (const { org_id, kind } of plan.remove) {
    try {
      await meta
        .deleteFrom("module_field_defs")
        .where("org_id", "=", org_id)
        .where("entity_kind", "=", kind)
        .where("name", "=", CATEGORY_FIELD)
        .where("source_module", "=", SCAN_CATEGORY_SOURCE)
        .execute();
      withdrawn++;
      console.log(`[reconcile] scan category axis withdrawn: org ${org_id} kind ${kind} (specialised table)`);
    } catch (err) {
      console.error(`[reconcile] scan category axis withdraw failed for ${org_id}::${kind}:`, (err as Error)?.message ?? err);
    }
  }
  if (withdrawn) console.log(`[reconcile] scan category axis: withdrawn from ${withdrawn} specialised table(s)`);
  if (healed) console.log(`[reconcile] scan category axis: added to ${healed} table(s)`);
}

/**
 * Retire the platform's placeholder from every kind that keeps its own
 * taxonomy (#3223): move its values into that taxonomy, then remove it.
 *
 * DONE WHEN: no org has a `module_field_defs` row with source_module
 * '@scan-category' on a kind that declares `categoryAxis` (today only
 * inventory:part), on prod, staging and dev; checkable with one query per box.
 * Then this function, its boot call, its test-support call and `plan.retire`
 * go.
 *
 * BORN WITH: nothing (a fresh workspace never gets the placeholder on such a
 * kind: planScanCategoryAxes no longer adds it, at signup, at enable or at boot).
 *
 * A SEPARATE boot pass, after mountModules, on purpose. The values live in the
 * module's own table and only the module's entity writer may move them, and
 * writers are registered by each module's lazily loaded api bundle. Inside
 * reconcileScanCategoryFields (which runs before the mount) every writer
 * lookup found nothing and the retire would have done nothing at boot,
 * silently, the same way the axis itself once sat inert in production (#1049).
 * A missing writer is therefore an ERROR here, never a quiet skip.
 *
 * Order within a workspace: move, then remove the field, and only when nothing
 * is left under it. A crash between the two leaves the field in place, the seam
 * still def-backed (the store that exists answers, #3433) and consistent; the
 * next boot finishes it.
 */
export async function retireScanCategoryPlaceholders(opts: { onlyOrgId?: string } = {}): Promise<void> {
  const { ownCategoryKinds } = scanFallbackKinds();
  if (ownCategoryKinds.size === 0) return;
  let placeholdersQ = meta
    .selectFrom("module_field_defs")
    .select(["org_id", "entity_kind"])
    .where("source_module", "=", SCAN_CATEGORY_SOURCE)
    .where("name", "=", CATEGORY_FIELD)
    .where("entity_kind", "in", [...ownCategoryKinds]);
  if (opts.onlyOrgId) placeholdersQ = placeholdersQ.where("org_id", "=", opts.onlyOrgId);
  const placeholders = await placeholdersQ.execute();
  if (placeholders.length === 0) return;

  let retired = 0;
  for (const { org_id, entity_kind: kind } of placeholders) {
    try {
      const writer = await getEntityWriterFor(org_id, kind);
      if (!writer?.adoptAxisValues) {
        console.error(
          `[reconcile] scan category axis NOT retired for ${org_id}::${kind}: no writer with adoptAxisValues is registered. ` +
            "If this is boot, the pass is running before mountModules and every workspace is being skipped.",
        );
        continue;
      }
      const { moved, remaining } = await writer.adoptAxisValues(org_id, { field: CATEGORY_FIELD, column: "category_id" });
      if (remaining > 0) {
        console.error(`[reconcile] scan category axis NOT retired for ${org_id}::${kind}: ${remaining} record(s) still hold a value; left in place for the next pass`);
        continue;
      }
      await meta
        .deleteFrom("module_field_defs")
        .where("org_id", "=", org_id)
        .where("entity_kind", "=", kind)
        .where("name", "=", CATEGORY_FIELD)
        .where("source_module", "=", SCAN_CATEGORY_SOURCE)
        .execute();
      forgetAxis(org_id, kind);
      retired++;
      console.log(`[reconcile] scan category axis retired: org ${org_id} kind ${kind}, ${moved} value(s) moved into its own categories`);
    } catch (err) {
      console.error(`[reconcile] scan category axis retire failed for ${org_id}::${kind}:`, (err as Error)?.message ?? err);
    } finally {
      // The boot sweep opened this workspace's pool through the writer; release
      // it (a sweep that holds a pool per tenant exhausts Postgres). A per-org
      // call is serving that workspace, so its pool stays.
      if (!opts.onlyOrgId) await evictTenantPool(org_id);
    }
  }
  if (retired) console.log(`[reconcile] scan category axis: retired from ${retired} table(s) that keep their own categories`);
}
