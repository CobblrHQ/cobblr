// An order's own page at its store: kept sealed, attached to its order, read
// on its schedule, and each read turned into the order's parcels (#5461).
//
// The link is a sign-in credential. It is sealed with the workspace's key on
// the way in, opened only inside readDue for the one request chain that needs
// it, and never logged, returned, put in an activity line or sent to a model.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { orderPageLinkInText } from "@cobblr/platform-contract/order-page-link";
import type { PurchasesDB } from "../db.js";
import { matchShippedLines, recordShipment } from "../shipments.js";
import { readShopifyOrderPage, type FetchHop, type PageParcel, type PageRead } from "./shopify.js";
import { afterRead, firstReadAt, StoreBudget, type PageState } from "./schedule.js";

export const ORDER_PAGE_PASS = "purchases.order-page-reads";

/** The instance switch. Off keeps every link but reads none: a hosted
 *  instance reads every user's stores from one address, and a store that bans
 *  it bans everyone on it. Parsed strictly at boot (api/src/env.ts). */
export function orderPageReadsOn(): boolean {
  return process.env.COBBLR_ORDER_PAGE_READS === "true";
}

const budget = new StoreBudget();

function plainNumber(n: string | null | undefined): string | null {
  const t = (n ?? "").trim().replace(/^#\s*/, "");
  return t || null;
}

async function findOrder(db: Kysely<PurchasesDB>, orderNumber: string): Promise<string | null> {
  const row = await db
    .selectFrom("purchases_orders")
    .select("id")
    .where(sql<boolean>`regexp_replace(coalesce(order_number, ''), '^#\\s*', '') = ${orderNumber}`)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row?.id ?? null;
}

/** Keep a store's order page link for an order, sealed. The order may not
 *  exist yet; the row then waits on its number. Answers only what a caller may
 *  repeat: whether it is attached, and the store's host. */
export async function captureOrderPage(
  db: Kysely<PurchasesDB>,
  orgId: string,
  userId: string | null,
  input: { link: string; host: string; orderNumber: string | null; orderId?: string | null },
  now = new Date(),
): Promise<{ attached: boolean; store: string }> {
  const sealed = await platform().integrations.encryptCredentials(orgId, { link: input.link });
  const number = plainNumber(input.orderNumber);
  const orderId = input.orderId ?? (number ? await findOrder(db, number) : null);
  const next = firstReadAt(now, Math.random());
  if (orderId) {
    await db
      .insertInto("purchases_order_pages")
      .values({ order_id: orderId, order_number: number, store_host: input.host, link_sealed: sealed, state: "waiting", next_read_at: next, captured_by_user_id: userId })
      .onConflict((oc) =>
        oc.column("order_id").where("order_id", "is not", null).doUpdateSet({
          link_sealed: sealed,
          store_host: input.host,
          state: "waiting",
          next_read_at: next,
          refusals: 0,
          updated_at: now,
        }),
      )
      .execute();
    return { attached: true, store: input.host };
  }
  if (!number) return { attached: false, store: input.host };
  await db
    .insertInto("purchases_order_pages")
    .values({ order_id: null, order_number: number, store_host: input.host, link_sealed: sealed, state: "waiting", next_read_at: next, captured_by_user_id: userId })
    .onConflict((oc) =>
      oc.columns(["store_host", "order_number"]).where("order_id", "is", null).doUpdateSet({ link_sealed: sealed, next_read_at: next, updated_at: now }),
    )
    .execute();
  return { attached: false, store: input.host };
}

/** Attach waiting links to the orders their numbers name, once those exist. */
export async function attachWaiting(db: Kysely<PurchasesDB>): Promise<number> {
  const waiting = await db
    .selectFrom("purchases_order_pages")
    .select(["id", "order_number"])
    .where("order_id", "is", null)
    .limit(50)
    .execute();
  let attached = 0;
  for (const w of waiting) {
    if (!w.order_number) continue;
    const orderId = await findOrder(db, w.order_number);
    if (!orderId) continue;
    const taken = await db.selectFrom("purchases_order_pages").select("id").where("order_id", "=", orderId).executeTakeFirst();
    if (taken) {
      await db.deleteFrom("purchases_order_pages").where("id", "=", w.id).execute();
      continue;
    }
    await db.updateTable("purchases_order_pages").set({ order_id: orderId, updated_at: new Date() }).where("id", "=", w.id).execute();
    attached++;
  }
  return attached;
}

export interface Applied {
  parcels: number;
  allTracked: boolean;
  allDelivered: boolean;
  shippedLines: number;
}

/** Which order lines each parcel carries, matched in one pass so that
 *  "Multicolor" and "Multicolor-1" each find their own line: every parcel
 *  line is matched alone against the lines still free. Pure. */
export function matchParcelLines(parcels: readonly PageParcel[], open: ReadonlyArray<{ id: string; description: string | null }>): Map<number, string[]> {
  const matched = new Map<number, string[]>();
  const free = [...open];
  for (const [parcel, p] of parcels.entries()) {
    for (const line of p.lines) {
      const [id] = matchShippedLines([{ description: line.name, qty: line.qty }], free);
      if (!id) continue;
      free.splice(free.findIndex((l) => l.id === id), 1);
      matched.set(parcel, [...(matched.get(parcel) ?? []), id]);
    }
  }
  return matched;
}

/** Turn one read into the order's parcels: every parcel's lines are matched to
 *  the order's lines in one pass (so "Multicolor" and "Multicolor-1" each find
 *  their own), then each parcel is recorded with its lines named. */
export async function applyRead(db: Kysely<PurchasesDB>, orgId: string, userId: string | null, orderId: string, read: PageRead): Promise<Applied> {
  const lines = await db
    .selectFrom("purchases_order_items")
    .select(["id", "description", "received_at"])
    .where("order_id", "=", orderId)
    .orderBy("created_at")
    .execute();
  const open = lines.filter((l) => !l.received_at);
  const matched = matchParcelLines(read.parcels, open);
  let recorded = 0;
  const tracked = new Set<string>();
  const delivered = new Set<string>();
  for (const [i, parcel] of read.parcels.entries()) {
    const ids = matched.get(i) ?? [];
    if (!parcel.trackingNumber || !ids.length) continue;
    const out = await recordShipment(db, orgId, userId, orderId, {
      tracking_number: parcel.trackingNumber,
      line_ids: ids,
      shipment_state: parcel.state,
      expected_arrival: parcel.expectedArrival,
      description: parcel.company,
    });
    if (!out) continue;
    if (out.created) {
      await platform().activity.log({
        orgId,
        userId,
        action: "order_shipment_added",
        ref: { module: "purchases", entityType: "order", entityId: orderId },
        diff: { tracking_number: out.tracking_number, lines: out.lines.map((l) => l.description), whole_order: out.mode === "order", from: "store order page" },
      });
    }
    await platform().events.emit("purchases.order.shipment_recorded", { orgId, orderId, shipmentId: out.shipment_id, tracking_number: out.tracking_number });
    recorded++;
    for (const id of ids) {
      tracked.add(id);
      if (parcel.state === "delivered") delivered.add(id);
    }
  }
  const shippedLines = [...matched.values()].reduce((n, ids) => n + ids.length, 0);
  return {
    parcels: recorded,
    allTracked: open.length > 0 && open.every((l) => tracked.has(l.id)),
    allDelivered: lines.length > 0 && lines.every((l) => l.received_at || delivered.has(l.id)),
    shippedLines,
  };
}

export interface ReadDeps {
  /** One request without following redirects. The default is the tenant's
   *  guarded egress, re-validated per hop. */
  fetchHop?: (orgId: string) => FetchHop;
  random?: () => number;
  enabled?: () => boolean;
  budget?: StoreBudget;
}

const guardedHop = (orgId: string): FetchHop => (url, init) =>
  platform().egress.guardedFetch(orgId, url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20_000) });

