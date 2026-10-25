// Receipts: a photographed or forwarded receipt, its re-parse, order reference and tracking.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { trackingNumberFromText } from "@cobblr/platform-contract/tracking-text";
import { randomUUID } from "node:crypto";
import { lineQuantity, sameOrder } from "../../services/receipt-shared.js";
import { priorSessionOfOrder } from "../../services/receipt-prior-session.js";
import { sql } from "kysely";
import { z } from "zod";
import { lineUnitCost } from "../../services/receipt-order.js";
import { recordReceiptPurchase, relinkReceiptPurchase, type PendingPurchase } from "../../services/receipt-purchase.js";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { noteScanCaptured } from "../../services/activation.js";
import { intakeRow } from "../../services/intake.js";
import { enqueueDocumentRead } from "../../services/document-read-worker.js";
import { parseReceipt } from "../../services/receipt.js";
import { lineDiscounted, lineNet, shareOrderDiscount, type ReceiptResult } from "../../services/receipt-shared.js";
import { isLineImageRef, lineImagesFor, type EmailLineImage } from "@cobblr/platform-contract/email-line-images";
import { storeHostForReceipt } from "../../services/store-product.js";
import { withoutStoreCopySuffix } from "@cobblr/platform-contract/split-line";
import { readOrderPacks } from "@cobblr/platform-contract/receipt-pack";
import { orderPageForReceipt, readWithOrderPage } from "../../services/receipt-order-page.js";
import type { OrderPageSummary } from "@cobblr/platform-contract/order-page-link";
import { readFailureFrom, readFailureHistory, readHistoryAfterSuccess } from "../../services/receipt-read-state.js";
import { cleanOrderRef, receiptDedupKey, receiptContentKey, receiptSessionLabel, vendorFromLabel, type ParsedReceipt, type ParseMethod, type ReceiptSource } from "../../services/receipt-shared.js";
import { doubtedChecks, priceDoubted, sellerDoubted } from "../../services/receipt-facts.js";
import { apiFetch } from "@cobblr/platform-contract/self-api";
import { optionalField, optionalUuid } from "@cobblr/platform-contract/optional-fields";
import { INTERNAL_API } from "./shared.js";

export const receiptsRouter = Router({ mergeParams: true });

/** A name the page read badly does not name the thing (#4633). */
function nameDoubtedIn(checks: { fields?: string[] }): boolean {
  const f = checks.fields ?? [];
  return f.includes("name") || f.includes("make") || f.includes("model");
}

/** What the page read for each doubted value, for "Please check" to show
 *  beside an empty field: never written into one (#4633). */
function checkValuesOf(receipt: { vendor?: string | null; seller?: string | null; total?: number | null }, line: { manufacturer?: string | null; model?: string | null; line_total?: number | null; description?: string }, checks: { fields?: string[] }): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const f = new Set(checks.fields ?? []);
  const seller = receipt.vendor ?? receipt.seller;
  // VOCAB-ENUMERATION OK: the check words a document's checks name (scan-triage CHECK_FIELD_WORDS), not field roles
  if (f.has("seller") && seller) out.seller = seller;
  if (f.has("price") && line.line_total != null) out.price = line.line_total;
  if (f.has("total") && receipt.total != null) out.total = receipt.total;
  if (nameDoubtedIn(checks)) {
    if (line.manufacturer) out.make = line.manufacturer;
    if (line.model) out.model = line.model;
  }
  return out;
}

// ─────────────────────────── POST /scan/receipt ────────────────────
// Upload-a-receipt intake: a receipt PDF (or a photo of one) is parsed by
// core-ai into vendor + date + line items, then EACH line becomes its own
// scan-inbox row (source_kind "receipt") sharing a receipt_group_id. From there
// every line rides the same matchmaker + confirm flow a barcode/photo scan
// does — a receipt becomes N parts without retyping. The file is uploaded
// separately via core-files (like image_file_id), keeping this body small.

/** Insert one inbox row per receipt line (source_kind "receipt", shared
 *  receipt_group_id, attached to the receipt's own batch) and kick off matching —
 *  the shared body of /scan/receipt and its /reparse. Returns the created rows. */
