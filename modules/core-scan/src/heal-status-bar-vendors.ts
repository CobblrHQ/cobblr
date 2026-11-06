// One-shot heal: a screenshot's status bar kept as the shop (#9272).
//
// DONE WHEN: /healthz reads 0 for this shim on prod, canary, staging and app. It
// records the count itself through registerHealPass (noteHealShim). Nothing
// re-creates the shape: enrichReceiptMeta and detectVendor both refuse a phone's
// clock (isPhoneStatusBar). Delete this file and its boot call then.
//
// WHY IT EXISTS: a receipt read from a screenshot said "8:46 mm R |" was the shop,
// on the session, the row and what the row would file as Bought from. Pending rows
// and sessions go blank. A filed record is never changed, because its person may
// have edited it, and a purchase's vendor belongs to Purchases: both are left, and
// the filed rows are logged here so the number is known.
//
// BORN WITH: a fresh workspace has no rows, and every receipt it reads goes through
// isPhoneStatusBar.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { mergeMeta } from "./services/metadata.js";
import { isPhoneStatusBar, receiptSessionLabel } from "./services/receipt-shared.js";

interface HealDB {
  core_scan_inbox_items: { id: string; status: string; suggested_metadata: unknown; suggested_candidates: unknown; created_at: Date };
  core_scan_batches: { id: string; vendor: string | null; label: string | null; order_ref: string | null; created_at: Date };
}

const CLOCK_AT_START = "^[0-9]{1,2}:[0-9]{2}";

/** Candidates with the shop's false name blanked wherever a read copied it. */
function withoutVendor<T>(value: T, vendor: string): T {
  const walk = (v: unknown): unknown => {
    if (v === vendor) return "";
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export async function healStatusBarVendorsIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<number> {
  const batches = await db.selectFrom("core_scan_batches").select(["id", "vendor", "order_ref"]).where("created_at", "<", since).where(sql<boolean>`vendor ~ ${CLOCK_AT_START}`).execute();
  let found = 0;
  for (const b of batches) {
    if (!isPhoneStatusBar(b.vendor ?? "")) continue;
    await db.updateTable("core_scan_batches").set({ vendor: null, label: receiptSessionLabel(null, b.order_ref) }).where("id", "=", b.id).execute();
    found++;
  }
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "status", "suggested_metadata", "suggested_candidates"])
    .where("created_at", "<", since)
    .where("status", "in", ["pending", "resolved"])
    .where(sql<boolean>`suggested_metadata->>'receipt_vendor' ~ ${CLOCK_AT_START}`)
    .execute();
  let filed = 0;
  for (const r of rows) {
    const meta = (r.suggested_metadata ?? {}) as { receipt_vendor?: string; field_provenance?: Record<string, unknown> };
    const vendor = meta.receipt_vendor ?? "";
    if (!isPhoneStatusBar(vendor)) continue;
    if (r.status === "resolved") {
      filed++;
      continue;
    }
    const provenance = { ...(meta.field_provenance ?? {}) };
    delete provenance.acquired_from;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_metadata: mergeMeta({ field_provenance: provenance }, ["receipt_vendor"]) as never,
        suggested_candidates: JSON.stringify(withoutVendor(r.suggested_candidates ?? [], vendor)) as never,
      })
      .where("id", "=", r.id)
      .where("status", "=", "pending")
      .execute();
    found++;
  }
  if (found > 0 || filed > 0) console.log(`[core-scan] org ${orgId}: ${found} session(s) and row(s) no longer name a status bar as the shop; ${filed} filed row(s) left as they are`);
  return found;
}

/** Call from onBoot. */
export function registerStatusBarVendorsHeal(): void {
  registerHealPass({
    name: "core-scan.heal-status-bar-vendors",
    since: "2026-11-07T00:00:00Z",
    shim: "modules/core-scan/src/heal-status-bar-vendors.ts",
    module: "core-scan",
    visit: ({ orgId, db, since }) => healStatusBarVendorsIn(orgId, db as Kysely<HealDB>, since),
  });
}
