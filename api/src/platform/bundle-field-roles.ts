// PERMANENT RECONCILE — a field a bundle owns carries the role, and the fact
// scope (model or unit, #6013), that bundle's current manifest declares.
//
// BORN WITH: applyValidatedBundle (an install writes each field's role from the manifest it installs)
//
// A role is how the platform knows what a field MEANS: the scan files a lot
// into the field whose role is `lot`, a best-before into `expiry`. When a
// bundle release gives an existing field a role (Yarn's Dye lot became `lot`
// in 0.8.2), the installs that already have that field only learn it when the
// bundle update applies. The update pass (bundle-updates.ts) applies patch and
// minor releases on its own, but leaves for the person's prompt any install
// whose update reports a conflict or a field collision, and a role is not
// worth waiting on that for: without it, every lot the scanner reads is kept
// on the row and never filed.
//
// So this fills only a MISSING role, on a field the bundle itself owns
// (bundle_id), named as the bundle's own manifest names it, when that name
// carries one unambiguous role in the manifest. It never replaces a role
// already set (the person's pick, or another release's), never touches a
// field another bundle or a person made, and never matches by what a field is
// called outside its own bundle. Meta-only: no tenant pool opens.

import { listFlagshipManifests } from "../lib/flagship-bundles.js";
import { planFactScopeHeals, planFieldRoleHeals, type OwnedFieldDef } from "./bundle-field-roles-plan.js";

/** One pass over every workspace's bundle-owned fields. Returns how many
 *  roles it filled; a current install costs one meta query and writes nothing. */
export async function reconcileBundleFieldRoles(): Promise<number> {
  const { meta } = await import("../db/meta.js");
  const catalog = new Map(listFlagshipManifests("all").map((m) => [String(m.id ?? ""), m as unknown]));
  const installed = await meta.selectFrom("bundles").select(["id", "external_id"]).where("install_status", "=", "active").execute();
  const bundles = new Map(installed.map((b) => [b.id, b.external_id]));
  if (!bundles.size) return 0;
  const defs = await meta
    .selectFrom("module_field_defs")
    .select(["id", "bundle_id", "name", "field_role"])
    .where("bundle_id", "is not", null)
    .where("field_role", "is", null)
    .execute();
  const heals = planFieldRoleHeals(defs as OwnedFieldDef[], bundles, catalog);
  for (const h of heals) {
    // Guarded again in the write: a role set since the read is never replaced.
    await meta.updateTable("module_field_defs").set({ field_role: h.field_role }).where("id", "=", h.id).where("field_role", "is", null).execute();
  }
  // The same for a field's fact scope: a release that says bed size is a
  // fact about the model reaches the printers already installed.
  const unscoped = await meta
    .selectFrom("module_field_defs")
    .select(["id", "bundle_id", "name", "fact_scope"])
    .where("bundle_id", "is not", null)
    .where("fact_scope", "is", null)
    .execute();
  const scopes = planFactScopeHeals(unscoped as Array<{ id: string; bundle_id: string; name: string; fact_scope: string | null }>, bundles, catalog);
  for (const h of scopes) {
    await meta.updateTable("module_field_defs").set({ fact_scope: h.fact_scope }).where("id", "=", h.id).where("fact_scope", "is", null).execute();
  }
  return heals.length + scopes.length;
}
