// One-shot heal: a pending row whose name is a photo read that ran on (a
// description of the picture, not a name) is set back to nameless (#6100).
//
// DONE WHEN: no tenant DB has a pending core_scan_inbox_items row named from
// its photo whose name reads as prose. Check with, per tenant:
//   select id, length(suggested_name) from core_scan_inbox_items
//    where status = 'pending' and suggested_metadata->>'source' = 'photo'
//      and (length(suggested_name) > 120
//           or array_length(regexp_split_to_array(trim(suggested_name), '\s+'), 1) > 20);
// and no pending row with an image this heal cleared (its History says
// "prose-name") whose suggested_metadata lacks label_read_all:
//   select id from core_scan_inbox_items
//    where status = 'pending' and suggested_name is null
//      and suggested_metadata->'history' @> '[{"action":"prose-name"}]'
//      and not (suggested_metadata ? 'label_read_all');
// /healthz reports the count this pass found (noteHealShim). When it reads 0
// on prod, staging and dev, delete this file and its boot call. Nothing
// re-creates the shape: parseIdentityReply refuses such a name now.
//
// WHY IT EXISTS: re-judged from its photo, the owner's jar of cumin was named
// with thousands of characters about the jar, the hand and the floor, which a
// hosted model answered instead of a name. The parser took it as the name.
//
// What it does to a row: records its before-state (Put back restores it) and
// names it from its photo's label, the largest product-like line, read with
// no model (label-name.ts); when no line stands out, it clears the name and
// says why, so the card asks the person to name it. A row this heal cleared
// before the label was read is read once too. Each row is read once
// (label_read_all), from every photo of the person's own, the one they chose
// to show first. A name a person gave is never touched (user-name.ts).

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { personNameOf } from "@cobblr/platform-contract/display-identity";
import { LABEL_CLEARED_NOTE, LABEL_NAME_NOTE, PROSE_NAME_NOTE } from "@cobblr/platform-contract/scan-copy";
import type { CoreScanDB } from "./db.js";
import { nameReadsAsProse } from "./services/item-name.js";
import { labelAgrees, labelNameAcross, labelReadOfPhoto } from "./services/label-name.js";
import { ownPhotoFileIds } from "@cobblr/platform-contract/scan-pictures";
import { mergeMeta } from "./services/metadata.js";
import { appendScanHistory, recordRevision } from "./services/scan-history.js";

/** A pending row the photo named with prose, and no person named. */
export function namedWithProse(row: { status: string; suggested_name: string | null; suggested_metadata: unknown }): boolean {
  if (row.status !== "pending" || !row.suggested_name) return false;
  if ((row.suggested_metadata as { source?: unknown } | null)?.source !== "photo") return false;
  if (personNameOf(row.suggested_metadata)) return false;
  return nameReadsAsProse(row.suggested_name);
}

/** A pending row whose name the photo's read left as prose, or that this
 *  heal already set nameless for it, and whose label nobody read yet. */
/** The mark a row's label was read on, from every photo of the person's own
 *  (#6100). A row read before that, from its scan photo alone, is read again:
 *  the owner's front-label shot was the item's picture, not its scan photo. */
export const LABEL_READ_KEY = "label_read_v2";

type HealRow = {
  status: string;
  suggested_name: string | null;
  ai_notes?: string | null;
  suggested_metadata: unknown;
  image_file_id: string | null;
  catalog_image_file_id?: string | null;
  catalog_image_url?: string | null;
  group_image_file_id?: string | null;
};

const photosOf = (row: HealRow): string[] =>
  ownPhotoFileIds({
    image_file_id: row.image_file_id,
    catalog_image_file_id: row.catalog_image_file_id ?? null,
    catalog_image_url: row.catalog_image_url ?? null,
    group_image_file_id: row.group_image_file_id ?? null,
    suggested_metadata: row.suggested_metadata,
  });

/** A name an earlier label read wrote and nobody has touched since: the
 *  note it wrote still stands and no person named the row (#6100: the first
 *  rule named the owner's cumin "Uni"). It is judged again under the rule
 *  that holds now. */
export function namedFromLabel(row: HealRow): boolean {
  const meta = (row.suggested_metadata ?? {}) as { history?: Array<{ action?: string }> };
  return (
    !!row.suggested_name &&
    row.ai_notes === LABEL_NAME_NOTE &&
    !personNameOf(row.suggested_metadata) &&
    Array.isArray(meta.history) &&
    meta.history.some((h) => h.action === "label-name")
  );
}

export function wantsLabelRead(row: HealRow): boolean {
  if (row.status !== "pending" || photosOf(row).length === 0) return false;
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown> & { history?: Array<{ action?: string }> };
  if (meta[LABEL_READ_KEY]) return false;
  if (personNameOf(meta)) return false;
  if (namedWithProse(row) || namedFromLabel(row)) return true;
  return !row.suggested_name && Array.isArray(meta.history) && meta.history.some((h) => h.action === "prose-name");
}

