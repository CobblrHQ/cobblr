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
// have edited it: it is left, counted here, and offered to its person as a tidy
// suggestion while it still shows the status bar.
//
// BORN WITH: a fresh workspace has no rows, and every receipt it reads goes through
// isPhoneStatusBar.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { countOf, platform, type TidyCandidate } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { mergeMeta } from "./services/metadata.js";
import { isPhoneStatusBar, receiptSessionLabel } from "./services/receipt-shared.js";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    suggested_metadata: unknown;
    suggested_candidates: unknown;
    target_module: string | null;
    target_kind: string | null;
    target_entity_id: string | null;
    created_at: Date;
  };
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

export interface FiledStatusBar { kind: string; id: string; name: string; url?: string }

/** Whether a field of the record itself shows the status bar. `receipt` is the
 *  scan's own note of what the receipt said, which a person's edit leaves alone,
 *  so it can't say whether the record still shows it. Pure. */
export function recordShows(fields: Record<string, unknown> | undefined, bar: string): boolean {
  const { metadata, ...own } = fields ?? {};
  const { receipt: _note, ...kept } = (metadata ?? {}) as Record<string, unknown>;
  return [...Object.values(own), ...Object.values(kept)].some((v) => v === bar);
}

/** Filed records that still show the status bar as where they came from. One a
 *  person has changed has nothing to say about it. */
export async function filedRecordsShowingAStatusBar(orgId: string, db: Kysely<HealDB>): Promise<FiledStatusBar[]> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["suggested_metadata", "target_module", "target_kind", "target_entity_id"])
    .where("status", "=", "resolved")
    .where("target_entity_id", "is not", null)
    .where(sql<boolean>`suggested_metadata->>'receipt_vendor' ~ ${CLOCK_AT_START}`)
    .execute();
  const out: FiledStatusBar[] = [];
  for (const r of rows) {
    const bar = (r.suggested_metadata as { receipt_vendor?: string } | null)?.receipt_vendor ?? "";
    if (!isPhoneStatusBar(bar) || !r.target_kind || !r.target_entity_id) continue;
    const kind = r.target_kind.includes(":") ? r.target_kind : `${r.target_module}:${r.target_kind}`;
    const record = await platform().entities.lookup(orgId, kind, r.target_entity_id).catch(() => null);
    if (!record || !recordShows(record.fields, bar)) continue;
    out.push({ kind, id: r.target_entity_id, name: record.title, ...(record.detailUrl ? { url: record.detailUrl } : {}) });
  }
  return out;
}

/** What a person is offered, while a filed record still shows a status bar. */
export function statusBarVendorCandidate(filed: FiledStatusBar[]): TidyCandidate[] {
  if (!filed.length) return [];
  const one = filed.length === 1;
  return [
    {
      id: "status-bar-vendors",
      kind: "status-bar-vendor",
      records: filed,
      why: one ? "A phone's clock was read as the shop this came from. Check where it says it was bought." : `A phone's clock was read as the shop these ${countOf(filed.length, "record")} came from. Check where they say they were bought.`,
      priority: 40,
      action: { route: filed[0]!.url ?? "/scan" },
    },
  ];
}

/** Heal one workspace. `found` counts what it cleared and the filed records it
 *  may not change. It settles once nothing is left to clear, and those records
 *  stay in the shim's count. */
export async function healStatusBarVendorsIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<{ found: number; settled: boolean }> {
  const batches = await db.selectFrom("core_scan_batches").select(["id", "vendor", "order_ref"]).where("created_at", "<", since).where(sql<boolean>`vendor ~ ${CLOCK_AT_START}`).execute();
  let found = 0;
  for (const b of batches) {
    if (!isPhoneStatusBar(b.vendor ?? "")) continue;
    await db.updateTable("core_scan_batches").set({ vendor: null, label: receiptSessionLabel(null, b.order_ref) }).where("id", "=", b.id).execute();
    found++;
  }
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_metadata", "suggested_candidates"])
    .where("created_at", "<", since)
    .where("status", "=", "pending")
    .where(sql<boolean>`suggested_metadata->>'receipt_vendor' ~ ${CLOCK_AT_START}`)
    .execute();
  for (const r of rows) {
    const meta = (r.suggested_metadata ?? {}) as { receipt_vendor?: string; field_provenance?: Record<string, unknown> };
    const vendor = meta.receipt_vendor ?? "";
    if (!isPhoneStatusBar(vendor)) continue;
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
  const filed = await filedRecordsShowingAStatusBar(orgId, db);
  if (found > 0 || filed.length > 0) console.log(`[core-scan] org ${orgId}: ${found} session(s) and row(s) no longer name a status bar as the shop; ${filed.length} filed record(s) flagged and left as they are`);
  return { found: found + filed.length, settled: found === 0 };
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
