// A record filed since the row was matched (#8792).
//
// A row is matched once, when it is read. Two photos of the same shelf, one
// from the desk and one from a phone, were each split into four jars and
// matched while the table was still empty; the phone's four were filed, and
// the desk's four then said only "Add" and made a second Garlic, Cumin and
// Cinnamon. Nothing asked again before filing, so a match made against an
// empty table was trusted.
//
// So filing a NEW record first asks whether one of the same name is already
// in that table, filed by another scan since this row was matched. The
// person is asked once per record (the row remembers it was asked), so
// pressing Add again keeps it as a second one, and a record they said to
// keep separate from is never asked about.

import type { Kysely } from "kysely";
import { platform, type ResolvedEntity } from "@cobblr/platform-contract";
import { scanKeptSeparateFrom } from "@cobblr/platform-contract/scan-triage";
import type { CoreScanDB } from "../db.js";

export const FILED_SINCE_ASKED_KEY = "filed_since_asked";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Pure: of the records listed, the one this row should be asked about
 *  before it is filed as new, or null. */
export function unaskedSameName(
  row: { suggested_metadata?: unknown },
  name: string,
  listed: ReadonlyArray<Pick<ResolvedEntity, "id" | "title">>,
): Pick<ResolvedEntity, "id" | "title"> | null {
  const want = norm(name);
  if (!want) return null;
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const separate = scanKeptSeparateFrom(meta);
  const asked = typeof meta[FILED_SINCE_ASKED_KEY] === "string" ? (meta[FILED_SINCE_ASKED_KEY] as string) : null;
  return listed.find((e) => norm(e.title ?? "") === want && e.id !== separate && e.id !== asked) ?? null;
}

/** The record of this name in `kind` the row should be asked about, or null:
 *  one another scan filed after this row was matched. A record that was
 *  there when the row was matched and that the match did not offer is the
 *  match's own judgement, and is left to it. A table that cannot be listed
 *  asks nothing: filing is never blocked by a check that could not run. */
export async function filedSinceMatched(
  db: Kysely<CoreScanDB>,
  orgId: string,
  kind: string,
  row: { suggested_metadata?: unknown },
  name: string,
  /** Rows filed together with this one, in one selection: two identical
   *  captures a person picked and added at once are two on purpose, so a
   *  record one of them made is never asked about. */
  together: readonly string[] = [],
): Promise<Pick<ResolvedEntity, "id" | "title"> | null> {
  const matchedAt = (row.suggested_metadata as { matched_at?: unknown } | null)?.matched_at;
  if (!name.trim() || typeof matchedAt !== "string" || Number.isNaN(Date.parse(matchedAt))) return null;
  const listed = await platform()
    .entities.list(orgId, kind, { q: name.trim(), limit: 10 })
    .catch(() => null);
  if (!listed || listed.failed || listed.unlisted || !listed.items.length) return null;
  const since = await db
    .selectFrom("core_scan_inbox_items")
    .select("target_entity_id")
    .where("target_entity_id", "in", listed.items.map((e) => e.id))
    .where("resolved_at", ">", new Date(matchedAt))
    .$if(together.length > 0, (q) => q.where("id", "not in", together))
    .execute()
    .catch((err: Error) => {
      console.error("[core-scan] reading what was filed since a row was matched failed:", err.message);
      return [];
    });
  const filedSince = new Set(since.map((r) => r.target_entity_id));
  return unaskedSameName(row, name, listed.items.filter((e) => filedSince.has(e.id)));
}
