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

const CATEGORY_FIELD = "category";

/** `source_module` marker for the PLATFORM-created scan category placeholder. An
 *  `@`-prefixed sentinel, not a real module name (so the kernel isn't naming a
 *  module, and it can never collide with one): it tags the field as platform state
 *  — excluded from user exports, and superseded by any bundle's own category
 *  field on bundle install. */
export const SCAN_CATEGORY_SOURCE = "@scan-category";

export async function reconcileScanCategoryFields(): Promise<void> {
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
  for (const e of listEntries()) {
    const primary = e.manifest.provides?.entityKinds?.find((k) => k.primary);
    // PHYSICAL kinds only — a scan is of a physical thing. inventory:part /
    // assets:asset / machines:machine are physical; sales:order / purchases:order
    // / projects:project are digital records and must NOT get a scan category axis
    // (it's useless there, and it collided with those modules' bundles). Read the
    // tangibility off the kind's declared profile.
    const profile = primary?.profile as PresetName | undefined;
    const physical = profile ? TRAIT_PRESETS[profile]?.tangibility === "physical" : false;
    if (primary && physical) scanByModule.set(e.manifest.name, primary.id);
  }
  if (scanByModule.size === 0) return;

  // ONE pass over every instance + every existing category field. A workspace
  // that's already complete costs no extra query and opens no tenant pool.
  const instances = await meta
    .selectFrom("workspace_module_instances")
    .select(["org_id", "module_name", "instance_name", "is_default", "is_scan_fallback"])
    .where("module_name", "in", [...scanByModule.keys()])
    .execute();
  if (instances.length === 0) return;

  const existing = await meta
    .selectFrom("module_field_defs")
    .select(["org_id", "entity_kind", "name", "field_role", "source_module"])
    .where((eb) => eb.or([eb("field_role", "=", "category"), eb("name", "=", CATEGORY_FIELD)]))
    .execute();

  const plan = planScanCategoryAxes(instances, existing, scanByModule, CATEGORY_FIELD, SCAN_CATEGORY_SOURCE);

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
  for (const { org_id, kind } of plan.add) {
    try {
      await meta
        .insertInto("module_field_defs")
        .values({
          org_id,
          entity_kind: kind,
          name: CATEGORY_FIELD,
          display_label: "Category",
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
          help: "What KIND of thing this is. Scans group by it, and a category that outgrows this table can be promoted into its own.",
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
