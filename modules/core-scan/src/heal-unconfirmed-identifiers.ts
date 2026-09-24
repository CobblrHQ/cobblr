// One-shot heal: a draft identified before an identifier needed evidence on
// the item reads its unsupported identifiers as unconfirmed.
//
// DONE WHEN: no tenant DB has a pending core_scan_inbox_items row for which
// unconfirmedIdentifierStamps (platform-contract scan-evidence.ts) is
// non-empty. /healthz reports the count this pass found (noteHealShim); when
// it reads 0 on prod, staging and dev, delete this file and its boot call.
// Nothing re-creates the shape: the match stamps an identifier found only in
// a catalog search's payload as inference (field-provenance.ts), and the
// title-matched backfill stamps CATALOG_TITLE_MATCHED.
//
// BORN WITH: provenanceStamps (#3613's write-time rule: a match written today
// stamps an identifier the item does not carry as `inference`, never
// `evidence`), so a draft made after the rule never needs this.
//
// WHY IT EXISTS: a blank white book identified before #3613 carried ISBN
// 9798502338400 from an Open Library search on its description, and the old
// stamper called any value in the catalog's payload `evidence/catalog`. The
// read-time rule (stampVouchesForIdentifier) already refuses that stamp
// without the item's own code, so no door files it; this makes the stored
// standing say the same, so the card and anything reading the stamp show the
// ISBN as a suggestion, not a fact (#3647).

import { Kysely, sql } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { FIELD_PROVENANCE_KEY } from "@cobblr/platform-contract/acquisition-source";
import { IDENTIFIER_FIELD_NAMES, unconfirmedIdentifierStamps } from "@cobblr/platform-contract/scan-evidence";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    barcode_text: string | null;
    image_file_id: string | null;
    suggested_name: string | null;
    suggested_candidates: unknown;
    suggested_metadata: unknown;
  };
}

// The identifier keys as they appear in a candidate's JSON, for a cheap
// first pass in SQL; the contract decides.
const IDENT_KEY_SQL = `"(${IDENTIFIER_FIELD_NAMES.source.replace(/^\^\(|\)\$$/g, "")})"\\s*:`;

/** Heal one workspace; answers how many drafts needed it. */
export async function healUnconfirmedIdentifiersIn(db: Kysely<HealDB>): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "barcode_text", "image_file_id", "suggested_name", "suggested_candidates", "suggested_metadata"])
    .where("status", "=", "pending")
    .where(sql<boolean>`suggested_candidates::text ~* ${IDENT_KEY_SQL}`)
    .execute();
  let n = 0;
  for (const r of rows) {
    const stamps = unconfirmedIdentifierStamps(r);
    if (!Object.keys(stamps).length) continue;
    // Merged into the live stamps: only the identifiers' standing moves.
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_metadata: sql`jsonb_set(coalesce(suggested_metadata, '{}'::jsonb), ${`{${FIELD_PROVENANCE_KEY}}`}::text[], coalesce(suggested_metadata->${FIELD_PROVENANCE_KEY}, '{}'::jsonb) || ${JSON.stringify(stamps)}::jsonb)` as never,
      })
      .where("id", "=", r.id)
      .where("status", "=", "pending")
      .execute();
    n++;
  }
  return n;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger, never a walk of its own at boot. */
export function registerUnconfirmedIdentifiersHeal(): void {
  registerHealPass({
    name: "core-scan.heal-unconfirmed-identifiers",
    shim: "modules/core-scan/src/heal-unconfirmed-identifiers.ts",
    module: "core-scan",
    visit: async ({ orgId, db }) => {
      const n = await healUnconfirmedIdentifiersIn(db as Kysely<HealDB>);
      if (n > 0) console.log(`[core-scan] org ${orgId}: marked unsupported identifiers unconfirmed on ${n} draft(s)`);
      return n;
    },
  });
}
