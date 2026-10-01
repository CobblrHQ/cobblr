// A record's last photo search, kept as links (#4515).
//
// The results are remembered, not the pictures: each one's address,
// thumbnail and page, a few KB a record. Reopening the panel shows that list
// with no new search; Search runs a fresh one and replaces it. The result AI
// Pick chose and the one the record uses are remembered by address, so after
// a reload the panel still outlines the photo in use and keeps its AI mark.
import { sql, type Kysely } from "kysely";
import type { CoreScanDB } from "../db.js";

export interface RememberedResult {
  url: string;
  thumb: string;
  title: string;
  source: string;
  width?: number;
  height?: number;
}

export interface RememberedSearch {
  query: string | null;
  items: RememberedResult[];
  ai_url: string | null;
  ai_reason: string | null;
  used_url: string | null;
  used_file_id: string | null;
}

const T = "core_scan_record_photo_searches" as const;

export async function rememberedSearch(db: Kysely<CoreScanDB>, kind: string, id: string): Promise<RememberedSearch | null> {
  const row = await db.selectFrom(T).selectAll().where("entity_kind", "=", kind).where("entity_id", "=", id).executeTakeFirst();
  if (!row) return null;
  return {
    query: row.query,
    items: (Array.isArray(row.items) ? row.items : []) as RememberedResult[],
    ai_url: row.ai_url,
    ai_reason: row.ai_reason,
    used_url: row.used_url,
    used_file_id: row.used_file_id,
  };
}

/** A search ran: its list replaces the last one. What was chosen stays, so a
 *  fresh search that finds the same picture still shows it in use. */
export async function rememberSearch(db: Kysely<CoreScanDB>, kind: string, id: string, query: string | null, items: RememberedResult[]): Promise<void> {
  const kept = items.slice(0, 24).map(({ url, thumb, title, source, width, height }) => ({ url, thumb, title, source, ...(width ? { width } : {}), ...(height ? { height } : {}) }));
  await db
    .insertInto(T)
    .values({ entity_kind: kind, entity_id: id, query, items: JSON.stringify(kept) as never })
    .onConflict((oc) => oc.columns(["entity_kind", "entity_id"]).doUpdateSet({ query, items: JSON.stringify(kept) as never, updated_at: sql`now()` }))
    .execute();
}

export async function rememberAiPick(db: Kysely<CoreScanDB>, kind: string, id: string, url: string, reason: string): Promise<void> {
  await db
    .insertInto(T)
    .values({ entity_kind: kind, entity_id: id, ai_url: url, ai_reason: reason, items: JSON.stringify([]) as never })
    .onConflict((oc) => oc.columns(["entity_kind", "entity_id"]).doUpdateSet({ ai_url: url, ai_reason: reason, updated_at: sql`now()` }))
    .execute();
}

export async function rememberUsed(db: Kysely<CoreScanDB>, kind: string, id: string, url: string, fileId: string): Promise<void> {
  await db
    .insertInto(T)
    .values({ entity_kind: kind, entity_id: id, used_url: url, used_file_id: fileId, items: JSON.stringify([]) as never })
    .onConflict((oc) => oc.columns(["entity_kind", "entity_id"]).doUpdateSet({ used_url: url, used_file_id: fileId, updated_at: sql`now()` }))
    .execute();
}

/** The file a record's image_path points at, when it is one in the store. */
export function fileIdOfImagePath(imagePath: string | null | undefined): string | null {
  const m = /\/core-files\/files\/([0-9a-f-]{36})\/raw/i.exec(imagePath ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

/** The result the record's photo came from, only while the record still uses
 *  that file: a photo changed since (an upload, Make main on another) is
 *  not "in use" any more, and nothing is outlined. */
export function urlInUse(r: RememberedSearch | null, imagePath: string | null | undefined): string | null {
  if (!r?.used_url || !r.used_file_id) return null;
  return fileIdOfImagePath(imagePath) === r.used_file_id.toLowerCase() ? r.used_url : null;
}