async function materializeReceiptLines(opts: {
  db: ReturnType<typeof tenantDb>;
  orgId: string;
  orgSlug: string;
  userId: string;
  batchId: string | null;
  receipt: ParsedReceipt;
  method: ParseMethod;
  /** What was read: a scanned PDF's lines say they came from its page image. */
  source?: ReceiptSource;
  token: string | null;
  baseUrl: string;
  /** The receipt_group_id to stamp. Supplied by the parse route so the order it
   *  creates can carry the same key; generated here when a caller does not care
   *  (reparse), which keeps this the only place that has to know. */
  groupId?: string;
  /** The photo the order email printed beside each line, with its row's
   *  words (#5350): each line takes the one its words name, and that photo
   *  is its picture before any search. */
  lineImages?: readonly EmailLineImage[] | null;
  /** The receipt came by email: what it states reads "from the order
   *  email" on the card. */
  emailed?: boolean;
  /** The store's own web host (a forward's original sender, #5719): each
   *  line is read on its page by the store-product pass. */
  storeHost?: string | null;
}): Promise<{ rows: Array<{ id: string }>; lineRows: Array<string | null> }> {
  const groupId = opts.groupId ?? randomUUID();
  // Read together, so siblings agree: one product's lines that differ only
  // by variant are packs of the same shape (receipt-pack.ts, #5350).
  const descriptions = opts.receipt.items.map((l) => (l.kind ? "" : l.description));
  const packs = readOrderPacks(descriptions);
  const photos = lineImagesFor(descriptions, opts.lineImages ?? []);
  const t = opts.receipt.totals;
  const baseMeta = {
    source: "receipt",
    receipt_group_id: groupId,
    receipt_vendor: opts.receipt.vendor,
    receipt_date: opts.receipt.date,
    ...(opts.receipt.renewal ? { receipt_renewal: opts.receipt.renewal } : {}),
    receipt_currency: opts.receipt.currency,
    parse_method: opts.method,
    ...(opts.source ? { receipt_source: opts.source } : {}),
    ...(opts.emailed ? { receipt_origin: "email" } : {}),
    ...(opts.storeHost ? { store_host: opts.storeHost } : {}),
    // Provenance: what this purchase WAS, beyond the line's own description.
    // Kept as components rather than one "price", because a receipt carries
    // several numbers that all look like the price and picking one is how the
    // wrong one gets recorded. See docs/design-decisions/arrivals.md.
    ...(opts.receipt.seller ? { receipt_seller: opts.receipt.seller } : {}),
    ...(opts.receipt.expected_arrival
      ? { expected_arrival: opts.receipt.expected_arrival }
      : {}),
    ...(t
      ? {
          list_price: t.subtotal,
          discounts: t.discounts,
          tax: t.tax,
          shipping: t.shipping,
          total_charged: t.totalCharged,
          // Null unless the components reconciled. A price we cannot corroborate
          // is not offered: someone typing it is cheaper than a wrong number
          // nobody notices.
          net_price: t.netPrice,
          price_reconciled: t.reconciled,
        }
      : {}),
    // How many lines this receipt carries, so the fact extractor can tell
    // "the order's net price IS this item's price" (one line) from "it is the
    // whole basket" (many). See receipt-facts.ts.
    receipt_line_count: opts.receipt.items.length,
    // A bill of sale says so, so its card can.
    ...(opts.receipt.document ? { receipt_document: opts.receipt.document } : {}),
  };
  const rows: Array<{ id: string }> = [];
  // rows[i] of the purchase is lines[i]: a line with no inbox row keeps its
  // place as null.
  const lineRows: Array<string | null> = [];
  // What the document checks put in doubt rides the thing the document is
  // about (its first item line), so its card says what to check (#4571).
  const unitAt = opts.receipt.items.findIndex((l) => !l.kind);
  const checks = opts.receipt.checks;
  for (const [lineAt, line] of opts.receipt.items.entries()) {
    // A charge (a fee, a tax, delivery) or a bill of sale's add-on is a line
    // on the purchase, never a thing to triage: no inbox row, no photo search
    // (charge-lines.ts). An add-on is promoted from the purchase if wanted.
    if (line.kind) {
      lineRows.push(null);
      continue;
    }
    // The one intake (services/intake.ts, #3049): a receipt line's plan is
    // the match, then the picture searched with the category the match
    // settled on. No picture at insert: a bare noun plus the shop's name
    // answers with the shop's packaged catalogue, a tin of cherry tomatoes
    // for fresh Roma tomatoes (2026-09-06).
    const admitted = await intakeRow({
      db: opts.db,
      orgId: opts.orgId,
      orgSlug: opts.orgSlug,
      userId: opts.userId,
      token: opts.token,
      baseUrl: opts.baseUrl,
      door: "receipt",
      values: {
        source_kind: "receipt",
        scan_batch_id: opts.batchId,
        // Named without a store's copy number ("Multicolor-1", #6527); the
        // line as written stays its description, which finds the variant.
        suggested_name: withoutStoreCopySuffix(line.description).slice(0, 300),
        // The product number the till printed beside the description. Stamped as
        // the row's barcode so the line resolves the way a scanned one does — a
        // catalog name and a real picture — instead of living forever as the
        // till's abbreviation. Marked AI-read below, since it was OCR'd off
        // paper and deserves the lower trust that carries.
        ...(line.code ? { barcode_text: line.code } : line.decoded ? { barcode_text: line.decoded.code } : {}),
        // A make the page's checks doubted is not the row's make: it is kept
        // under check_values for the card to show, never filled (#4633).
        ...(line.manufacturer && !(lineAt === unitAt && checks && nameDoubtedIn(checks)) ? { suggested_manufacturer: line.manufacturer } : {}),
        // A line sold BY WEIGHT is one thing, not four: "4.14 lb @ 1.99/lb"
        // was rounded into a quantity of 4 chicken breasts (2026-09-06).
        // A settled pack is that many things: "10KG" of filament in a bundle
        // is ten 1 kg spools. An unsettled one stays one line and asks.
        quantity: packs[lineAt] && !packs[lineAt]!.ask ? lineQuantity(line) * packs[lineAt]!.count : lineQuantity(line),
        suggested_metadata: JSON.stringify({
          ...baseMeta,
          description: line.description,
          // Its place among the order's things, as the receipt printed them:
          // "Part of …, line 1?" names it by this (#5734).
          receipt_line: rows.length + 1,
          ...(packs[lineAt] ? { line_pack: packs[lineAt] } : {}),
          ...(photos[lineAt] ? { order_line_image: photos[lineAt] } : {}),
          unit_price: line.unit_price,
          line_total: line.line_total,
          ...(line.weight !== null && line.weight !== undefined
            ? { weight: line.weight, weight_unit: line.weight_unit }
            : {}),
          // Marked as READ rather than scanned, so nothing treats it as a
          // hardware scan.
          // "receipt", not "ai-photo": this came off the receipt DOCUMENT,
          // which is usually an email or a PDF. Same low trust (see
          // isMachineReadCode), a sentence that is actually true - the card
          // said "read from photo" over an emailed eBay receipt (2026-08-31).
          ...(line.code ? { barcode_source: "receipt" } : {}),
          // `model` is the key resolveNativeIdentity reads, so a model printed
          // on the receipt reaches the destination's own model column with
          // nothing further to wire - the same route a decoded VIN's model
          // takes. Before this it was read past entirely.
          ...(line.model && !(lineAt === unitAt && checks && nameDoubtedIn(checks)) ? { model: line.model } : {}),
          ...(line.discount ? { line_discount: line.discount } : {}),
          // Its share of a code taken off the whole order (shareOrderDiscount).
          ...(line.order_discount ? { order_discount_share: line.order_discount } : {}),
          ...(lineDiscounted(line) ? { line_net: lineNet(line) } : {}),
          // What the document says about this thing, by field role (a VIN as
          // `identifier`, the odometer as `usage`); receipt-facts.ts lands
          // them on the record's own fields when it is filed.
          ...(line.facts ? { line_facts: line.facts } : {}),
          // A VIN the document printed, with what it said about the vehicle,
          // in the decode shape applyDecoderFill reads; serial_number is the
          // native column resolveNativeIdentity fills.
          ...(line.decoded
            ? {
                decoded: { decoder_id: line.decoded.decoder_id, fields: line.decoded.fields },
                serial_number: line.decoded.code,
                barcode_source: "receipt",
              }
            : {}),
          ...(checks && lineAt === unitAt ? { check_fields: checks, check_values: checkValuesOf(opts.receipt, line, checks) } : {}),
        }) as never,
        created_by_user_id: opts.userId,
      },
    });
    rows.push({ id: admitted.row.id });
    lineRows.push(admitted.row.id);
    // The document model was busy: it reads the page when one is free.
    if (checks?.waiting_for_ai && lineAt === unitAt) {
      await enqueueDocumentRead({ orgId: opts.orgId, itemId: admitted.row.id, limit: checks.waiting_reason === "limit" }).catch((e: Error) => console.error("[core-scan] document read not queued:", e.message));
    }
  }
  return { rows, lineRows };
}

