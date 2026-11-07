// One-shot heal: a code scanned while a catalog's test entry could name it.
//
// DONE WHEN: /healthz reads 0 for this shim on prod, canary, staging and app,
// meaning no pending row wears a test entry and no filed record still does. It
// records the count itself through registerHealPass (noteHealShim). Nothing
// re-creates the shape: the lookup refuses the entry at every door and the cache
// read asks again. Delete this file, its boot call and the finder that uses it then.
//
// WHY IT EXISTS: without a go-upc key, Open Food Facts named a Stabilo pen
// "Diagnostic Test Product DELETE ME" (#9304). Refusing the entry stops new rows;
// this is for the rows it already named. A pending row is still a suggestion, so
// it takes the next answer or goes blank. A filed record is never renamed, because
// its person may have edited that name: it is counted here and offered to them as
// a tidy suggestion, and only while it still reads as the test entry.

import { Kysely, sql } from "kysely";
import { countOf, platform, type TidyCandidate } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { personNameOf, USER_NAME_KEY } from "@cobblr/platform-contract/display-identity";
import { mergeMeta } from "./services/metadata.js";
import { catalogAnswerForCode } from "./services/catalog-answer.js";
import { isCatalogTestEntry } from "./services/catalog-test-entry.js";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    barcode_text: string | null;
    suggested_name: string | null;
    suggested_manufacturer: string | null;
    suggested_metadata: unknown;
    suggested_candidates: unknown;
    catalog_image_url: string | null;
    catalog_image_file_id: string | null;
    target_module: string | null;
    target_kind: string | null;
    target_entity_id: string | null;
    created_at: Date;
    ai_notes: string | null;
  };
}

interface Row {
  id: string;
  status: string;
  barcode_text: string | null;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_metadata: unknown;
  suggested_candidates: unknown;
  target_module: string | null;
  target_kind: string | null;
  target_entity_id: string | null;
}

const CATALOGS = new Set(["go-upc", "upcitemdb", "openfoodfacts", "openproductsfacts", "openbeautyfacts", "openpetfoodfacts", "openlibrary", "musicbrainz", "bidb"]);

/** Only a name a catalog supplied. A person's word is theirs even when it is
 *  "test": one they typed on the card is stamped on the row, and one from their
 *  own records or an import never came from a catalog. Pure. */
export function wearsATestEntry(r: Pick<Row, "suggested_name" | "suggested_manufacturer" | "suggested_metadata">): boolean {
  const meta = (r.suggested_metadata ?? {}) as { source?: unknown; lookup_source?: unknown };
  if (personNameOf(meta)) return false;
  if (!CATALOGS.has(String(meta.lookup_source ?? meta.source))) return false;
  return isCatalogTestEntry({ title: r.suggested_name, brand: r.suggested_manufacturer });
}

/** Every place a scan copied the entry's name and brand into a row: the fields
 *  bag and the candidates carry them for the commit, so a row renamed only on
 *  its face would file the test entry anyway. Pure. */
export function withoutTheEntry<T>(value: T, entry: { name: string; brand: string | null }, next: { title: string; brand: string | null }): T {
  const walk = (v: unknown): unknown => {
    if (v === entry.name) return next.title;
    if (entry.brand && v === entry.brand) return next.brand ?? "";
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

// Only narrows the read; isCatalogTestEntry decides.
const rowsOfTheShape = (db: Kysely<HealDB>) =>
  db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "barcode_text", "suggested_name", "suggested_manufacturer", "suggested_metadata", "suggested_candidates", "target_module", "target_kind", "target_entity_id"])
    .where("barcode_text", "is not", null)
    .where(sql<boolean>`concat(suggested_name, ' ', suggested_manufacturer) ~* '(test|exampl|sample|dummy|fake|prueba|lorem|qwerty|delete|supprimer|utiliser|do not)'`);

export interface FiledTestEntry { kind: string; id: string; name: string; url?: string }

/** Filed records that still read as the test entry. One whose name differs has
 *  been changed by someone, and there is nothing to say about it. */
