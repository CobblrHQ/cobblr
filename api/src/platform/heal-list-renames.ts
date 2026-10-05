// One-time, idempotent heal for list renames written under the wrong key.
// DONE WHEN: this pass finds 0 rows on prod + staging + dev on consecutive
// boots; then delete this file and its boot call.
//
// BORN WITH: nothing (a rename through the assistant now writes the
// `<module>:<instance>` key every reader uses, so no new row of this shape can
// be made)
//
// Renaming a list through the assistant ("call my Computers Rigs") wrote the
// new name to a presentation row keyed by the list's bare name ("computers"),
// while the nav, the palette and the list's own page read the row keyed
// `<module>:<instance>` ("assets:computers"). The assistant said it was done
// and nothing changed (#4495). Each such row is folded into the row the app
// reads: its name, plural and icon land there unless that row was already
// renamed some other way (the newer, visible choice stays), and the dead row
// goes. A row with no counterpart simply takes the right key.

import { meta } from "../db/meta.js";
import { noteHealShim } from "./heal-shim-log.js";
import { notePassFailure } from "./pass-failures.js";

export async function healListRenames(): Promise<number> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") return 0;
  const bare = await meta
    .selectFrom("entity_kind_overrides")
    .selectAll()
    .where("target_kind", "=", "instance")
    .where("target_id", "not like", "%:%")
    .execute();
  let healed = 0;
  let failed = 0;
  for (const row of bare) {
    try {
      const inst = await meta
        .selectFrom("workspace_module_instances")
        .select(["module_name", "instance_name", "display_name"])
        .where("org_id", "=", row.org_id)
        .where("instance_name", "=", row.target_id)
        .executeTakeFirst();
      if (!inst) continue;
      const id = `${inst.module_name}:${inst.instance_name}`;
      const right = await meta
        .selectFrom("entity_kind_overrides")
        .select(["id", "display_label", "display_label_plural", "icon"])
        .where("org_id", "=", row.org_id)
        .where("target_kind", "=", "instance")
        .where("target_id", "=", id)
        .executeTakeFirst();
      if (!right) {
        await meta.updateTable("entity_kind_overrides").set({ target_id: id, updated_at: new Date() }).where("id", "=", row.id).execute();
      } else {
        // The visible row still wears the list's own name: the wrong-key
        // rename is the person's latest word, so it lands.
        const untouched = !right.display_label || right.display_label === inst.display_name;
        if (untouched && row.display_label) {
          await meta
            .updateTable("entity_kind_overrides")
            .set({
              display_label: row.display_label,
              display_label_plural: row.display_label_plural ?? right.display_label_plural,
              ...(row.icon ? { icon: row.icon } : {}),
              updated_at: new Date(),
            })
            .where("id", "=", right.id)
            .execute();
        }
        await meta.deleteFrom("entity_kind_overrides").where("id", "=", row.id).execute();
      }
      healed++;
      console.log(`[heal-list-renames] org ${row.org_id}: ${row.target_id} -> ${id}`);
    } catch (err) {
      notePassFailure("healListRenames", row.org_id, err);
      failed++;
      console.warn(`[heal-list-renames] org ${row.org_id} ${row.target_id}:`, (err as Error).message);
    }
  }
  await noteHealShim("api/src/platform/heal-list-renames.ts", healed, failed).catch(() => {});
  return healed;
}
