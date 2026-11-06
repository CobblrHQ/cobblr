// One-shot heal: a book scanned while Open Library answered with an advert.
//
// DONE WHEN: /healthz reads 0 for this shim on prod, canary, staging and app,
// meaning no pending row wears an advert and no filed record still does. It
// records the count itself through registerHealPass (noteHealShim). Nothing
// re-creates the shape: answerAgreesWithCode refuses the record at every door.
// Delete this file, its boot call and the finder that uses it then.
//
// WHY IT EXISTS: from 2026-11-05 the Books API answered "BYDFi Referral Code"
// for Effective Java's ISBN (#9225). Refusing the record stops new rows; this is
// for the rows it already named (#9259). A pending row is still a suggestion, so
// it takes the book's name. A filed record is never renamed, because its person
// may have edited that name: it is counted here and offered to them as a tidy
// suggestion, and only while it still reads as the advert.

import { Kysely, sql } from "kysely";
import { countOf, platform, type TidyCandidate } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { codeKindOf, isAdvertNotABook, type BarcodeHit } from "./services/barcode-lookup.js";
import { mergeMeta } from "./services/metadata.js";
import { catalogAnswerForCode } from "./services/catalog-answer.js";

interface HealDB {
  core_scan_inbox_items: {
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

/** The record's own shape, read back off the row a scan wrote from it. Pure. */
export function rowWearsAnAdvert(row: Pick<Row, "barcode_text" | "suggested_name" | "suggested_manufacturer" | "suggested_metadata">): boolean {
  if (!row.barcode_text || codeKindOf(row.barcode_text) !== "book") return false;
  const fields = (row.suggested_metadata as { fields?: BarcodeHit["fields"] } | null)?.fields;
  return isAdvertNotABook({ title: row.suggested_name ?? "", brand: row.suggested_manufacturer, fields, raw: {} } as BarcodeHit);
}

/** Every place a scan copied the advert's two credits into a row: the fields
 *  bag and the candidates' fields carry them for the commit, so a row renamed
 *  only on its face would file the advert anyway. Pure. */
export function withoutTheAdvert<T>(value: T, advert: string, book: { title: string; publisher: string | null }): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") return v === advert ? (key && /publisher|brand|manufacturer/i.test(key) ? (book.publisher ?? "") : book.title) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

const rowsOfTheShape = (db: Kysely<HealDB>) =>
  db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "barcode_text", "suggested_name", "suggested_manufacturer", "suggested_metadata", "suggested_candidates", "target_module", "target_kind", "target_entity_id"])
    .where("barcode_text", "is not", null)
    .where("status", "in", ["pending", "resolved"])
    .where(sql<boolean>`lower(suggested_name) = lower(suggested_manufacturer)`);

export interface FiledAdvert { kind: string; id: string; name: string; url?: string }

/** Filed records that still read as the advert. One whose name differs has been
 *  changed by someone, and there is nothing to say about it. */
export async function filedBooksStillNamedByAnAdvert(orgId: string, db: Kysely<HealDB>): Promise<FiledAdvert[]> {
  const rows = await rowsOfTheShape(db).where("status", "=", "resolved").where("target_entity_id", "is not", null).execute();
  const out: FiledAdvert[] = [];
  for (const r of rows as Row[]) {
    if (!rowWearsAnAdvert(r) || !r.target_kind || !r.target_entity_id) continue;
    const kind = r.target_kind.includes(":") ? r.target_kind : `${r.target_module}:${r.target_kind}`;
    const record = await platform().entities.lookup(orgId, kind, r.target_entity_id).catch(() => null);
    if (!record || record.title.trim().toLowerCase() !== (r.suggested_name ?? "").trim().toLowerCase()) continue;
    out.push({ kind, id: r.target_entity_id, name: record.title, ...(record.detailUrl ? { url: record.detailUrl } : {}) });
  }
  return out;
}

/** Heal one workspace. `found` is what still wears an advert after the visit:
 *  filed records nothing here may change, and pending rows the catalog could
 *  not be asked about, which the next round tries again. */
export async function healBooksNamedByAnAdvertIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<{ found: number; settled: boolean }> {
  const pending = ((await rowsOfTheShape(db).where("status", "=", "pending").where("created_at", "<", since).execute()) as Row[]).filter(rowWearsAnAdvert);
  let waiting = 0;
  let renamed = 0;
  for (const r of pending) {
    const advert = r.suggested_name!;
    const answer = await catalogAnswerForCode(r.barcode_text!, orgId);
    const hit = answer.hit;
    if (!hit && (answer.lookupUnreachable || answer.rateLimited)) {
      waiting++;
      continue;
    }
    const book = { title: hit?.title ?? "", publisher: hit?.brand ?? null };
    const before = (r.suggested_metadata ?? {}) as Record<string, unknown>;
    const after = withoutTheAdvert(before, advert, book);
    // Only the keys that held the advert: other passes write this bag too.
    const metadata = Object.fromEntries(Object.entries(after).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(before[k])));
    // As a scan writes them: `decoded` with the title, `fields` without it,
    // since the name carries it (enrich.ts).
    if (hit?.fields) {
      metadata.decoded = { decoder_id: hit.decoder_id ?? "isbn", fields: hit.fields };
      metadata.fields = Object.fromEntries(Object.entries(hit.fields).filter(([k]) => k !== "title"));
    }
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        // Blank when no book answers: a person or a photo can name it.
        suggested_name: hit?.title ?? null,
        suggested_manufacturer: hit?.brand ?? null,
        suggested_metadata: mergeMeta(metadata) as never,
        suggested_candidates: JSON.stringify(withoutTheAdvert(r.suggested_candidates ?? [], advert, book)) as never,
        ai_notes: hit ? "Renamed: the book catalog had answered with an advert for this ISBN." : "Left blank: the book catalog answered with an advert for this ISBN.",
      })
      .where("id", "=", r.id)
      .where("status", "=", "pending")
      // A name changed since the read is a person's, and stays.
      .where("suggested_name", "=", advert)
      .execute();
    renamed++;
  }
  if (renamed > 0) console.log(`[core-scan] org ${orgId}: ${renamed} pending book row(s) no longer named by an advert`);
  const filed = await filedBooksStillNamedByAnAdvert(orgId, db);
  return { found: waiting + filed.length, settled: waiting === 0 };
}

/** What a person is offered, while a filed book still reads as the advert. */
export function advertNamesCandidate(filed: FiledAdvert[]): TidyCandidate[] {
  if (!filed.length) return [];
  const one = filed.length === 1;
  return [
    {
      id: "advert-named-books",
      kind: "advert-named-book",
      records: filed,
      why: `${one ? "This book was" : `These ${countOf(filed.length, "book")} were`} named from a spam entry in a book catalog. Check ${one ? "its name" : "their names"}.`,
      priority: 40,
      action: { route: filed[0]!.url ?? "/scan" },
    },
  ];
}

/** Call from onBoot. */
export function registerBooksNamedByAnAdvertHeal(): void {
  registerHealPass({
    name: "core-scan.heal-books-named-by-an-advert",
    since: "2026-11-06T16:00:00Z",
    shim: "modules/core-scan/src/heal-books-named-by-an-advert.ts",
    module: "core-scan",
    visit: ({ orgId, db, since }) => healBooksNamedByAnAdvertIn(orgId, db as Kysely<HealDB>, since),
  });
}