/** The purchase a read receipt makes (order-at-parse.md): its order, its
 *  lines NET of the coupon printed under each, and each inbox row's claim on
 *  its line. One shape for the first read and for a re-read that succeeds
 *  after a failed one, which used to make no order at all. A seller or a
 *  price the page's checks did not believe is not put on the purchase:
 *  claiming the line fills the record from the order, and "sells/leases this
 *  vehicle 'as is'" became Bought from that way (#4633). */
function receiptPurchasePlan(
  receipt: ParsedReceipt,
  o: {
    orderRef: string | null;
    awaiting: { tracking_number: string | null; shipment_state: string | null; shipment_checked_at: Date | null; shipment_next_poll_at: Date | null; shipment_location: string | null; expected_arrival: string | null } | null;
    groupId: string;
    ships: boolean;
    sourceFileId: string | null;
    rowIds: Array<string | null>;
    targetItemId: string | null;
  },
): PendingPurchase {
  const doubts = doubtedChecks({ check_fields: receipt.checks });
  const priceOk = !priceDoubted(doubts);
  const { awaiting } = o;
  return {
    vendor: sellerDoubted(doubts) ? null : receipt.vendor,
    orderRef: o.orderRef,
    orderedAt: receipt.date,
    currency: receipt.currency,
    // Nobody has typed one yet, unless a shipping notice got here first and
    // left the session awaiting, in which case its parcel (number, state,
    // promised day) carries into the order it now makes.
    trackingNumber: awaiting?.tracking_number ?? null,
    knownShipment: awaiting?.shipment_state
      ? {
          state: awaiting.shipment_state,
          checkedAt: awaiting.shipment_checked_at ?? null,
          nextPollAt: awaiting.shipment_next_poll_at ?? null,
          location: awaiting.shipment_location ?? null,
        }
      : null,
    expectedArrival: receipt.expected_arrival ?? awaiting?.expected_arrival ?? null,
    total: priceOk ? receipt.total : null,
    groupId: o.groupId,
    ships: o.ships || (receipt.totals?.shipping ?? 0) > 0,
    sourceFileId: o.sourceFileId,
    // NET of the coupon printed under each line: the order records what was
    // paid, not the shelf price. Without this a receipt's lines sum to more
    // than its own total and the order silently disagrees with its paper.
    lines: receipt.items.map((line) => ({
      description: line.description,
      qty: line.qty,
      unitCost: priceOk ? lineUnitCost(lineDiscounted(line) ? null : line.unit_price, lineNet(line), line.qty) : null,
      lineAmount: priceOk ? lineNet(line) : null,
      ...(line.kind ? { kind: line.kind } : {}),
    })),
    rowIds: o.rowIds,
    targetItemId: o.targetItemId,
  };
}

const OrderPageSummaryBody = z.object({
  store: z.string().max(253),
  order_name: z.string().max(120).nullable(),
  outcome: z.string().max(40),
  lines: z.array(z.object({ name: z.string().max(500), qty: z.number().positive(), unit_price: z.number().nullable(), currency: z.string().max(8).nullable() })).max(200),
  parcels: z
    .array(
      z.object({
        tracking_number: z.string().max(80).nullable(),
        carrier: z.string().max(120).nullable(),
        state: z.string().max(40),
        lines: z.array(z.object({ name: z.string().max(500), qty: z.number().positive() })).max(200),
      }),
    )
    .max(50),
}) satisfies z.ZodType<OrderPageSummary>;

