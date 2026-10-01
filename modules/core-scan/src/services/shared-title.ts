// The name a person brought: a product's title shared or pasted with its link
// from a shopping app (parseSharedText, @cobblr/platform-contract/shared-text).
//
// It is the person's own name for the thing, so it is kept the way a rename
// is (services/user-name.ts, #2982): on the metadata, stamped person, and
// resolved over the column on every read (the contract's displayName). A shop
// page that blocks automated reads (Amazon's often does) cannot cost it, and
// whatever enrichment finds is offered beside it (the stamp's `replaced`),
// never shown in its place. The person can still rename it, or turn it down
// ("Not right"), like any name of theirs. The stamp says `from: "shared"`, so
// the card can say where the name came from.

import type { Kysely } from "kysely";
import { FIELD_PROVENANCE_KEY, fieldProvenanceOf, type FieldProvenanceMap } from "@cobblr/platform-contract/acquisition-source";
import { personNameOf } from "@cobblr/platform-contract/display-identity";
import type { CoreScanDB } from "../db.js";
import { applyPersonName } from "./user-name.js";

/** Where a row keeps the title it was shared with, apart from the name (the
 *  name can be renamed; this stays what was shared, for the search). */
export const SHARED_TITLE_KEY = "shared_title";

/** The card's word for a row named from what was shared, when nothing else
 *  identified it. */
export const SHARED_NAME_NOTE = "Named from what you shared.";

/** `meta` for a row shared with this title: the title as the person's name,
 *  stamped from "shared", and kept apart for the search. */
export function applySharedTitle(meta: Record<string, unknown>, title: string, at: string = new Date().toISOString()): Record<string, unknown> {
  const next = applyPersonName(meta, title, at);
  const stamps: FieldProvenanceMap = { ...fieldProvenanceOf(next) };
  if (stamps.name) stamps.name = { ...stamps.name, from: "shared" };
  next[FIELD_PROVENANCE_KEY] = stamps;
  next[SHARED_TITLE_KEY] = title.trim();
  return next;
}

/** The name a row still carries from what was shared, or null once the
 *  person renamed it or turned it down: then it no longer steers anything. */
export function sharedNameOf(meta: unknown): string | null {
  const stamp = fieldProvenanceOf(meta).name;
  return stamp?.from === "shared" ? personNameOf(meta) : null;
}

/** The row's shared name, read fresh. */
export async function sharedTitleOf(db: Kysely<CoreScanDB>, itemId: string): Promise<string | null> {
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select("suggested_metadata")
    .where("id", "=", itemId)
    .executeTakeFirst()
    .catch(() => undefined);
  return sharedNameOf(row?.suggested_metadata);
}

/** When nothing identified a shared row (the page refused us, the search
 *  found nothing), the shared title IS the identification: the card says so,
 *  rather than "couldn't identify" over a name the person can see is right. */
export async function noteSharedName(db: Kysely<CoreScanDB>, itemId: string): Promise<void> {
  await db
    .updateTable("core_scan_inbox_items")
    .set({ ai_notes: SHARED_NAME_NOTE, ai_suggested_at: new Date(), updated_at: new Date() })
    .where("id", "=", itemId)
    .where((eb) => eb.or([eb("ai_confidence", "is", null), eb("ai_confidence", "=", "0")]))
    .execute();
}