export async function filedRecordsStillNamedByATestEntry(orgId: string, db: Kysely<HealDB>): Promise<FiledTestEntry[]> {
  const rows = await rowsOfTheShape(db).where("status", "=", "resolved").where("target_entity_id", "is not", null).execute();
  const out: FiledTestEntry[] = [];
  for (const r of rows as Row[]) {
    if (!wearsATestEntry(r) || !r.target_kind || !r.target_entity_id) continue;
    const kind = r.target_kind.includes(":") ? r.target_kind : `${r.target_module}:${r.target_kind}`;
    const record = await platform().entities.lookup(orgId, kind, r.target_entity_id).catch(() => null);
    if (!record || record.title.trim().toLowerCase() !== (r.suggested_name ?? "").trim().toLowerCase()) continue;
    out.push({ kind, id: r.target_entity_id, name: record.title, ...(record.detailUrl ? { url: record.detailUrl } : {}) });
  }
  return out;
}

/** Heal one workspace. `found` is what still wears a test entry after the visit:
 *  filed records nothing here may change, and pending rows the catalogs could not
 *  be asked about, which the next round tries again. */
export async function healRowsNamedByATestEntryIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<{ found: number; settled: boolean }> {
  const pending = ((await rowsOfTheShape(db).where("status", "=", "pending").where("created_at", "<", since).execute()) as Row[]).filter(wearsATestEntry);
  let waiting = 0;
  let healed = 0;
  for (const r of pending) {
    const answer = await catalogAnswerForCode(r.barcode_text!, orgId);
    const hit = answer.hit;
    if (!hit && (answer.lookupUnreachable || answer.rateLimited)) {
      waiting++;
      continue;
    }
    const entry = { name: r.suggested_name ?? "", brand: r.suggested_manufacturer };
    const next = { title: hit?.title ?? "", brand: hit?.brand ?? null };
    const before = (r.suggested_metadata ?? {}) as Record<string, unknown>;
    const after = withoutTheEntry(before, entry, next);
    // Only the keys that held the entry: other passes write this bag too.
    const metadata = Object.fromEntries(Object.entries(after).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        // Blank when nothing answers: a person or a photo can name it.
        suggested_name: hit?.title ?? null,
        suggested_manufacturer: hit?.brand ?? null,
        suggested_metadata: mergeMeta(metadata) as never,
        suggested_candidates: JSON.stringify(withoutTheEntry(r.suggested_candidates ?? [], entry, next)) as never,
        // The entry's picture goes with its name.
        catalog_image_url: hit?.image_url ?? null,
        catalog_image_file_id: null,
        ai_notes: hit ? "Renamed: a catalog had answered with a test entry for this code." : "Left blank: a catalog answered with a test entry for this code.",
      })
      .where("id", "=", r.id)
      .where("status", "=", "pending")
      // A name changed since the read is a person's, and stays.
      .where("suggested_name", "=", entry.name)
      .where(sql<boolean>`suggested_metadata->>${USER_NAME_KEY} is null`)
      .execute();
    healed++;
  }
  if (healed > 0) console.log(`[core-scan] org ${orgId}: ${healed} pending row(s) no longer named by a test entry`);
  const filed = await filedRecordsStillNamedByATestEntry(orgId, db);
  return { found: waiting + filed.length, settled: waiting === 0 };
}

/** What a person is offered, while a filed record still reads as a test entry. */
export function testEntryNamesCandidate(filed: FiledTestEntry[]): TidyCandidate[] {
  if (!filed.length) return [];
  const one = filed.length === 1;
  return [
    {
      id: "test-entry-named-records",
      kind: "test-entry-named-record",
      records: filed,
      why: `${one ? "This record was" : `These ${countOf(filed.length, "record")} were`} named from a test entry in a barcode catalog. Check ${one ? "its name" : "their names"}.`,
      priority: 40,
      action: { route: filed[0]!.url ?? "/scan" },
    },
  ];
}

/** Call from onBoot. */
export function registerRowsNamedByATestEntryHeal(): void {
  registerHealPass({
    name: "core-scan.heal-rows-named-by-a-test-entry",
    since: "2026-11-07T15:00:00Z",
    shim: "modules/core-scan/src/heal-rows-named-by-a-test-entry.ts",
    module: "core-scan",
    visit: ({ orgId, db, since }) => healRowsNamedByATestEntryIn(orgId, db as Kysely<HealDB>, since),
  });
}