const ReceiptBody = z.object({
  file_id: z.string().uuid(),
  /** Where the receipt came from — "email" makes the inbox session read
   *  "Receipt · emailed <when>". Absent → an ordinary in-app upload. */
  origin: optionalField(z.enum(["email", "upload"])),
  /** The address an emailed receipt came from; kept on the session. */
  from: optionalField(z.string().trim().max(320)),
  /** The photo the email printed in each line's row, with that row's words
   *  (emailLineImages, #5350). Kept on the session so a re-read keeps them. */
  line_images: z
    // A link the email printed, or one of its own image parts, stored (`file:<id>`).
    .array(z.object({ text: z.string().max(500), url: z.string().max(2000).refine(isLineImageRef, "a link or a stored file:<id>") }))
    .max(30)
    .optional(),
  /** Skip the "you already imported this receipt" guard and import it anyway
   *  (the user chose to, or it's a re-forward of one they'd discarded). */
  force: z.boolean().optional(),
  /** THIS receipt belongs to an item that already exists.
   *
   *  The ordinary upload is an INTAKE: the receipt arrives first and its lines
   *  become the items. This is the other direction — the item is already here
   *  and you are attaching the paperwork, which is the case that had no home
   *  because there was nothing left to triage. So: the order and all its lines
   *  are recorded as usual, the item is linked to it, and NO inbox rows are
   *  created. Nothing needs triaging; it already was. */
  target_item_id: optionalUuid(),
  /** The caller will wait for the hosted identify's queue (barcode-
   *  intelligence #43): when every engine is busy and the workspace's own AI
   *  cannot read it either, answer 202 with the job instead of failing. Only
   *  the photographed-receipt route sends it; it owns a row to wait on. */
  queue_if_busy: z.boolean().optional(),
  /** A queued read that finished: its answer is collected, not asked again. */
  hosted_job_id: optionalUuid(),
  /** The email this came in was an order confirmation: an online order, on
   *  its way rather than in hand (the email ingest knows the subject). */
  order_confirmation: z.boolean().optional(),
  /** What the store's own order page said about this order (the email ingest
   *  read it through Purchases; never the link). With lines, the receipt is
   *  read with no model: the free tiers, filled from the page, or the page
   *  alone (services/receipt-order-page.ts). */
  order_page: OrderPageSummaryBody.optional(),
});

/** What a read receipt is filed with: the receipt route's body, the stored
 *  original optional. A personal document (a bill of sale, #5331) is read
 *  transiently and filed with no original kept: `file_id` null. */
type ReceiptFiling = Omit<z.infer<typeof ReceiptBody>, "file_id"> & {
  file_id: string | null;
  /** A personal document's original, kept in the Vault instead (#5331). */
  vault_file_id?: string | null;
};

/** File a read receipt: its session, one inbox row per line (none when it is
 *  put on an item that exists), and its purchase. Shared by the receipt route
 *  and the personal bill-of-sale route. */
