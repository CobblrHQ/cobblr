// The inbox's counts and queues: the scanner queue, stats, the re-route and split-series audits and heals, source conflicts, pending receipt groups.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { SCAN_TRIAGE_COLUMNS } from "@cobblr/platform-contract/scan-triage";
import { tenantContext, tenantDb } from "../../db.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { scannerQueue } from "../../services/scanner-queue.js";
import { inboxCounts, type CountRow } from "../../services/inbox-counts.js";
import { auditSplitSeries, healSplitSeriesWorkspace } from "../../services/split-series-heal.js";
import { auditReroute, rerouteWorkspace } from "../../services/reroute-keyword-rows.js";
import { fieldProvenanceOf, scanSourceConflict, type SourceConflict } from "@cobblr/platform-contract/acquisition-source";
import { TRIAGE_SCAN_CAP, asTheCardReadsIt, destinationTablesFor, liveTablesFor, scanViewerFor } from "./shared.js";

export const queueRouter = Router({ mergeParams: true });

// ─────────────────────── GET /inbox/scanner-queue ───────────────────
// The dashboard's scanner queue over EVERY pending scan, grouped by where it
// could go (services/scanner-queue.ts): the counts a person reads and the ids
// each group's "Add all" files, from one answer. It used to be grouped in the
// browser from the first page of the inbox, so 78 pending read as 50 (#3598).
// Light columns only: no photos, no notes.
queueRouter.get(
  "/inbox/scanner-queue",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const rows = await tenantDb(req)
      .selectFrom("core_scan_inbox_items")
      .select(["id", "source_kind", ...SCAN_TRIAGE_COLUMNS])
      .where("status", "=", "pending")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    const canInstall = roleSatisfies((req as unknown as { tenant?: { role: string } }).tenant?.role as "owner", ["owner", "admin"]);
    res.json(scannerQueue(rows, await destinationTablesFor(req), await liveTablesFor(req), { canInstall }));
  }),
);

// ─────────────────────────── GET /inbox/stats ──────────────────────
// Cheap counts for the put-away front door (dashboard card + scan-page
// strip): how many pending captures exist, how many of those still have no
// home (no target location/container), and how many are ready to put away.
// The first two are one SQL, no rows. Ready is the contract's `ready` facet
// (a home AND nothing flagged for review), the same predicate the inbox's
// triage filter and the assistant's list read, so the dashboard cannot count
// a row the header shows under the warning (#2980); it reads the light
// triage columns of the rows with a home and never their photos or notes.

queueRouter.get(
  "/inbox/stats",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const db = tenantDb(req);
    // Every count over EVERY pending row, by the predicates the rows use
    // (services/inbox-counts.ts): the dashboard's front door and the inbox's
    // own header and filters read these, never the length of a loaded page
    // (#3598, #3638). `batch_id` scopes it to one session, as the inbox can be.
    const batchId = typeof req.query.batch_id === "string" && /^[0-9a-f-]{36}$/i.test(req.query.batch_id) ? req.query.batch_id : null;
    let q = db
      .selectFrom("core_scan_inbox_items")
      .select([...SCAN_TRIAGE_COLUMNS, "id", "scan_batch_id", "target_location_id", "target_container_id"])
      .where("status", "=", "pending");
    if (batchId) q = q.where("scan_batch_id", "=", batchId);
    const rows = await q.execute();
    // Receipt sessions whose read failed have no rows of their own, so the
    // row counts cannot see them; one receipt is one failed read, whether its
    // session or its row says so.
    let fq = db.selectFrom("core_scan_batches").select("id").where("read_state", "=", "failed");
    if (batchId) fq = fq.where("id", "=", batchId);
    const failedIds = new Set((await fq.execute()).map((b) => b.id));
    res.json(inboxCounts((rows as CountRow[]).map((r) => asTheCardReadsIt(r)), failedIds, await scanViewerFor(req)));
  }),
);

// ─────────────────── GET /inbox/reroute-audit ──────────────────────
// How many pending rows the keyword tier routed before its rule changed
// would move under the rule now, and to where (reroute-keyword-rows.ts,
// #3019): the read-only count before the heal, which is the POST below
// and the background cadence. Writes nothing.

// AI-REACH: exempt — an operator's read-only count before a heal; the assistant reads rows through list_scan_inbox
queueRouter.get(
  "/inbox/reroute-audit",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json(await auditReroute(tenantContext(req).org.id));
  }),
);

// AI-REACH: exempt — an operator's explicit heal of routes stored before the rule; the old list is kept under reroute_prior
// UI-REACH: an operator's one-off heal of rows stored before a rule, run by hand
queueRouter.post(
  "/inbox/reroute",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    res.json(await rerouteWorkspace(tenantContext(req).org.id, 1000));
  }),
);

// ─────────────────── GET /inbox/split-series-audit ─────────────────
// How many pending split children of this workspace carry the group
// photo's series without naming it (split-series-heal.ts, #3013): the
// read-only count before the heal, which is the separate POST below and
// the background cadence. Writes nothing.

// AI-REACH: exempt — an operator's read-only count before a heal; the assistant reads rows through list_scan_inbox
queueRouter.get(
  "/inbox/split-series-audit",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json(await auditSplitSeries(tenantContext(req).org.id));
  }),
);

// AI-REACH: exempt — an operator's explicit heal of rows the split wrote before the rule; non-destructive, the value moves to split_dropped
// UI-REACH: an operator's one-off heal of rows stored before a rule, run by hand
queueRouter.post(
  "/inbox/split-series-heal",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const done = await healSplitSeriesWorkspace(tenantContext(req).org.id, 1000);
    res.json(done);
  }),
);

