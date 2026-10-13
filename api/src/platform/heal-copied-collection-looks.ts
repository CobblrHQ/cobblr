// One-time, idempotent heal for collections a send made without their look.
// DONE WHEN: this pass finds 0 copies to heal on prod + staging + dev on
// consecutive boots; then delete this file and its boot call.
//
// BORN WITH: prepareTargetShape (record-send.ts), which since #6208 makes a
// matching collection with the source's look under module:instance
//
// "Create matching collection" on a send to another of your workspaces read
// the source collection's look (its noun, labels, icon, layout) under the
// bare instance name, where nothing keeps it, and wrote that nothing to the
// copy: a Bookshelf whose books were "Bookshelves", drawn as an inventory
// table (#6155). Each such copy whose look is still exactly what that left
// (no labels, no icon, an empty config) takes the source's look now. A copy
// anyone has renamed or set up by hand is never touched; neither is one whose
// source no longer exists here or has no look to give.

import { sql } from "kysely";
import { upsertOverride } from "./entity-kind-overrides.js";
import { meta } from "../db/meta.js";
import { noteHealShim } from "./heal-shim-log.js";
import { notePassFailure } from "./pass-failures.js";

type Look = { display_label: string | null; display_label_plural: string | null; icon: string | null; config: Record<string, unknown> | null };

/** The look the bug left: nothing anyone chose. */
export function lookIsTheBugs(look: Look | undefined): boolean {
  if (!look) return true;
  return !look.display_label && !look.display_label_plural && !look.icon && Object.keys(look.config ?? {}).length === 0;
}

/** The boot call: skipped where historical heals are (a fresh test stack). */
export async function healCopiedCollectionLooksAtBoot(): Promise<number> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") return 0;
  return healCopiedCollectionLooks();
}

/** The pass itself, over every workspace or only `onlyOrgId` (the copy's). */
export async function healCopiedCollectionLooks(opts: { onlyOrgId?: string } = {}): Promise<number> {
  const sends = await meta
    .selectFrom("share_offers")
    .select([sql<string>`target_org_id::text`.as("target"), sql<string>`source->>'org_id'`.as("source"), sql<string>`source->>'kind'`.as("kind")])
    .distinct()
    .where("target_org_id", "is not", null)
    .where("direction", "=", "out")
    .where(sql<boolean>`source->>'kind' like '%:item'`)
    .$if(!!opts.onlyOrgId, (q) => q.where("target_org_id", "=", opts.onlyOrgId!))
    .execute();
  let healed = 0;
  let failed = 0;
  for (const s of sends) {
    const instance = s.kind.slice(0, -":item".length);
    try {
      const inst = await meta.selectFrom("workspace_module_instances").select("module_name").where("org_id", "=", s.target).where("instance_name", "=", instance).executeTakeFirst();
      if (!inst) continue;
      const key = `${inst.module_name}:${instance}`;
      const lookOf = (orgId: string, id: string) =>
        meta.selectFrom("entity_kind_overrides").select(["display_label", "display_label_plural", "icon", "config"]).where("org_id", "=", orgId).where("target_kind", "=", "instance").where("target_id", "=", id).executeTakeFirst() as Promise<Look | undefined>;
      const source = await lookOf(s.source, key);
      if (lookIsTheBugs(source)) continue;
      if (!lookIsTheBugs(await lookOf(s.target, key)) || !lookIsTheBugs(await lookOf(s.target, instance))) continue;
      await upsertOverride({
        orgId: s.target,
        targetKind: "instance",
        targetId: key,
        displayLabel: source!.display_label ?? undefined,
        displayLabelPlural: source!.display_label_plural ?? undefined,
        icon: source!.icon ?? undefined,
        config: source!.config ?? {},
      });
      healed++;
      console.log(`[heal-copied-collection-looks] org ${s.target} ${key}: the source's look`);
    } catch (err) {
      notePassFailure("healCopiedCollectionLooks", s.target, err);
      failed++;
      console.warn(`[heal-copied-collection-looks] org ${s.target} ${instance}:`, (err as Error).message);
    }
  }
  await noteHealShim("api/src/platform/heal-copied-collection-looks.ts", healed, failed).catch(() => {});
  return healed;
}