export async function fileReceiptRead(
  req: Parameters<typeof tenantDb>[0] & { ip?: string; headers: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (body: unknown) => void } },
  data: ReceiptFiling,
  result: Extract<ReceiptResult, { ok: true }>,
): Promise<void> {
  const parsed = { data };
  const db = tenantDb(req);
  const ctx = tenantContext(req);
  const session = sessionUser(req);
  // A code taken off the whole order is shared across its lines, so each
  // line's cost is what it cost (shareOrderDiscount, #5350).
  const { method } = result;
  const receipt = shareOrderDiscount(result.receipt);
  noteScanCaptured(ctx.org.id, session.id, "receipt");
  const orderRef = cleanOrderRef(receipt.order_ref);

  // Already imported? A store's order number is unique per vendor, so the same
  // (vendor, order #) means this receipt is already here — re-forwarding it (a
  // NEW email) shouldn't silently duplicate every line. Only LIVE prior imports
  // count (a batch with at least one non-discarded item); a receipt you threw
  // away re-imports. `force` (user chose "import anyway") skips the guard.
  const dupKey = receiptDedupKey(receipt.vendor, orderRef);
  const contentKey = receiptContentKey(receipt);
  if (!parsed.data.force) {
    const prior = await priorSessionOfOrder(db as never, dupKey, contentKey, parsed.data.file_id);
    if (prior) {
      const live = await db
        .selectFrom("core_scan_inbox_items")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("scan_batch_id", "=", prior.id)
        .where("status", "!=", "discarded")
        .executeTakeFirst();
      res.status(200).json({
        duplicate: true,
        existing: {
          batch_id: prior.id,
          label: prior.label,
          vendor: prior.vendor,
          order_ref: prior.order_ref,
          item_count: Number(live?.n ?? 0),
        },
      });
      return;
    }
  }

  // A receipt is its OWN inbox session: one batch holds all its lines, so the
  // header reads "Receipt · <vendor>" (or "Receipt" when the vendor is unknown)
  // instead of a bare timestamp, and the lines can't time-cluster with unrelated
  // items. origin="email" makes the inbox add "emailed <when>". (Falls back to a
  // batch-less group only if the batch insert somehow fails.)
  const batchLabel = receiptSessionLabel(receipt.vendor, orderRef);
  // A shipping notice may have arrived BEFORE this receipt and left a
  // row-less session in read_state 'awaiting' for the same store + order
  // (api/shipment-event.ts). The receipt reads INTO that session — its
  // parcel state, tracking number and ownership carry over — rather than
  // opening a second session for one order. The duplicate guard above never
  // sees it: an awaiting session has no lines, and the guard keys on lines.
  // Matched on the order number, with the store as the tiebreak
  // (sameOrder): the notice said "Amazon", the receipt says "Amazon.com".
  const awaiting = dupKey
    ? sameOrder(
        await db
          .selectFrom("core_scan_batches")
          .select(["id", "vendor", "tracking_number", "shipment_state", "shipment_checked_at", "shipment_next_poll_at", "shipment_location", "expected_arrival"])
          .where("read_state", "=", "awaiting")
          .where("order_ref", "=", dupKey.orderRef)
          .orderBy("created_at", "desc")
          .limit(10)
          .execute(),
        receipt.vendor,
        dupKey.orderRef,
      )
    : undefined;
  const sessionFields = {
    label: batchLabel,
    origin: parsed.data.origin ?? null,
    // Only an email's own read says who sent it; a re-read keeps it.
    ...(parsed.data.origin === "email" && parsed.data.from ? { origin_from: parsed.data.from } : {}),
    // The email's line photos, so a re-read gives each line its own again.
    ...(parsed.data.line_images?.length ? { line_images: JSON.stringify(parsed.data.line_images) } : {}),
    // Remember the original so the session can offer "View original" + "Re-parse".
    source_file_id: parsed.data.file_id,
    // A personal document keeps no original: what code read is kept instead,
    // so "It's this one" can fill the car from it (#5331).
    ...(parsed.data.file_id ? {} : { read_receipt: JSON.stringify(receipt) }),
    ...(parsed.data.vault_file_id ? { vault_file_id: parsed.data.vault_file_id } : {}),
    // Vendor + order # as their own fields so the order # is editable later.
    vendor: receipt.vendor,
    order_ref: orderRef,
    content_key: contentKey,
    // "in_flight" until its lines exist, "read" after (#4890, torn status
    // writes): written "read" first, a poll between this and the lines saw
    // a read session with nothing in it, and the inbox dropped it.
    read_state: "in_flight",
    read_started_at: new Date(),
    // Which way round the numeric date was read, and by what (#2917).
    date_convention: result.date_reading?.convention ?? null,
    date_decided_by: result.date_reading?.decided_by ?? null,
    date_printed: result.date_reading?.printed ?? null,
  };
  const batch = awaiting
    ? await db
        .updateTable("core_scan_batches")
        .set(sessionFields as never)
        .where("id", "=", awaiting.id)
        .returning("id")
        .executeTakeFirst()
    : await db
        .insertInto("core_scan_batches")
        .values({ created_by_user_id: session.id, ...sessionFields } as never)
        .returning("id")
        .executeTakeFirst();
  const batchId = batch?.id ?? null;

  // One inbox row per line item (shared receipt_group_id, attached to the
  // batch), then matched against the menu — a receipt becomes N parts.
  const receiptBaseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
  const receiptGroupId = randomUUID();
  // Attaching paperwork to an item that already exists: the order is still
  // recorded in full, but nothing is put in the inbox, because nothing needs
  // triaging. See the target_item_id comment on the body above.
  const targetItemId = parsed.data.target_item_id ?? null;
  const markRead = () =>
    batchId // state-flips-last: defined here, run in the finally below, after the lines are made
      ? db.updateTable("core_scan_batches").set({ read_state: "read", read_at: new Date() } as never).where("id", "=", batchId).execute()
      : Promise.resolve();
  let made: Awaited<ReturnType<typeof materializeReceiptLines>> | { rows: never[]; lineRows: never[] };
  try {
    made = targetItemId
    ? { rows: [], lineRows: [] }
    : await materializeReceiptLines({
    db,
    orgId: ctx.org.id,
    orgSlug: ctx.org.slug,
    userId: session.id,
    batchId,
    receipt,
    method,
    source: result.source,
    token: bearer(req),
    baseUrl: receiptBaseUrl,
    groupId: receiptGroupId,
    lineImages: parsed.data.line_images ?? null,
    emailed: parsed.data.origin === "email",
    storeHost: parsed.data.origin === "email" ? await storeHostForReceipt(ctx.org.id, parsed.data.file_id, parsed.data.from ?? null) : null,
      });
  } finally {
    // Read once the lines are in (or the attempt to make them is over).
    await markRead();
  }
  const rows = made.rows;

  // THE ORDER IS BORN HERE, not at confirm. A receipt is a document and
  // documents live in Purchases, which was only true after somebody triaged
  // for as long as the order was created by receipt-group confirm: a receipt
  // nobody got to never reached Purchases at all, and one attached to an
  // already-triaged item had no moment at which its order could appear. See
  // docs/design-decisions/order-at-parse.md.
  //
  // Every line is recorded on the order with part_id NULL, because a line on a
  // receipt is not a thing you own — most of a grocery order is eaten. Confirm
  // is what claims one, by setting part_id.
  //
  // Best-effort throughout: a workspace without purchases still uploads,
  // triages and commits its receipts, it simply has no order.
  // When Purchases is off the order is not lost: the session keeps it and
  // offers to turn Purchases on (services/receipt-purchase.ts, #3869).
  let purchase: { recorded: boolean; purchases_off: boolean } | null = null;
  if (batchId) {
    const outcome = await recordReceiptPurchase(
      db,
      batchId,
      receiptPurchasePlan(receipt, {
        orderRef,
        awaiting: awaiting ?? null,
        groupId: receiptGroupId,
        // An online order is on its way, not in hand: the email said it was
        // an order confirmation, the store's own page read it, or the
        // receipt charged for shipping.
        ships: parsed.data.order_confirmation === true || method === "order-page" || method === "order-email",
        sourceFileId: parsed.data.file_id,
        rowIds: made.lineRows,
        targetItemId,
      }),
      { baseUrl: receiptBaseUrl, slug: ctx.org.slug, headers: { Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" } },
    );
    purchase = outcome.recorded ? { recorded: true, purchases_off: false } : { recorded: false, purchases_off: outcome.purchasesOff };
  }

  res.status(201).json({
    // The session the lines went into, so a caller can read the session's
    // own record (how its date was read, its state) without a list scan.
    batch_id: batchId,
    // Whether the receipt was kept as a purchase, and when not, whether
    // Purchases being off is why (the card offers to turn it on).
    purchase,
    receipt: {
      vendor: receipt.vendor,
      date: receipt.date,
      // Which way round a numeric date was read, and by what (#2917).
      date_convention: result.date_reading?.convention ?? null,
      date_decided_by: result.date_reading?.decided_by ?? null,
      date_printed: result.date_reading?.printed ?? null,
      currency: receipt.currency,
      total: receipt.total,
      item_count: rows.length,
      // Travels with the result so the importer can SAY the lines do not add
      // up. A parse that is 95% right is the dangerous kind: every field looks
      // reasonable and the purchase it records is quietly wrong.
      lines_total: receipt.lines_total,
      lines_reconcile: receipt.lines_reconcile,
      method,
    },
    items: rows,
  });
}

// AI-REACH: exempt — reads the bytes of a receipt photo the camera just took;
// the assistant holds no photo to send, and records a purchase through the
// order's own create
receiptsRouter.post(
  "/scan/receipt",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ReceiptBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);

    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const result = await readWithOrderPage(ctx.org.id, parsed.data.file_id, parsed.data.order_page ?? null, (more) =>
      parseReceipt(ctx.org.id, parsed.data.file_id, session?.id ?? null, req.ip ?? null, {
        ...(parsed.data.queue_if_busy ? { queueIfBusy: true } : {}),
        ...(parsed.data.hosted_job_id ? { hostedJobId: parsed.data.hosted_job_id } : {}),
        ...more,
      }),
    );
    // Accepted, not read: the hosted identify reads it when an engine is
    // back, and the caller (which asked to wait) collects it. No session yet:
    // there is nothing read to keep, and the caller's row holds the file.
    if (!result.ok && result.hosted_job) {
      res.status(202).json({ queued: { job_id: result.hosted_job }, message: result.reason });
      return;
    }
    if (!result.ok) {
      // NEVER-VANISH: keep the upload as a re-parseable session instead of
      // orphaning the file. The email path has done this since it shipped
      // ("capture the whole body as one note item"); the in-app path returned
      // a toast and left the file with nothing pointing at it - no retry, no
      // way to find it, no sign it happened (2026-08-25 audit). A batch with
      // the original attached gets the session header's own View original +
      // Read again controls, so "no AI provider yet" is a set-it-up-and-retry,
      // not a rescan.
      //
      // The failure is a STATE on the session (read_state failed, with the
      // router's coded reason and its history), never an inbox item. It used
      // to be a note row named "Receipt couldn't be read - …": the row then
      // spun as "1 finishing…", was left out of "to review", survived a
      // successful re-read as a third "item" the put-away planner offered a
      // destination, and carried its reason as prose (#2892, #2898).
      let keptBatchId: string | null = null;
      try {
        const failedBatch = await db
          .insertInto("core_scan_batches")
          .values({
            created_by_user_id: session.id,
            label: "Receipt · not read yet",
            origin: parsed.data.origin ?? null,
            origin_from: parsed.data.origin === "email" ? (parsed.data.from ?? null) : null,
            ...(parsed.data.line_images?.length ? { line_images: JSON.stringify(parsed.data.line_images) as never } : {}),
            source_file_id: parsed.data.file_id,
            read_state: "failed",
            read_failure: JSON.stringify(readFailureFrom(result, [])) as never,
          })
          .returning("id")
          .executeTakeFirst();
        if (failedBatch) keptBatchId = failedBatch.id;
      } catch (err) {
        console.warn("[core-scan] could not keep the failed receipt:", (err as Error).message);
      }
      // Still 422: the client's error toast stays honest. kept_batch_id says
      // where the original now lives.
      res
        .status(422)
        // `failure` says WHY in a form a caller can branch on. The prose in
        // `message` is for a person; matching on it is a string comparison
        // waiting to be reworded.
        .json({
          error: { code: "receipt_unparsed", message: result.reason, failure: result.code, ...(result.ai ? { ai: result.ai } : {}) },
          ...(keptBatchId ? { kept_batch_id: keptBatchId } : {}),
        });
      return;
    }
    await fileReceiptRead(req, res, parsed.data, result);
  }),
);

