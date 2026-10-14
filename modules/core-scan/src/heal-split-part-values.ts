// One-shot heal: a pack's part that a boot heal split before #6456 carries
// the pack's values, not its own: the pack's mixed colour and count on its
// route, and the pack's whole weight in its name.
//
// DONE WHEN: no tenant DB has a pending core_scan_inbox_items row split from
// a pack (suggested_metadata ? 'pack_colour') whose route or name still
// carries its pack's values. Check with, per tenant:
//   select count(*) from core_scan_inbox_items c
//     join core_scan_inbox_items p on p.id::text = c.suggested_metadata->>'split_from'
//    where c.status = 'pending' and c.suggested_metadata ? 'pack_colour'
//      and (c.suggested_candidates::text ilike '%' || (p.suggested_metadata->'line_pack'->>'colour') || '%'
//           or c.suggested_name ilike '% / ' || replace(p.suggested_metadata->'line_pack'->>'whole', ' ', '') || ' / %');
// /healthz reports the count this pass found (noteHealShim). When it reads 0
// on prod, staging and dev, delete this file and its boot call.
//
// BORN WITH: nothing (a part made now is named without the pack's weight in
// pack-parts.ts, and the store-host heal hands a part its line's route through
// partCandidates, the one door that leaves the pack's values on the line).
//
// A pack line split with no picture of its own (the split ended its plan
// before the picture step) is given one once: DONE WHEN also no resolved row
// with suggested_metadata->>'pack_split' = 'true', no catalog_image_file_id
// and no line_picture_asked.
//
// WHY IT EXISTS: the owner's Kingroon 10-pack, split on the hosted service, showed ten
// spools each with Colour "Mixed (10 colours)" and "10KG" in its name.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { CoreScanDB } from "./db.js";
import { mergeMeta } from "./services/metadata.js";
import { partCandidates, partNameWithoutWhole } from "./services/row-parts.js";

type Meta = Record<string, unknown>;
type Pack = { count?: unknown; each?: unknown; whole?: unknown; colour?: unknown };

/** What a stored part should say instead, or null when it says it already. */
export function healedPart(
  part: { suggested_name: string | null; quantity: unknown; suggested_candidates: unknown; suggested_metadata: unknown },
  lineMeta: Meta,
): { name: string | null; candidates: unknown[] | null } | null {
  const pack = (lineMeta.line_pack ?? {}) as Pack;
  const meta = (part.suggested_metadata ?? {}) as Meta;
  const name = part.suggested_name ? partNameWithoutWhole(part.suggested_name, pack.whole, pack) : null;
  const renamed = name !== null && name !== part.suggested_name;
  const list = Array.isArray(part.suggested_candidates) ? part.suggested_candidates : null;
  const n = Math.max(1, Math.round(Number(part.quantity ?? 1)) || 1);
  // Only a route that is the pack's own: it names the pack's mixed colour,
  // or the pack's count on a part that is not the whole pack. A part a
  // person's session matched on its own is left as it is.
  const mixed = typeof pack.colour === "string" && pack.colour ? pack.colour.toLowerCase() : null;
  const count = typeof pack.count === "number" ? pack.count : null;
  const packs = !!list && list.some((c) => {
    const cand = (c ?? {}) as { fields?: Meta; quantity?: unknown };
    return (mixed !== null && Object.values(cand.fields ?? {}).some((v) => typeof v === "string" && v.toLowerCase() === mixed)) || (count !== null && count > 1 && n < count && cand.quantity === count);
  });
  if (!renamed && !packs) return null;
  return { name: renamed ? name : null, candidates: packs ? partCandidates(list, lineMeta, { n, meta }) : null };
}

/** Heal one workspace. Cheap when settled: one read of the waiting pack
 *  parts, and their lines. */
export async function healSplitPartValuesIn(
  orgId: string,
  db: Kysely<CoreScanDB>,
  refreshPicture?: (orgId: string, itemId: string, name: string) => Promise<unknown>,
): Promise<number> {
  // A pack line split before its picture step ran has none: it heads its
  // parts with a placeholder (#6456). It gets one through the picture's door.
  const bare = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name"])
    .where("status", "=", "resolved")
    .where("catalog_image_file_id", "is", null)
    .where(sql<boolean>`suggested_metadata->>'pack_split' = 'true'`)
    .where(sql<boolean>`suggested_metadata->'line_picture_asked' is null`)
    .limit(50)
    .execute();
  let pictured = 0;
  for (const line of bare) {
    try {
      await (refreshPicture ?? (await import("./services/enrich-photo.js")).refreshCatalogImageByName)(orgId, line.id, line.suggested_name ?? "");
      pictured++;
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-split-part-values", orgId, err);
    }
    // Asked once: a line whose sources have no picture is not asked every boot.
    await db.updateTable("core_scan_inbox_items").set({ suggested_metadata: mergeMeta({ line_picture_asked: true }) as never }).where("id", "=", line.id).execute();
  }
  const parts = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "quantity", "suggested_candidates", "suggested_metadata"])
    .where("status", "=", "pending")
    .where(sql<boolean>`suggested_metadata ? 'pack_colour'`)
    .where(sql<boolean>`suggested_metadata->>'split_from' is not null`)
    .limit(500)
    .execute();
  if (!parts.length) return pictured;
  const lineIds = [...new Set(parts.map((p) => (p.suggested_metadata as Meta | null)?.split_from).filter((x): x is string => typeof x === "string"))];
  const lines = await db.selectFrom("core_scan_inbox_items").select(["id", "suggested_metadata"]).where("id", "in", lineIds).execute();
  const lineMeta = new Map(lines.map((l) => [l.id, (l.suggested_metadata ?? {}) as Meta]));
  let healed = pictured;
  for (const p of parts) {
    const line = lineMeta.get(String((p.suggested_metadata as Meta).split_from));
    if (!line) continue;
    const fix = healedPart(p, line);
    if (!fix) continue;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        ...(fix.name ? { suggested_name: fix.name, suggested_metadata: mergeMeta({ description: fix.name }) as never } : {}),
        // jsonb-replace-ok: the part's own route, from its line's (partCandidates)
        ...(fix.candidates ? { suggested_candidates: JSON.stringify(fix.candidates) as never } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", p.id)
      .execute();
    healed++;
  }
  if (healed) console.log(`[core-scan] org ${orgId}: ${healed} pack part(s) now carry their own colour and name`);
  return healed;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger. */
export function registerSplitPartValuesHeal(): void {
  registerHealPass({
    name: "core-scan.heal-split-part-values",
    shim: "modules/core-scan/src/heal-split-part-values.ts",
    module: "core-scan",
    visit: ({ orgId, db }) => healSplitPartValuesIn(orgId, db as Kysely<CoreScanDB>),
  });
}
