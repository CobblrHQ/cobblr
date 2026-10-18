// One-shot heal: an emailed receipt's lines that were read before a Shopify
// order named its store from its body get their store now, and their store
// pass runs: a known pack splits into its spools with their own pictures.
//
// DONE WHEN: no tenant DB has a pending core_scan_inbox_items row from an
// emailed batch with no suggested_metadata->>'store_host' whose batch's email
// names a store (storeHostOfEmail). Check with, per tenant:
//   select count(*) from core_scan_inbox_items i join core_scan_batches b on b.id = i.scan_batch_id
//    where i.status = 'pending' and i.source_kind = 'receipt' and b.origin = 'email'
//      and coalesce(i.suggested_metadata->>'store_host', '') = ''
//      and i.suggested_metadata->'store_product' is null and i.suggested_metadata->'split_from' is null;
// and no pending part a store split made that was never asked about your own
// records (split_from set, store_product read, no tracked_match and no
// own_match_checked of 2, the exact-title rule).
// A row whose email names no store stays in that count for ever, so read the
// count from /healthz (noteHealShim) after a boot: 0 rows healed on prod,
// staging and dev means delete this file and its boot call. Nothing re-creates
// the shape: every read now asks storeHostOfEmail (services/store-product.ts).
//
// WHY IT EXISTS: the owner forwarded Kingroon's order and its two ten-spool
// packs stayed one row each, the white line kept a promo banner and
// Multicolor-1 wore Multicolor's picture (#6004): a Shopify notice comes
// from t.shopifyemail.com, so its lines were stored with no store and the
// store pass skipped them.
//
// A line the store read but did not split (the white spool) has its
// picture picked again, so the store's variant photo replaces a search's.
//
// The matcher needs a person's session, so the parts a split makes take their
// pack line's table (the same product, one table) and are matched when filed,
// like any row.
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { CoreScanDB } from "./db.js";
import { mergeMeta } from "./services/metadata.js";
import { storeHostForReceipt } from "./services/store-product.js";
import { storeProductPass } from "./services/pack-parts.js";
import { intakeRow, OWN_MATCH_CHECKED, stampOwnRecordMatch, type InsertValues } from "./services/intake.js";
import { refreshCatalogImageByName } from "./services/enrich-photo.js";
import { partCandidates } from "./services/row-parts.js";

/** Heal one workspace. Cheap on the happy path: one indexed read. */
export async function healForwardedStoreHostIn(
  orgId: string,
  db: Kysely<CoreScanDB>,
  since: Date,
  refreshPicture?: (orgId: string, itemId: string, name: string) => Promise<unknown>,
  matchOwn?: (db: Kysely<CoreScanDB>, orgId: string, id: string) => Promise<unknown>,
): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items as i")
    .innerJoin("core_scan_batches as b", "b.id", "i.scan_batch_id")
    .select(["i.id", "i.scan_batch_id", "i.created_by_user_id", "i.suggested_name", "i.suggested_candidates", "i.suggested_metadata", "b.source_file_id", "b.origin_from"])
    .where("i.created_at", "<", since)
    .where("i.status", "=", "pending")
    .where("i.source_kind", "=", "receipt")
    .where("b.origin", "=", "email")
    .where(sql<boolean>`coalesce(i.suggested_metadata->>'store_host', '') = ''`)
    .where(sql<boolean>`i.suggested_metadata->'store_product' is null`)
    .where(sql<boolean>`i.suggested_metadata->'split_from' is null`)
    .limit(200)
    .execute();
  const hostOf = new Map<string, string | null>();
  let healed = 0;
  for (const r of rows) {
    try {
      const batch = r.scan_batch_id as string;
      if (!hostOf.has(batch)) hostOf.set(batch, await storeHostForReceipt(orgId, r.source_file_id ?? null, r.origin_from ?? null));
      const host = hostOf.get(batch);
      if (!host) continue;
      await db.updateTable("core_scan_inbox_items").set({ suggested_metadata: mergeMeta({ store_host: host }) as never }).where("id", "=", r.id).execute();
      const outcome = await storeProductPass({
        db,
        ...(refreshPicture ? { refreshPicture } : {}),
        orgId,
        itemId: r.id,
        userId: r.created_by_user_id ?? null,
        admit: async (values) => {
          const part = (await intakeRow({ db, orgId, orgSlug: "", userId: r.created_by_user_id ?? null, token: null, baseUrl: "", door: "receipt", values: values as InsertValues })).row as { id: string };
          // The line's table, as a part carries it: never the pack's mixed
          // colour or its count (#6456).
          if (r.suggested_candidates) {
            const partMeta = JSON.parse(String((values as { suggested_metadata?: unknown }).suggested_metadata ?? "{}")) as Record<string, unknown>;
            const carried = partCandidates(r.suggested_candidates, (r.suggested_metadata ?? {}) as Record<string, unknown>, { n: Number((values as { quantity?: unknown }).quantity ?? 1), meta: partMeta });
            await db.updateTable("core_scan_inbox_items").set({ suggested_candidates: JSON.stringify(carried) as never }).where("id", "=", part.id).execute();
          }
          return part;
        },
      });
      // A line the store's page named (not a pack it split) shows its own
      // variant's photo in place of the search's: the white line's promo
      // banner (#6004). The store's photo outranks a search, so the
      // picture's one door picks it.
      if (outcome === "read") await (refreshPicture ?? refreshCatalogImageByName)(orgId, r.id, r.suggested_name ?? "");
      healed++;
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-forwarded-store-host", orgId, err);
      console.error(`[core-scan] org ${orgId} row ${r.id}: could not read its store:`, (err as Error).message);
    }
  }
  // The parts an earlier round made were never asked about your own records
  // (a split with no session ran no match): each is asked once now, so the
  // white spool from a pack says "You already have" (#6004).
  const parts = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id"])
    .where("status", "=", "pending")
    .where("source_kind", "=", "receipt")
    .where(sql<boolean>`suggested_metadata->'split_from' is not null`)
    // A part of a line made before the fix (an earlier round of this heal
    // makes such parts now); a split made since was asked by the fixed code.
    .where(sql<boolean>`exists (select 1 from core_scan_inbox_items l where l.id::text = core_scan_inbox_items.suggested_metadata->>'split_from' and l.created_at < ${since})`)
    .where(sql<boolean>`suggested_metadata->'store_product'->>'status' = 'read'`)
    // Never asked, or asked under the looser rule (own_match_checked true),
    // which stamped one shared word as a match: asked again, and a stamp it
    // wrote is taken back. A stamp a person's session wrote is left alone.
    .where(sql<boolean>`coalesce(suggested_metadata->>'own_match_checked', '') <> ${String(OWN_MATCH_CHECKED)}`)
    .where(sql<boolean>`(suggested_metadata->'tracked_match' is null or suggested_metadata->'own_match_checked' is not null)`)
    .limit(200)
    .execute();
  for (const p of parts) {
    try {
      await (matchOwn ?? stampOwnRecordMatch)(db, orgId, p.id);
      healed++;
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-forwarded-store-host", orgId, err);
      console.error(`[core-scan] org ${orgId} row ${p.id}: could not match its own records:`, (err as Error).message);
    }
  }
  return healed;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger. */
export function registerForwardedStoreHostHeal(): void {
  registerHealPass({
    name: "core-scan.heal-forwarded-store-host",
    since: "2026-10-12T19:15:48Z",
    shim: "modules/core-scan/src/heal-forwarded-store-host.ts",
    module: "core-scan",
    visit: ({ orgId, db, since }) => healForwardedStoreHostIn(orgId, db as Kysely<CoreScanDB>, since),
  });
}