// ─────────────────── GET /inbox/source-conflicts ───────────────────
// How many rows of this workspace say they were acquired somewhere their
// purchase evidence contradicts, and which (acquisition-source.ts, #3008).
// READ-ONLY, deliberately: the count is the step before any remediation,
// which is a separate decision, never a side effect of asking. Judged by
// the same derived check the served row carries, over the rows of one
// status (pending unless asked), capped like the triage facets and honest
// about the cap.

const SourceConflictsQuery = z.object({
  status: z.enum(["pending", "resolved", "discarded"]).default("pending"),
});

// AI-REACH: a read-only count for the operator before a remediation; the assistant sees each row's own conflict on list_scan_inbox (source_conflict rides on every served row)
queueRouter.get(
  "/inbox/source-conflicts",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const q = SourceConflictsQuery.safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id", ...SCAN_TRIAGE_COLUMNS])
      .where("status", "=", q.data.status)
      .orderBy("created_at", "desc")
      .limit(TRIAGE_SCAN_CAP + 1)
      .execute();
    const capped = rows.length > TRIAGE_SCAN_CAP;
    const scanned = capped ? rows.slice(0, TRIAGE_SCAN_CAP) : rows;
    const items = scanned
      .map((r) => ({ row: r, conflict: scanSourceConflict(r) }))
      .filter((x): x is { row: (typeof scanned)[number]; conflict: SourceConflict } => x.conflict !== null)
      .map(({ row, conflict }) => ({
        id: row.id,
        suggested_name: row.suggested_name,
        ...conflict,
        provenance: fieldProvenanceOf(row.suggested_metadata)[conflict.field] ?? null,
      }));
    res.json({
      status: q.data.status,
      scanned: scanned.length,
      ...(capped ? { capped_at: TRIAGE_SCAN_CAP } : {}),
      count: items.length,
      items,
    });
  }),
);

// ──────────────── GET /inbox/receipt-groups/pending ─────────────────
// Receipt sessions still awaiting confirmation into a purchase order — powers
// the "N receipts pending" banner on the Purchases page, so a receipt that was
// imported but not yet confirmed is visible from Purchases, not only from Scan
// (reported 2026-07-26). One grouped SQL; no per-item rows.
queueRouter.get(
  "/inbox/receipt-groups/pending",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const db = tenantDb(req);
    // The order/invoice number lives on the BATCH (it is editable there via
    // "+ PO#"), not in the item's metadata snapshot — so join it in. Without it
    // three receipts from one vendor read "KC Tool (16) · KC Tool (7) · KC Tool
    // (1)": a count is not an identity (reported 2026-08-03). The batch's vendor is
    // likewise the authoritative one; the item's `receipt_vendor` is the
    // import-time snapshot and only answers for rows with no batch.
    const rows = await db
      .selectFrom("core_scan_inbox_items as i")
      .leftJoin("core_scan_batches as b", "b.id", "i.scan_batch_id")
      .select((eb) => [
        sql<string>`i.suggested_metadata->>'receipt_group_id'`.as("group_id"),
        sql<string | null>`max(coalesce(b.vendor, i.suggested_metadata->>'receipt_vendor'))`.as("vendor"),
        sql<string | null>`max(b.order_ref)`.as("order_ref"),
        sql<string | null>`max(b.tracking_number)`.as("tracking_number"),
        sql<string | null>`max(b.shipment_state)`.as("shipment_state"),
        sql<string | null>`max(b.shipment_description)`.as("shipment_description"),
        sql<string | null>`max(b.shipment_location)`.as("shipment_location"),
        // So a caller can link to THIS receipt rather than to the inbox.
        sql<string | null>`max(b.id::text)`.as("batch_id"),
        // What is IN it, for a receipt with a single line. "eBay #08-15026" is
        // findable; "Brake Rotors & Pads Kit" is what you were waiting for. Only
        // when there is exactly one, because naming the first of sixteen picks
        // an arbitrary item and calls it the parcel.
        sql<string | null>`
          case when count(i.id) filter (where i.status in ('pending','enriching')) = 1
               then max(i.suggested_name) filter (where i.status in ('pending','enriching'))
          end
        `.as("only_item_name"),
        eb.fn.countAll<number>().as("count"),
      ])
      .where("i.source_kind", "=", "receipt")
      // Pending items OR a parcel still in the air. Filing the lines
      // individually used to drop a tracked receipt off every surface at once
      // — the group vanished, no order was created, and the tracking number
      // went with it. A parcel you are still waiting for outlives the
      // bookkeeping for its contents.
      .where((eb) =>
        eb.or([
          eb("i.status", "in", ["pending", "enriching"]),
          eb.and([
            sql<boolean>`nullif(btrim(coalesce(b.tracking_number, '')), '') is not null`,
            sql<boolean>`coalesce(b.shipment_state, '') <> 'delivered'`,
          ]),
        ]),
      )
      .where(sql<boolean>`i.suggested_metadata->>'receipt_group_id' is not null`)
      .groupBy(sql`i.suggested_metadata->>'receipt_group_id'`)
      .execute();
    const groups = rows.map((r) => ({
      groupId: String(r.group_id),
      vendor: r.vendor,
      orderRef: r.order_ref,
      trackingNumber: r.tracking_number,
      // Where it is right now, so the inbox row can say so without anyone
      // having to file the receipt first.
      shipmentState: r.shipment_state,
      shipmentDescription: r.shipment_description,
      shipmentLocation: r.shipment_location,
      batchId: r.batch_id,
      onlyItemName: r.only_item_name,
      count: Number(r.count),
    }));
    res.json({ groups, total_items: groups.reduce((s, g) => s + g.count, 0) });
  }),
);