// ─────────────── POST /scan/receipt/reparse ───────────────
// Re-run the parser on a receipt session's STORED original and replace its still-
// PENDING lines with a fresh parse. Confirmed/discarded lines are left alone. For
// when the first parse read the receipt poorly (or AI was off then) — no re-upload
// needed, since the source is kept on the batch.
// AI-REACH: exempt (scan-inbox maintenance — a user re-runs the parser on a scan
//   session's stored source from the inbox UI; it mutates transient pending
//   scan-inbox rows, not a domain entity Cobb orchestrates)
const ReparseBody = z.object({ batch_id: z.string().uuid() });

receiptsRouter.post(
  "/scan/receipt/reparse",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ReparseBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    const batch = await db
      .selectFrom("core_scan_batches")
      .select(["id", "source_file_id", "read_failure", "origin", "origin_from", "order_ref", "purchases_order_id", "line_images"])
      .where("id", "=", parsed.data.batch_id)
      .executeTakeFirst();
    if (!batch?.source_file_id) {
      res.status(400).json({ error: { code: "no_source", message: "This receipt has no stored original to re-parse." } });
      return;
    }
    const priorHistory = readFailureHistory(batch.read_failure);

    // The read is in flight NOW, on the session's own clock: the row says
    // "reading…" from this stamp, never from the absence of lines.
    await db
      .updateTable("core_scan_batches")
      .set({ read_state: "in_flight", read_started_at: new Date() })
      .where("id", "=", batch.id)
      .execute();

    // An emailed receipt tries its store's order page first: the page Purchases
    // kept from the email names the order and its lines with no model, so a
    // read the AI failed on is filled from it (services/receipt-order-page.ts).
    const sourceFileId = batch.source_file_id;
    const page = batch.origin === "email"
      ? await orderPageForReceipt(ctx.org.id, sourceFileId, batch.order_ref ?? null, {
          baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
          slug: ctx.org.slug,
          token: bearer(req) ?? "",
        })
      : null;
    const result = await readWithOrderPage(ctx.org.id, sourceFileId, page, (more) => parseReceipt(ctx.org.id, sourceFileId, session?.id ?? null, req.ip ?? null, more));
    if (!result.ok) {
      // Failed again: the state says so, with this attempt on the history.
      await db
        .updateTable("core_scan_batches")
        .set({ read_state: "failed", read_failure: JSON.stringify(readFailureFrom(result, priorHistory)) as never })
        .where("id", "=", batch.id)
        .execute();
      res
        .status(422)
        // `failure` says WHY in a form a caller can branch on. The prose in
        // `message` is for a person; matching on it is a string comparison
        // waiting to be reworded.
        .json({ error: { code: "receipt_unparsed", message: result.reason, failure: result.code, ...(result.ai ? { ai: result.ai } : {}) } });
      return;
    }
    // A code taken off the whole order is shared across its lines, so each
    // line's cost is what it cost (shareOrderDiscount, #5350).
    const { method } = result;
    const receipt = shareOrderDiscount(result.receipt);

    // Drop only the still-pending lines of this batch (keep confirmed/discarded
    // history), refresh the session label from the new vendor, then re-insert.
    await db
      .deleteFrom("core_scan_inbox_items")
      .where("scan_batch_id", "=", batch.id)
      .where("source_kind", "=", "receipt")
      .where("status", "in", ["pending", "enriching"])
      .execute();
    // A pack split into its colours (pack-parts.ts) left its line resolved
    // behind the parts just cleared: it goes too, or a re-read would show
    // the old line as filed beside the new one.
    await db
      .deleteFrom("core_scan_inbox_items")
      .where("scan_batch_id", "=", batch.id)
      .where("source_kind", "=", "receipt")
      .where("status", "=", "resolved")
      .where(sql<boolean>`(suggested_metadata->>'pack_split')::boolean is true`)
      .where(sql<boolean>`not exists (select 1 from core_scan_inbox_items c where c.suggested_metadata->>'split_from' = core_scan_inbox_items.id::text and c.status = 'resolved')`)
      .execute();
    // A session from before the read state carried its failure as a note row;
    // a successful read retires it here too, so the boot reconcile is not the
    // only thing that does (#2898).
    await db
      .updateTable("core_scan_inbox_items")
      .set({ status: "discarded", updated_at: new Date() })
      .where("scan_batch_id", "=", batch.id)
      .where("status", "=", "pending")
      .where(sql<boolean>`suggested_metadata ? 'receipt_parse_failure'`)
      .execute();
    // The lines before "read" (#4890, torn status writes): the session stays
    // "in_flight" (set above) while they are made, so a poll never sees a read
    // session with no lines.
    let rows: Awaited<ReturnType<typeof materializeReceiptLines>>["rows"] = [];
    let lineRows: Array<string | null> = [];
    const groupId = randomUUID();
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    try {
      ({ rows, lineRows } = await materializeReceiptLines({
      db,
      orgId: ctx.org.id,
      orgSlug: ctx.org.slug,
      userId: session.id,
      batchId: batch.id,
      receipt,
      method,
      source: result.source,
      token: bearer(req),
      baseUrl,
      groupId,
      lineImages: Array.isArray(batch.line_images) ? (batch.line_images as EmailLineImage[]) : null,
      emailed: batch.origin === "email",
      storeHost: batch.origin === "email" ? await storeHostForReceipt(ctx.org.id, sourceFileId, batch.origin_from ?? null) : null,
      }));
    } finally {
      await db
        .updateTable("core_scan_batches")
        .set({
          label: receiptSessionLabel(receipt.vendor, receipt.order_ref),
          vendor: receipt.vendor,
          order_ref: receipt.order_ref,
          read_state: "read",
          read_at: new Date(),
          date_convention: result.date_reading?.convention ?? null,
          date_decided_by: result.date_reading?.decided_by ?? null,
          date_printed: result.date_reading?.printed ?? null,
          // The failures that were: kept as history on the session, no longer its state.
          read_failure: (() => { const h = readHistoryAfterSuccess(batch.read_failure); return h ? (JSON.stringify(h) as never) : null; })(),
        })
        .where("id", "=", batch.id)
        .execute();
    }

    // The order a first read would have made, when the first read failed and
    // made none: a receipt read again is in Purchases like any other.
    // A session that already has its order: the new rows claim its lines,
    // so filing them files the purchase (relinkReceiptPurchase).
    let purchase: { recorded: boolean; purchases_off: boolean; order_number?: string | null } | null = null;
    {
      const plan = receiptPurchasePlan(receipt, {
        orderRef: cleanOrderRef(receipt.order_ref),
        awaiting: null,
        groupId,
        ships: method === "order-page" || method === "order-email",
        sourceFileId,
        rowIds: lineRows,
        targetItemId: null,
      });
      const http = { baseUrl, slug: ctx.org.slug, headers: { Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" } };
      const outcome = batch.purchases_order_id
        ? await relinkReceiptPurchase(db, batch.id, batch.purchases_order_id, plan, http)
        : await recordReceiptPurchase(db, batch.id, plan, http);
      purchase = outcome.recorded
        ? { recorded: true, purchases_off: false, order_number: plan.orderRef }
        : { recorded: false, purchases_off: outcome.purchasesOff };
    }

    res.json({
      batch_id: batch.id,
      purchase,
      receipt: { vendor: receipt.vendor, date: receipt.date, date_convention: result.date_reading?.convention ?? null, date_decided_by: result.date_reading?.decided_by ?? null, date_printed: result.date_reading?.printed ?? null, currency: receipt.currency, total: receipt.total, item_count: rows.length, lines_total: receipt.lines_total, lines_reconcile: receipt.lines_reconcile, method },
      items: rows,
    });
  }),
);

