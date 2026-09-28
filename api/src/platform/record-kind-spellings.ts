// Every spelling of one record's kind.
//
// A record in a collection answers to two kinds: its module's own
// (`machines:machine`) and its collection's (`3d-printers:item`). A link is
// stored with whichever spelling the door that made it had to hand, so a
// mod linked to a printer from a search hit said `3d-printers:item`, and the
// printer's own page, asking for `machines:machine`, never saw it (#3875).
// Reading and de-duplicating links over the whole set is what makes a link
// show on both sides whichever door made it.
import { meta } from "../db/meta.js";
import { resolveKind } from "./entities.js";

export async function recordKindSpellings(orgId: string, kind: string): Promise<string[]> {
  const out = new Set<string>([kind]);
  const { base } = await resolveKind(orgId, kind);
  out.add(base);
  const row = await meta.selectFrom("entity_kinds").select(["module_name", "is_primary"]).where("id", "=", base).executeTakeFirst();
  // Only a module's primary kind is what `<name>:item` stands for.
  if (row?.is_primary) {
    const instances = await meta
      .selectFrom("workspace_module_instances")
      .select("instance_name")
      .where("org_id", "=", orgId)
      .where("module_name", "=", row.module_name)
      .execute();
    for (const i of instances) out.add(`${i.instance_name}:item`);
  }
  return [...out];
}

/** A link's meaning in words: `installed-on` reads "installed on". */
export function linkWords(relationshipKind: string): string {
  return relationshipKind.replace(/[-_]+/g, " ").trim();
}
