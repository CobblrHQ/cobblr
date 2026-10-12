// One-shot heal: a pending row whose barcode is a shop's own code and whose
// name came from a global catalog is re-judged from its photo (#6100).
//
// DONE WHEN: no tenant DB has a pending core_scan_inbox_items row whose
// barcode_text is a shop's own code (isStoreCode, the contract's
// store-codes.ts) and whose suggested_metadata->>'source' is a catalog's (not
// 'photo' or 'workspace'). Check with, per tenant:
//   select barcode_text, suggested_name, suggested_metadata->>'source'
//     from core_scan_inbox_items
//    where status = 'pending' and suggested_name is not null
//      and barcode_text ~ '^(2\d{7}|0\d{7}|\d{12,14})$'
//      and coalesce(suggested_metadata->>'source', '') not in ('', 'photo', 'workspace');
// and judge each code with isStoreCode. /healthz reports the count this pass
// found (noteHealShim). When it reads 0 on prod, staging and dev, delete this
// file and its boot call. Nothing re-creates the shape: the classifier sends a
// shop's own code to no catalog now.
//
// WHY IT EXISTS: an EAN-8 shop label (20446079 on a jar of ground cumin) was
// looked up globally, because the rule then knew only 12 to 14 digit codes,
// and a re-run renamed the cumin a J. Jill wool skirt. Rows named that way
// before the rule knew EAN-8 still carry the other shop's product.
//
// What it does to a row: keeps its before-state (Revert puts it back), then
// re-runs its enrichment, which for a shop's own code reads the photo, or this
// workspace's own filing of the code, or asks to be named. A name a person
// gave is never replaced (it is kept apart from the column, user-name.ts).

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { isStoreCode } from "@cobblr/platform-contract/store-codes";
import { personNameOf } from "@cobblr/platform-contract/display-identity";
import type { CoreScanDB } from "./db.js";
import { appendScanHistory, preRerunSnapshot } from "./services/scan-history.js";

/** Re-runs one row's enrichment. Injectable, so the heal is testable without
 *  a model. */
type Rejudge = (orgId: string, db: Kysely<CoreScanDB>, itemId: string, code: string) => Promise<unknown>;

const rejudgeByEnrich: Rejudge = async (orgId, db, itemId, code) => {
  const { enrichBarcodeItem } = await import("./services/enrich.js");
  return enrichBarcodeItem({ db, orgId, itemId, orgSlug: "", upc: code, force: true, userId: null });
};

/** The SQL prefilter for a shop's own code's length and lead digit: EAN-8
 *  starting 2 or 0, and any 12 to 14 digit code. isStoreCode judges each. */
export const STORE_CODE_SHAPE = "^(2[0-9]{7}|0[0-9]{7}|[0-9]{12,14})$";

/** Does this pending row carry another shop's product: a name a catalog gave
 *  to a shop's own code? A name the person gave, one read off the photo, or
 *  this workspace's own filing is never one. */
export function namedByCatalogForStoreCode(row: { status: string; barcode_text: string | null; suggested_name: string | null; suggested_metadata: unknown }): boolean {
  if (row.status !== "pending" || !row.suggested_name || !row.barcode_text) return false;
  const source = (row.suggested_metadata as { source?: unknown } | null)?.source;
  if (typeof source !== "string" || !source || source === "photo" || source === "workspace") return false;
  // A person renamed it: their name is kept apart from the column and shown
  // over it (user-name.ts), so there is nothing here to put right.
  if (personNameOf(row.suggested_metadata)) return false;
  return isStoreCode(row.barcode_text);
}

/** Heal one workspace. Answers how many rows it found. */
export async function healStoreCodeNamesIn(orgId: string, db: Kysely<CoreScanDB>, rejudge: Rejudge = rejudgeByEnrich): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .selectAll()
    .where("status", "=", "pending")
    .where("suggested_name", "is not", null)
    .where(sql<boolean>`barcode_text ~ ${STORE_CODE_SHAPE}`)
    .where(sql<boolean>`coalesce(suggested_metadata->>'source', '') not in ('', 'photo', 'workspace')`)
    .limit(50)
    .execute();
  const found = rows.filter(namedByCatalogForStoreCode);
  for (const r of found) {
    try {
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ pre_rerun: preRerunSnapshot(r, "store-code") })}::jsonb` as never })
        .where("id", "=", r.id)
        .execute();
      await rejudge(orgId, db, r.id, r.barcode_text!);
      await appendScanHistory(db, r.id, { action: "store-code", note: r.suggested_name ? `was "${r.suggested_name}"` : null });
    } catch (err) {
      platform().health.notePassFailure("core-scan.heal-store-code-names", orgId, err);
      console.error(`[core-scan] org ${orgId} row ${r.id}: could not re-judge its shop's-own-barcode name:`, (err as Error).message);
    }
  }
  if (found.length > 0) console.log(`[core-scan] org ${orgId}: re-judged ${found.length} shop's-own-barcode row(s) a global catalog had named`);
  return found.length;
}

/** Call from onBoot. A registered pass (heal-pass.ts). */
export function registerStoreCodeNameHeal(): void {
  registerHealPass({
    name: "core-scan.heal-store-code-names",
    shim: "modules/core-scan/src/heal-store-code-names.ts",
    module: "core-scan",
    visit: ({ orgId, db }) => healStoreCodeNamesIn(orgId, db as Kysely<CoreScanDB>),
  });
}