// ─────────────── PATCH /scan/receipt/:batchId/order-ref ───────────────
// Set/clear the order (invoice) number on a receipt session, recomputing the
// header label ("Receipt · <vendor> #<ref>"). Lets the user add one the parser
// missed, or fix a wrong one. Vendor comes from the batch column (recovered from
// the label for pre-0015 sessions, then persisted).
// AI-REACH: exempt (scan-inbox metadata edit from the UI; renames a transient scan
//   session, not a domain entity Cobb orchestrates)
const OrderRefBody = z.object({ order_ref: z.string().max(60).nullable() });

receiptsRouter.patch(
  "/scan/receipt/:batchId/order-ref",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = OrderRefBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const batch = await db
      .selectFrom("core_scan_batches")
      .select(["id", "vendor", "label", "purchases_order_id"])
      .where("id", "=", req.params.batchId ?? "")
      .executeTakeFirst();
    if (!batch) {
      res.status(404).json({ error: { code: "not_found", message: "receipt session not found" } });
      return;
    }
    const ref = cleanOrderRef(parsed.data.order_ref);
    const vendor = batch.vendor ?? vendorFromLabel(batch.label);
    const label = receiptSessionLabel(vendor, ref);
    await db
      .updateTable("core_scan_batches")
      .set({ order_ref: ref, vendor, label })
      .where("id", "=", batch.id)
      .execute();
    // The order exists from the read, so the number goes to it as well, the
    // way the tracking number does below: a fixed number that stayed on the
    // session left the order's own Order # blank (#5351 walk).
    if (batch.purchases_order_id) {
      const ctx = tenantContext(req);
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      try {
        await apiFetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/purchases/orders/${batch.purchases_order_id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" },
          // jsonb-replace-ok: an HTTP request body, not a jsonb column.
          body: JSON.stringify({ order_number: ref }),
        });
      } catch (err) {
        console.warn("[core-scan] the order number did not reach the order:", (err as Error).message);
      }
    }
    res.json({ id: batch.id, label, order_ref: ref });
  }),
);

