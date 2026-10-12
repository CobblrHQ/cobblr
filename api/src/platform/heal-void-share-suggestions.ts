// One-time, idempotent heal for "edits" a friend never made.
// DONE WHEN: this pass finds 0 rows on prod + staging + dev on consecutive
// boots; then delete this file and its boot call.
//
// BORN WITH: nothing (receiveEdit refuses a field the record works out
// itself since #6039, so no new waiting suggestion of this shape is stored)
//
// A friend who accepted a share and only opened a record left the owner a
// Stock conflict "by" them (#6038): inventory's stock reading is a field the
// record works out itself, it carries the record's own id, so the copy's
// reading never matched the owner's and was sent back as an edit. Such a
// suggestion still waits on the owner's review list, asking them to decide
// on a change nobody made. It is marked `void`: never an edit, on no list,
// and the friend is not told an answer to a question they never asked.
// Only a waiting one on a native read-only field; a custom field is never
// read-only, and an edit already decided stays as it was decided.

import { meta } from "../db/meta.js";
import { kindRecordForOrg } from "./entities.js";
import { noteHealShim } from "./heal-shim-log.js";
import { notePassFailure } from "./pass-failures.js";

/** The boot call: skipped where historical heals are (a fresh test stack). */
export async function voidReadOnlyShareSuggestionsAtBoot(): Promise<number> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") return 0;
  return voidReadOnlyShareSuggestions();
}

/** The pass itself, over every workspace or only `onlyOrgId`. */
export async function voidReadOnlyShareSuggestions(opts: { onlyOrgId?: string } = {}): Promise<number> {
  const waiting = await meta
    .selectFrom("share_suggestions")
    .select(["id", "org_id", "entity_kind", "field"])
    .where("status", "in", ["pending", "conflict"])
    .where("in_metadata", "=", false)
    .$if(!!opts.onlyOrgId, (q) => q.where("org_id", "=", opts.onlyOrgId!))
    .execute();
  const byKind = new Map<string, typeof waiting>();
  for (const s of waiting) byKind.set(`${s.org_id}\u0000${s.entity_kind}`, [...(byKind.get(`${s.org_id}\u0000${s.entity_kind}`) ?? []), s]);
  let voided = 0;
  let failed = 0;
  for (const rows of byKind.values()) {
    const { org_id, entity_kind } = rows[0]!;
    try {
      const readOnly = new Set(((await kindRecordForOrg(org_id, entity_kind))?.fields ?? []).filter((f) => (f as { readOnly?: boolean }).readOnly === true).map((f) => f.name));
      const ids = rows.filter((r) => readOnly.has(r.field)).map((r) => r.id);
      if (!ids.length) continue;
      const done = await meta.updateTable("share_suggestions").set({ status: "void", decided_at: new Date() }).where("id", "in", ids).where("status", "in", ["pending", "conflict"]).executeTakeFirst();
      voided += Number(done.numUpdatedRows ?? 0);
      console.log(`[heal-void-share-suggestions] org ${org_id} ${entity_kind}: ${ids.length} made void`);
    } catch (err) {
      notePassFailure("voidReadOnlyShareSuggestions", org_id, err);
      failed++;
      console.warn(`[heal-void-share-suggestions] org ${org_id} ${entity_kind}:`, (err as Error).message);
    }
  }
  await noteHealShim("api/src/platform/heal-void-share-suggestions.ts", voided, failed).catch(() => {});
  return voided;
}
