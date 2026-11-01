import { meta } from "../db/meta.js";

type Look = { display_label: string | null; display_label_plural: string | null; icon: string | null; config: Record<string, unknown> | null };

/** The look the bug left: nothing anyone chose. */
export function lookIsTheBugs(look: Look | undefined): boolean {
  if (!look) return true;
  return !look.display_label && !look.display_label_plural && !look.icon && Object.keys(look.config ?? {}).length === 0;
}

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