/** Read every page that is due in this workspace. */
export async function readDue(orgId: string, db: Kysely<PurchasesDB>, now: Date, deps: ReadDeps = {}): Promise<{ read: number; skipped: number; failed: number }> {
  await attachWaiting(db);
  if (!(deps.enabled ?? orderPageReadsOn)()) return { read: 0, skipped: 0, failed: 0 };
  const due = await db
    .selectFrom("purchases_order_pages")
    .selectAll()
    .where("order_id", "is not", null)
    .where("next_read_at", "<=", now)
    .orderBy("next_read_at")
    .limit(10)
    .execute();
  const random = deps.random ?? Math.random;
  const spend = deps.budget ?? budget;
  let read = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of due) {
    if (!spend.take(row.store_host, now)) {
      await db.updateTable("purchases_order_pages").set({ next_read_at: new Date(now.getTime() + 60 * 60 * 1000 * (1 + random())) }).where("id", "=", row.id).execute();
      skipped++;
      continue;
    }
    try {
      const { link } = (await platform().integrations.decryptCredentials(orgId, row.link_sealed)) as { link?: string };
      const page = link ? await readShopifyOrderPage(link, (deps.fetchHop ?? guardedHop)(orgId)) : { outcome: "failed" as const, parcels: [] };
      const applied = page.outcome === "read" || page.outcome === "redacted"
        ? await applyRead(db, orgId, row.captured_by_user_id, row.order_id!, page)
        : null;
      const after = afterRead(page.outcome, { allTracked: applied?.allTracked ?? false, allDelivered: applied?.allDelivered ?? false, refusals: row.refusals, capturedAt: row.captured_at }, now, random());
      await db
        .updateTable("purchases_order_pages")
        .set({
          state: after.state satisfies PageState,
          next_read_at: after.nextReadAt,
          refusals: after.refusals,
          last_read_at: now,
          last_outcome: page.outcome,
          ...(applied ? { shipped_lines: applied.shippedLines } : {}),
          updated_at: now,
        })
        .where("id", "=", row.id)
        .execute();
      read++;
    } catch (err) {
      failed++;
      // The message never carries the link: only the order and the class.
      console.error(`[purchases] order page read failed for order ${row.order_id}: ${(err as Error).name}`);
      platform().health.notePassFailure(ORDER_PAGE_PASS, orgId, new Error(`order ${row.order_id}: ${(err as Error).name}`));
      await db.updateTable("purchases_order_pages").set({ next_read_at: new Date(now.getTime() + 6 * 60 * 60 * 1000), last_outcome: "failed", updated_at: now }).where("id", "=", row.id).execute();
    }
  }
  return { read, skipped, failed };
}