// The tracking number for the parcel this receipt describes.
//
// Deliberately here rather than only on the filed order: the inbox is where a
// person is LOOKING at the receipt, so it is where they have the number in hand.
// Making them file the receipt first, find the order, and edit it there is three
// screens to record one string they are already holding.
// A number, or the carrier's "Track your package" link pasted whole: the
// link is the number it points at (trackingNumberFromText).
const TrackingBody = z.object({ tracking_number: z.string().max(2000).nullable() });

// AI-REACH: exempt (scan-inbox metadata edit from the UI, same as the order-ref
// route above — it writes a transient staging row that exists only until the
// receipt is filed. The durable home for a tracking number is the ORDER's own
// tracking_number, which the assistant can already write through the purchases
// order CRUD, and that is the one worth reaching.)
receiptsRouter.patch(
  "/scan/receipt/:batchId/tracking",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = TrackingBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const batch = await db
      .selectFrom("core_scan_batches")
      .select(["id", "purchases_order_id"])
      .where("id", "=", req.params.batchId ?? "")
      .executeTakeFirst();
    if (!batch) {
      res.status(404).json({ error: { code: "not_found", message: "receipt session not found" } });
      return;
    }
    // Carriers print numbers with spaces for legibility; nobody types them
    // consistently. Strip whitespace so the same parcel is the same string.
    const tracking = trackingNumberFromText(parsed.data.tracking_number);
    if (parsed.data.tracking_number?.trim() && !tracking) {
      res.status(422).json({ error: { code: "no_tracking_number", message: "That link has no tracking number in it. Paste the number itself." } });
      return;
    }
    await db
      .updateTable("core_scan_batches")
      // Whoever types the number owns the parcel: its arrival interrupts THEM,
      // not the whole workspace (parcelAudience in the platform contract).
      // Clearing the number clears the claim with it.
      .set({
        tracking_number: tracking,
        tracking_added_by_user_id: tracking ? sessionUser(req).id : null,
        // A different number is a different parcel: the previous parcel's
        // state, cadence and told-the-user marker must not survive onto it.
        // Keeping them meant the row showed the OLD parcel's "Delivered" and,
        // because shipment_notified_state still said delivered, the new
        // parcel's delivery was never announced (2026-08-25 audit).
        shipment_state: null,
        shipment_description: null,
        shipment_location: null,
        shipment_checked_at: null,
        shipment_next_poll_at: null,
        shipment_notified_state: null,
      })
      .where("id", "=", batch.id)
      .execute();
    // The order already exists by the time a person types the number (created
    // at parse), so the ATTACH path never calls createReceiptOrder again -
    // without this hop the number stayed on the batch, the parcel vanished
    // from the dashboard the moment its lines were filed, and the order's
    // shipment panel stayed empty (2026-08-25 audit).
    if (batch.purchases_order_id) {
      const ctx = tenantContext(req);
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      try {
        await apiFetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/purchases/orders/${batch.purchases_order_id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" },
          // jsonb-replace-ok: an HTTP request body, not a jsonb column - the
          // orders route merges what it stores.
          body: JSON.stringify({
            tracking_number: tracking,
            // Un-arrive the order when a number arrives: a parcel with a live
            // tracking number is not in your hands, and 'arrived' is the one
            // status the arrival sweep never looks at again.
            ...(tracking ? { status: "in-transit", arrived_at: null } : {}),
          }),
        });
      } catch (err) {
        console.warn("[core-scan] tracking did not reach the order:", (err as Error).message);
      }
    }
    res.json({ id: batch.id, tracking_number: tracking });
  }),
);
