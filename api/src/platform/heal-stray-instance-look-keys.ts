// One-time, idempotent heal for a collection's look left under the module it
// moved away from.
// DONE WHEN: this pass finds 0 rows on prod + staging + dev on consecutive
// boots; then delete this file and its boot call.
//
// BORN WITH: rehomeAssetsInstanceToRecords, which re-keys the look in the same
// step that re-points the registry (rekeyInstanceLook), so a move makes no
// stray row.
//
// Moving a collection from assets onto records changed its registry row to
// `records` and left its presentation row (noun, nav group, scan keywords,
// icon) keyed `assets:<name>`, where nothing reads it: the collection then
// reports an empty look and its records lose their noun (#6737, read-only
// from the owner's real Bookshelf). Each such row follows its collection to
// the module it is on now, unless the collection already has a look there (its
// own look wins) or the name is ambiguous. A row for a collection that no
// longer exists is not ours to delete and stays.

import { meta } from "../db/meta.js";
import { lookIsTheBugs } from "./heal-copied-collection-looks.js";
import { noteHealShim } from "./heal-shim-log.js";
import { notePassFailure } from "./pass-failures.js";

/** Move one collection's look from the module it left to the module it is on.
 *  False when there is no such row, or the new key already holds a real look. */
export async function rekeyInstanceLook(orgId: string, instanceName: string, fromModule: string, toModule: string): Promise<boolean> {
  if (fromModule === toModule) return false;
  const from = `${fromModule}:${instanceName}`;
  const to = `${toModule}:${instanceName}`;
  const at = (id: string) =>
    meta
      .selectFrom("entity_kind_overrides")
      .select(["display_label", "display_label_plural", "icon", "config"])
      .where("org_id", "=", orgId)
      .where("target_kind", "=", "instance")
      .where("target_id", "=", id)
      .executeTakeFirst();
  if (!(await at(from))) return false;
  const there = await at(to);
  if (there && !lookIsTheBugs(there as never)) return false;
  if (there) await meta.deleteFrom("entity_kind_overrides").where("org_id", "=", orgId).where("target_kind", "=", "instance").where("target_id", "=", to).execute();
  await meta.updateTable("entity_kind_overrides").set({ target_id: to }).where("org_id", "=", orgId).where("target_kind", "=", "instance").where("target_id", "=", from).execute();
  return true;
}

/** The boot call: skipped where historical heals are (a fresh test stack). */
export async function healStrayInstanceLookKeysAtBoot(): Promise<number> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") return 0;
  return healStrayInstanceLookKeys();
}

/** The pass itself, over every workspace or only `onlyOrgId`. */
export async function healStrayInstanceLookKeys(opts: { onlyOrgId?: string } = {}): Promise<number> {
  const rows = await meta
    .selectFrom("entity_kind_overrides")
    .select(["org_id", "target_id"])
    .where("target_kind", "=", "instance")
    .where("target_id", "like", "%:%")
    .$if(!!opts.onlyOrgId, (q) => q.where("org_id", "=", opts.onlyOrgId!))
    .execute();
  const orgs = [...new Set(rows.map((r) => r.org_id))];
  let healed = 0;
  let failed = 0;
  for (const orgId of orgs) {
    try {
      const instances = await meta.selectFrom("workspace_module_instances").select(["module_name", "instance_name"]).where("org_id", "=", orgId).execute();
      const modulesOf = new Map<string, string[]>();
      for (const i of instances) modulesOf.set(i.instance_name, [...(modulesOf.get(i.instance_name) ?? []), i.module_name]);
      for (const r of rows.filter((x) => x.org_id === orgId)) {
        const [module, name] = [r.target_id.slice(0, r.target_id.indexOf(":")), r.target_id.slice(r.target_id.indexOf(":") + 1)];
        const on = modulesOf.get(name);
        if (!on || on.length !== 1 || on[0] === module) continue;
        if (await rekeyInstanceLook(orgId, name, module, on[0]!)) {
          healed++;
          console.log(`[heal-stray-instance-look-keys] org ${orgId} ${name}: ${module} to ${on[0]}`);
        }
      }
    } catch (err) {
      notePassFailure("healStrayInstanceLookKeys", orgId, err);
      failed++;
      console.warn(`[heal-stray-instance-look-keys] org ${orgId}:`, (err as Error).message);
    }
  }
  await noteHealShim("api/src/platform/heal-stray-instance-look-keys.ts", healed, failed).catch(() => {});
  return healed;
}