/** What an order's page says about itself, with no link in it. */
export async function orderPageSummary(db: Kysely<PurchasesDB>, orderId: string): Promise<{ store: string; state: string; last_read_at: Date | null; shipped_lines: number | null; reads_on: boolean } | null> {
  const row = await db
    .selectFrom("purchases_order_pages")
    .select(["store_host", "state", "last_read_at", "shipped_lines"])
    .where("order_id", "=", orderId)
    .executeTakeFirst();
  if (!row) return null;
  return { store: row.store_host, state: row.state, last_read_at: row.last_read_at, shipped_lines: row.shipped_lines, reads_on: orderPageReadsOn() };
}

/** A receipt text file filed before #5461 held a store's sign-in link
 *  (core-files announces it by id before scrubbing it): read the file, and
 *  keep the link sealed on the order its number names, so that older order
 *  follows its store page too. Never logs the link. */
export async function captureFromTextFile(orgId: string, fileId: string): Promise<boolean> {
  const file = await platform().files.read(orgId, fileId, "original");
  if (!file) return false;
  const text = new TextDecoder().decode(file.bytes);
  const link = orderPageLinkInText(text);
  if (!link) return false;
  const orderNumber = /\border\s*(?:#|no\.?|number)?\s*#?\s*([A-Z0-9][A-Z0-9-]{2,})\b/i.exec(text)?.[1] ?? /#\s?(\d{3,})\b/.exec(text)?.[1] ?? null;
  const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
  await captureOrderPage(db, orgId, null, { link: link.url, host: link.host, orderNumber });
  return true;
}

export function registerOrderPageReads(): void {
  platform().events.on("core-files.file.sign_in_found", "purchases", async (payload: unknown) => {
    const p = payload as { orgId?: string; fileId?: string };
    if (!p.orgId || !p.fileId) return;
    try {
      // A workspace without Purchases has nowhere to keep it: the file is
      // scrubbed all the same.
      const db = (await platform().tenants.getDb(p.orgId)) as Kysely<PurchasesDB>;
      const has = await sql<{ t: string | null }>`select to_regclass('purchases_order_pages')::text as t`.execute(db);
      if (!has.rows[0]?.t) return;
      await captureFromTextFile(p.orgId, p.fileId);
    } catch (err) {
      platform().health.notePassFailure(ORDER_PAGE_PASS, p.orgId, new Error(`file ${p.fileId}: ${(err as Error).name}`));
    }
  });
  platform().sweeps.register({
    name: ORDER_PAGE_PASS,
    everyMs: 30 * 60 * 1000,
    module: "purchases",
    visit: async ({ orgId, db, now }) => readDue(orgId, db as Kysely<PurchasesDB>, now),
  });
}