/** What the heal writes for a row, given what its label reads (null when no
 *  line on it stands out). A name the label prints wins; otherwise a run-on
 *  name is cleared and the row asks to be named. */
export function labelHealPlan(
  row: HealRow | { suggested_name: string | null; suggested_metadata: unknown; ai_notes?: string | null },
  label: string | null,
): { name: string | null; note: string | null; action: "label-name" | "prose-name" | "label-cleared" | null } {
  const r = { status: "pending", image_file_id: null, ...row } as HealRow;
  if (label) return label === r.suggested_name ? { name: null, note: null, action: null } : { name: label, note: LABEL_NAME_NOTE, action: "label-name" };
  if (namedWithProse(r)) return { name: null, note: PROSE_NAME_NOTE, action: "prose-name" };
  // A name an earlier rule read off the label that the rule now refuses goes:
  // asking for a name is better than a wrong one.
  if (namedFromLabel(r)) return { name: null, note: LABEL_CLEARED_NOTE, action: "label-cleared" };
  return { name: null, note: null, action: null };
}

/** What the photo read itself said about the thing: a label name must share
 *  a word with it to be taken. */
function readSaid(row: HealRow): string[] {
  const meta = (row.suggested_metadata ?? {}) as { photo_observations?: unknown; category?: unknown };
  return [
    typeof meta.photo_observations === "string" ? meta.photo_observations : null,
    typeof meta.category === "string" ? meta.category : null,
    row.suggested_name && nameReadsAsProse(row.suggested_name) ? row.suggested_name : null,
  ].filter((s): s is string => !!s);
}

type ReadLabel = (orgId: string, fileIds: readonly string[]) => Promise<string | null>;

const readLabelOfFiles: ReadLabel = (orgId, fileIds) =>
  labelNameAcross(fileIds, async (fileId) => {
    const f = (await platform().files.read(orgId, fileId, "original")) ?? (await platform().files.read(orgId, fileId, "medium"));
    return f ? labelReadOfPhoto(Buffer.from(f.bytes)) : null;
  });

/** Heal one workspace. Answers how many rows it found. */
export async function healProseNamesIn(orgId: string, db: Kysely<CoreScanDB>, readLabel: ReadLabel = readLabelOfFiles): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .selectAll()
    .where("status", "=", "pending")
    .where(sql<boolean>`not (suggested_metadata ? ${LABEL_READ_KEY})`)
    .where(
      sql<boolean>`((suggested_metadata->>'source' = 'photo'
          and (length(suggested_name) > 120 or array_length(regexp_split_to_array(trim(suggested_name), '\\s+'), 1) > 20))
        or (suggested_name is null and suggested_metadata->'history' @> '[{"action":"prose-name"}]'::jsonb)
        or suggested_metadata->'history' @> '[{"action":"label-name"}]'::jsonb)`,
    )
    .orderBy("id")
    .limit(50)
    .execute();
  const found = rows.filter(wantsLabelRead);
  for (const r of found) {
    try {
      const read = await readLabel(orgId, photosOf(r)).catch(() => null);
      const plan = labelHealPlan(r, read && labelAgrees(read, readSaid(r)) ? read : null);
      if (!plan.action) {
        await db.updateTable("core_scan_inbox_items").set({ suggested_metadata: mergeMeta({ [LABEL_READ_KEY]: true }) as never }).where("id", "=", r.id).execute();
        continue;
      }
      const revision = await recordRevision(db, r.id, plan.action);
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_name: plan.name,
          ai_notes: plan.note,
          // A name read off a label is a reading, not an identification: the
          // card asks for a look before it is trusted.
          ...(plan.action === "label-name" ? { ai_confidence: "0.5" } : {}),
          suggested_metadata: mergeMeta({ [LABEL_READ_KEY]: true, ...(plan.action === "label-name" ? { low_trust: true } : {}) }) as never,
          updated_at: new Date(),
        })
        .where("id", "=", r.id)
        .execute();
      await appendScanHistory(db, r.id, { action: plan.action, revision });
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-prose-names", orgId, err);
      console.error(`[core-scan] org ${orgId} row ${r.id}: could not re-name a run-on photo read:`, (err as Error).message);
    }
  }
  if (found.length > 0) console.log(`[core-scan] org ${orgId}: re-named ${found.length} run-on photo read(s) from their labels`);
  return found.length;
}

/** Call from onBoot. A registered pass (heal-pass.ts). */
export function registerProseNameHeal(): void {
  registerHealPass({
    name: "core-scan.heal-prose-names",
    shim: "modules/core-scan/src/heal-prose-names.ts",
    module: "core-scan",
    visit: ({ orgId, db }) => healProseNamesIn(orgId, db as Kysely<CoreScanDB>),
  });
}
