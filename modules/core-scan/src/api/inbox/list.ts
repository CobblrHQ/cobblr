// Reading and editing the inbox: the list, the session theme, one item, and filing the selected ones.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { TEXT_OR_NULL, objectWith } from "@cobblr/platform-contract/ai-output-schemas";
import { regroupPack } from "../../services/pack-groups.js";
import { applyUserCategory, applyUserFieldPatch, candidateKind } from "../../services/user-fields.js";
import { FiledQuantity } from "../../services/filed-quantity.js";
import { type Request, type Response } from "express";
import { sql } from "kysely";
import { readSnapshot } from "@cobblr/platform-contract/torn-reads";
import { z } from "zod";
import { pendingPurchaseOf } from "../../services/receipt-purchase.js";
import { platform, countOf } from "@cobblr/platform-contract";
import { decodeKeysetCursor, encodeKeysetCursor } from "@cobblr/platform-contract/keyset-cursor";
import { matchesScanFacet, SCAN_TRIAGE_FACETS, type ScanTriageFacet, type ScanTriageRow, DESTINATION_KEY, KEEP_SEPARATE_KEY, SCANNED_TOO_KEY, scanKeepSeparateStamp, type StoredDestination, scanRebuy, scanTrackedMatch } from "@cobblr/platform-contract/scan-triage";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { withResolvedOffers } from "../../services/resolve-offers.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { refreshCatalogImageByName } from "../../services/enrich-photo.js";
import { rechoosePictureForColour, withholdContradictedPicture } from "../../services/withhold-picture.js";
import { themeFromReply, themeScope, type ThemeItem } from "../../services/session-theme.js";
import { restampTrackedMatch } from "../../services/tracked-stamp.js";
import { appendScanHistory, type ScanEditPart } from "../../services/scan-history.js";
import { filingDestination } from "../../services/destination.js";
import { splitParentsOf } from "../../services/split-groups.js";
import { reportBarcodeCorrection, unitLotsOf } from "../../services/barcode-corrections.js";
import { FIELD_PROVENANCE_KEY, fieldProvenanceOf, type FieldProvenanceMap } from "@cobblr/platform-contract/acquisition-source";
import { applyPersonName, applyRejectName, withPersonName } from "../../services/user-name.js";
import { headedFor, rowMatchesText } from "../../services/inbox-search.js";
import { displayName } from "@cobblr/platform-contract/display-identity";
import { apiFetch } from "@cobblr/platform-contract/self-api";
import { optionalField, optionalText } from "@cobblr/platform-contract/optional-fields";
import { catalogCandidatesFor } from "../../services/catalog-match.js";
import { INTERNAL_API, TRIAGE_SCAN_CAP, asTheCardReadsIt, containerKindsFor, destinationTablesFor, liveTablesFor, matchItem, scanViewerFor, served, storedCandidateList, titleFormatFor, topCandidateCategory, withDestination, withGroupImages, withHeld, withTitle } from "./shared.js";

export const listRouter = Router({ mergeParams: true });

// ─────────────────────────── GET /inbox ────────────────────────────

const ListQuery = z.object({
  status: z.enum(["pending", "enriching", "resolved", "discarded"]).optional(),
  source_kind: z.enum(["barcode", "photo", "url", "receipt"]).optional(),
  batch_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque keyset cursor: page backwards through created_at-desc, no cap. */
  cursor: z.string().optional(),
  /** One of the queue's facets — the same ones the Scan page's header filters
   *  by (needs_review / waiting / unfiled / ready), so a caller that is not the
   *  page (the assistant, a script) can ask for "the ones that need me" without
   *  paging the whole queue and re-deriving it. Implies pending. */
  triage: z.enum(SCAN_TRIAGE_FACETS as [ScanTriageFacet, ...ScanTriageFacet[]]).optional(),
  /** Waiting rows whose name (as the card shows it), code or maker contains
   *  this. Search's door into the inbox: a thing scanned but not yet filed
   *  is in no table, so searching the tables could not find it (#3823). */
  q: z.string().trim().min(1).max(200).optional(),
  /** With `q`: only rows headed for this table (an instance's name, or a
   *  module's for its default table), by the row's one resolved destination.
   *  A collection's own search shows what is waiting to come to it. */
  destination: z.string().trim().min(1).max(120).optional(),
});

interface BatchLabel {
  /** The purchase this session's order was filed on, so its header can open it. */
  purchases_order_id: string | null;
  label: string | null;
  origin: string | null;
  /** Who an emailed receipt came from, and the shop the read found: the
   *  session names its document by them ("Email from eBay, Aug 12"). */
  origin_from: string | null;
  vendor: string | null;
  source_file_id: string | null;
  order_ref: string | null;
  tracking_number: string | null;
  /** The receipt read as a state on the session (scan-session.ts): the row's
   *  "reading…" / "couldn't be read" and the header's count come from this,
   *  never from the shape of the lines. */
  read_state: string | null;
  read_failure: unknown;
  read_started_at: string | null;
  created_at: string | null;
  /** Which way round the receipt's numeric date was read, and by what
   *  (receipt-date.ts, #2917), so the header can say so beside the date. */
  date_convention: string | null;
  date_decided_by: string | null;
  date_printed: string | null;
  /** The session's lines over EVERY row, not the page: the header's "N
   *  items", File N and the verdict read these, so a session that spans a
   *  page boundary says the same before and after scrolling (#3638). */
  lines: { pending: number; ever: number };
  /** Where the parcel is, so a receipt WAITING in the inbox can say so.
   *  Filing it into an order is bookkeeping; the parcel moves either way. */
  shipment_state: string | null;
  shipment_description: string | null;
  shipment_location: string | null;
  /** A receipt read while Purchases was off, not yet kept as a purchase: the
   *  session offers to turn Purchases on and record it (#3869). */
  purchase_pending: boolean;
}

/** Session labels for the batches on a page — the inbox groups items by
 *  scan_batch_id and shows this as the group header ("Receipt · <vendor>",
 *  "emailed <when>"). A side map, so the item query/pagination is untouched. */
async function batchLabelsFor(
  db: ReturnType<typeof tenantDb>,
  rows: Array<{ scan_batch_id: string | null }>,
): Promise<Record<string, BatchLabel>> {
  const batchIds = [...new Set(rows.map((i) => i.scan_batch_id).filter((x): x is string => !!x))];
  const batches: Record<string, BatchLabel> = {};
  if (!batchIds.length) return batches;
  const lines = await sessionLines(db, batchIds);
  for (const b of await db
    .selectFrom("core_scan_batches")
    .select(["id", "label", "origin", "origin_from", "vendor", "source_file_id", "order_ref", "tracking_number", "shipment_state", "shipment_description", "shipment_location", "read_state", "read_failure", "read_started_at", "created_at", "date_convention", "date_decided_by", "date_printed", "pending_purchase", "purchases_order_id"])
    .where("id", "in", batchIds)
    .execute()) {
    batches[b.id] = batchLabelOf(b, lines.get(b.id));
  }
  return batches;
}

/** Each session's pending and all-time line counts, in one grouped query. */
async function sessionLines(db: ReturnType<typeof tenantDb>, batchIds: string[]): Promise<Map<string, { pending: number; ever: number }>> {
  const out = new Map<string, { pending: number; ever: number }>();
  if (!batchIds.length) return out;
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select((eb) => [
      "scan_batch_id",
      eb.fn.countAll<string>().as("ever"),
      eb.fn.count<string>(eb.case().when("status", "=", "pending").then(1).end()).as("pending"),
    ])
    .where("scan_batch_id", "in", batchIds)
    .groupBy("scan_batch_id")
    .execute();
  for (const r of rows) if (r.scan_batch_id) out.set(r.scan_batch_id, { pending: Number(r.pending), ever: Number(r.ever) });
  return out;
}

function batchLabelOf(b: {
  label: string | null; origin: string | null; origin_from?: string | null; vendor?: string | null; source_file_id: string | null; order_ref: string | null; tracking_number: string | null;
  shipment_state: string | null; shipment_description: string | null; shipment_location: string | null;
  read_state: string | null; read_failure: unknown; read_started_at: Date | null; created_at: Date;
  date_convention?: string | null; date_decided_by?: string | null; date_printed?: string | null;
  pending_purchase?: unknown;
  purchases_order_id?: string | null;
}, lines: { pending: number; ever: number } = { pending: 0, ever: 0 }): BatchLabel {
  return {
    lines,
    purchases_order_id: b.purchases_order_id ?? null,
    purchase_pending: !!pendingPurchaseOf(b.pending_purchase),
    date_convention: b.date_convention ?? null,
    date_decided_by: b.date_decided_by ?? null,
    date_printed: b.date_printed ?? null,
    label: b.label,
    origin: b.origin,
    origin_from: b.origin_from ?? null,
    vendor: b.vendor ?? null,
    source_file_id: b.source_file_id,
    order_ref: b.order_ref,
    tracking_number: b.tracking_number,
    shipment_state: b.shipment_state,
    shipment_description: b.shipment_description,
    shipment_location: b.shipment_location,
    read_state: b.read_state,
    read_failure: b.read_failure ?? null,
    read_started_at: b.read_started_at ? new Date(b.read_started_at).toISOString() : null,
    created_at: b.created_at ? new Date(b.created_at).toISOString() : null,
  };
}

/** Receipt sessions that need a person or are being read and have NO rows to
 *  hang on: a failed read has no lines, and a read in flight has none yet.
 *  The inbox groups by item, so without this a failed session would not
 *  exist on the page at all; that absence is what the old placeholder item
 *  was for. Newest first, capped like a page. */
async function sessionsWithoutRows(db: ReturnType<typeof tenantDb>, present: Set<string>): Promise<Record<string, BatchLabel>> {
  const out: Record<string, BatchLabel> = {};
  const rows = await db
    .selectFrom("core_scan_batches")
    .select(["id", "label", "origin", "origin_from", "vendor", "source_file_id", "order_ref", "tracking_number", "shipment_state", "shipment_description", "shipment_location", "read_state", "read_failure", "read_started_at", "created_at", "date_convention", "date_decided_by", "date_printed", "pending_purchase"])
    // 'awaiting': a parcel known from its shipping notice, no lines yet. On
    // the page for the same reason a failed read is: the inbox groups by
    // item, and a session with none would otherwise not exist.
    .where("read_state", "in", ["failed", "in_flight", "awaiting"])
    .orderBy("created_at", "desc")
    .limit(50)
    .execute();
  const absent = rows.filter((b) => !present.has(b.id));
  const lines = await sessionLines(db, absent.map((b) => b.id));
  for (const b of absent) out[b.id] = batchLabelOf(b, lines.get(b.id));
  return out;
}

// Keyset cursor over (created_at, id) — stable even with duplicate timestamps.
// The shared keyset cursor (@cobblr/platform-contract/keyset-cursor), to the
// millisecond, in base64url as this list always handed it out.
function encodeCursor(ts: Date | string, id: string): string {
  return Buffer.from(encodeKeysetCursor(ts, id), "utf8").toString("base64url");
}
function decodeCursor(c: string): { ts: Date; id: string } | null {
  try {
    // b64-lenient-ok: a list cursor only says where the next page starts; every spelling of it is the same place.
    const k = decodeKeysetCursor(Buffer.from(c, "base64url").toString("utf8"));
    return k?.id ? { ts: k.at, id: k.id } : null;
  } catch {
    return null;
  }
}

listRouter.get(
  "/inbox",
  asyncHandler(async (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const db = tenantDb(req);
    const { status, source_kind, batch_id, limit, cursor, triage } = q.data;

    // A search: the waiting rows a word finds, each served with where it is
    // headed. Matched on the raw rows first (the name as the card shows it),
    // so only the matches pay for serving; the destination is judged on the
    // served row, the one answer the card and filing read.
    if (q.data.q) {
      const scanned = await db
        .selectFrom("core_scan_inbox_items")
        .selectAll()
        .where("status", "=", "pending")
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(TRIAGE_SCAN_CAP)
        .execute();
      const text = q.data.q;
      const matched = scanned.filter((row) => rowMatchesText(row, text));
      const served = await servedAll(req, matched);
      const dest = q.data.destination;
      const found = dest ? served.filter((row) => headedFor(row, dest)) : served;
      res.json({
        items: found.slice(0, limit),
        batches: {},
        sessions: {},
        next_cursor: null,
        total: found.length,
        ...(scanned.length === TRIAGE_SCAN_CAP ? { partial: `searched the newest ${TRIAGE_SCAN_CAP} waiting items` } : {}),
      });
      return;
    }

    // A facet query is a different read: scan the pending queue (capped) and
    // decide membership with the shared predicate, rather than paginate. It
    // answers "which ones need me" in one call, which is what a person asking
    // about their inbox actually wants.
    if (triage && triage !== "all") {
      let facetQuery = db
        .selectFrom("core_scan_inbox_items")
        .selectAll()
        .where("status", "=", "pending")
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(TRIAGE_SCAN_CAP);
      if (source_kind) facetQuery = facetQuery.where("source_kind", "=", source_kind);
      if (batch_id) facetQuery = facetQuery.where("scan_batch_id", "=", batch_id);
      const viewer = await scanViewerFor(req);
      // A facet pages like the whole queue does, so a filter longer than one
      // page reaches its end (#3638): the cursor is the offset into the match.
      const offset = typeof cursor === "string" && /^facet:\d+$/.test(cursor) ? Number(cursor.slice(6)) : 0;
      // One snapshot for the rows, their sessions' labels and the sessions with
      // no rows, as the whole list does (#4893, torn reads).
      const { scanned, matched, page, batchMap, sessions } = await readSnapshot(db, async (snap) => {
        const scanned = (await snap.executeQuery(facetQuery.compile())).rows as Awaited<ReturnType<typeof facetQuery.execute>>;
        const matched = scanned.filter((row) => matchesScanFacet(asTheCardReadsIt(row), triage, Date.now(), viewer));
        const page = matched.slice(offset, offset + limit);
        const batchMap = await batchLabelsFor(snap, page);
        // A receipt whose read failed is a session with no rows, and it needs a
        // person: the review facet carries those sessions as the whole list does.
        const sessions =
          offset === 0 && triage === "needs_review" && !source_kind && !batch_id
            ? await sessionsWithoutRows(snap, new Set(page.map((i) => i.scan_batch_id).filter((x): x is string => !!x)))
            : {};
        return { scanned, matched, page, batchMap, sessions };
      });
      res.json({
        items: await servedAll(req, page),
        batches: batchMap,
        sessions,
        next_cursor: offset + limit < matched.length ? `facet:${offset + limit}` : null,
        total: matched.length,
        // Never let a capped scan read as a complete answer.
        ...(scanned.length === TRIAGE_SCAN_CAP
          ? { partial: `counted over the newest ${TRIAGE_SCAN_CAP} pending items` }
          : {}),
      });
      return;
    }

    // ONE SNAPSHOT for the page, its sessions and the count (#4893, torn reads):
    // read one after the other, a receipt session marked read between the
    // items query and the sessions query showed up in neither (no lines yet
    // when the items were read, no longer "in flight" when the sessions were).
    const { items, next_cursor, batches, sessions, total, splits } = await readSnapshot(db, async (snap) => {
      let query = snap
        .selectFrom("core_scan_inbox_items")
        .selectAll()
        .orderBy(sql`date_trunc('milliseconds', created_at)`, "desc")
        .orderBy("id", "desc")
        .limit(limit);
      // Default scope: hide discarded items in the standard list.
      if (status) query = query.where("status", "=", status);
      else query = query.where("status", "!=", "discarded");
      if (source_kind) query = query.where("source_kind", "=", source_kind);
      if (batch_id) query = query.where("scan_batch_id", "=", batch_id);
      const c = cursor ? decodeCursor(cursor) : null;
      if (c && /^[0-9a-f-]{36}$/i.test(c.id)) {
        query = query.where(sql<boolean>`(date_trunc('milliseconds', created_at), id) < (${c.ts}, ${c.id}::uuid)`);
      }
      const items = await query.execute();
      const last = items[items.length - 1];
      const next_cursor = items.length === limit && last ? encodeCursor(last.created_at, last.id) : null;

      const batches = await batchLabelsFor(snap, items);
      // The lines this page's parts came from (#6067): a split line is
      // resolved and off the page, and its parts sit under it.
      const splits = await splitParentsOf(snap as never, items);
      // Sessions with no rows on any page: a failed or in-flight receipt read.
      // First page only, unscoped, so they are seen once; a batch_id scope
      // asks for one session and gets its own state through `batches`.
      const sessions = !cursor && !batch_id && !source_kind && (!status || status === "pending") ? await sessionsWithoutRows(snap, new Set(items.map((i) => i.scan_batch_id).filter((x): x is string => !!x))) : {};
      // Total (for the header) only on the first page — it doesn't change per page.
      let total: number | undefined;
      if (!cursor) {
        let cq = snap.selectFrom("core_scan_inbox_items").select((eb) => eb.fn.countAll().as("n"));
        if (status) cq = cq.where("status", "=", status);
        else cq = cq.where("status", "!=", "discarded");
        if (source_kind) cq = cq.where("source_kind", "=", source_kind);
        if (batch_id) cq = cq.where("scan_batch_id", "=", batch_id);
        const row = await cq.executeTakeFirst();
        total = Number(row?.n ?? 0);
      }
      return { items, next_cursor, batches, sessions, total, splits };
    });
    const parentRows = (splits.parents.length ? await servedAll(req, splits.parents as never) : []) as unknown as Array<{ id: string }>;
    const split_parents = Object.fromEntries(Object.values(splits.summaries).map((s) => [s.id, { ...s, row: parentRows.find((r) => r.id === s.id) ?? null }]));
    res.json({ items: await servedAll(req, items), batches, sessions, split_parents, next_cursor, ...(total !== undefined ? { total } : {}) });
  }),
);

// Registered ABOVE /inbox/:id on purpose. Express matches in registration
// order, so a literal path declared after the parameter route is never
// reached: "session-theme" was read as an id, failed the identifier check,
// and every inbox load got a 400 for it - the session theme had been dead in
// production without a single test noticing (found by the e2e walk,
// 2026-09-01). lint:route-shadowing keeps the order true.
const SessionThemeBody = z.object({
  batch_id: z.string().max(200),
  ids: z.array(z.string().max(100)).max(1_000).optional(),
});

/** The theme of one session, about exactly the ids asked (the group on
 *  screen), or the whole session when none are named. */
async function sessionTheme(req: Request, res: Response, batchId: string, asked: readonly string[] | null): Promise<void> {
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    // ONE SESSION, named by the caller. This used to read the 50 most recent
    // pending items in the whole workspace and render inside whatever the
    // person was looking at, so a filtered view of two humidifiers was offered
    // a grocery category "to 50 of them" - two populations in one sentence,
    // and an Apply that would have stamped 50 rows off screen (2026-09-03).

    if (!batchId) {
      res.status(400).json({ error: { code: "missing_batch", message: "batch_id required: a theme is a question about one session." } });
      return;
    }
    // The ids the group on screen shows (session-theme.ts): the answer is
    // about exactly those, so its sentence and its Apply name one set.
    const askedIds = asked ? asked.filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 200) : null;
    const items = themeScope(await pendingThemeItems(db, batchId, askedIds), askedIds);
    if (items.length < 2) {
      res.json(themeFromReply(items, null));
      return;
    }
    const list = items.map((i, n) => `${n + 1}. ${i.name ?? "(unnamed)"}${i.category ? ` [${i.category}]` : ""}${i.is_titled_media ? " (titled media)" : ""}`).join("\n");
    const system =
      "You spot the common theme in a batch of just-scanned inventory items and propose a shared tag + an optional category. " +
      "Output ONLY one JSON object, no prose: " +
      '{"tag": "<a short 1-2 word tag that fits ALL items, Title Case, or null if they have no clear shared theme>", ' +
      '"category": "<a short product-category value for the NON-titled-media items only, or null>", ' +
      '"category_item_numbers": [<the 1-based numbers of the items the category applies to — the generic products, NEVER titled media>]}. ' +
      "Rules: the tag must genuinely fit every item or be null (don't force it). The category groups the non-media products; titled media (books) get the tag but not the category. Derive both from what you see — invent nothing generic like \"Miscellaneous\".";
    let parsed: { tag?: unknown; category?: unknown; category_item_numbers?: unknown } | null = null;
    try {
      const r = await platform().ai.invoke({
        orgId: ctx.org.id,
        capability: "organise",
        input: { output_schema: objectWith(["tag"], { tag: TEXT_OR_NULL, category: TEXT_OR_NULL, category_item_numbers: { type: ["array", "null"] } }), messages: [{ role: "system", content: system }, { role: "user", content: `The ${countOf(items.length, "pending item")}:\n${list}` }] },
        source: { kind: "core-scan:session-theme", id: ctx.org.id },
        userId: sessionUser(req).id,
      });
      const raw = r.text;
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {
      /* AI off / errored → no suggestion */
    }
    res.json(themeFromReply(items, parsed));
}

// The ids ride in the body (#4653): a session of a couple of hundred scans
// put them past what a proxy accepts in a query string.
// AI-REACH: exempt a question the session header asks about the group on screen; the assistant reads the inbox through list_scan_inbox
listRouter.post(
  "/inbox/session-theme",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = SessionThemeBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    await sessionTheme(req, res, parsed.data.batch_id, parsed.data.ids ?? null);
  }),
);

/** The pre-#4653 address, kept for a page loaded before the update. */
listRouter.get(
  "/inbox/session-theme",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const batchId = typeof req.query.batch_id === "string" ? req.query.batch_id : "";
    const asked = typeof req.query.ids === "string" && req.query.ids ? req.query.ids.split(",") : null;
    await sessionTheme(req, res, batchId, asked);
  }),
);

listRouter.get(
  "/inbox/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    res.json(await served(req, row));
  }),
);

// ─────────────────────────── PATCH /inbox/:id ──────────────────────
// Light edits the camera modal makes in-the-moment: the quantity stepper,
// and an optional name correction. Triage/commit still happens on /scan.

export const PatchBody = z.object({
  send_drop_unmapped: z.boolean().optional(),
  send_unplaced: z.boolean().optional(),
  quantity: FiledQuantity.optional(),
  name: z.string().min(1).max(160).optional(), // none-refused-ok: a column that cannot hold null
  // Set/clear the filing location on an existing item (bulk "Set location" in
  // triage stamps the same value across a selection). null clears it.
  target_location_id: z.string().uuid().nullable().optional(),
  // Is this the ITEM (possibly in its box) or an EMPTY box you keep?
  // Rides suggested_metadata.box_state and lands on the entity at confirm.
  box_state: z.enum(["item-in-box", "empty-box"]).nullable().optional(),
  // "Looks fine" — a human eyeballed a ⚠-flagged item; drop it from needs-review.
  reviewed: z.boolean().optional(),
  // "Not right": the name shown is wrong. It joins the turned-down list and
  // never comes back on its own; the row waits for a name (#3724).
  reject_name: optionalField(z.literal(true)),
  // "Not the same, keep separate": this scan is not the record the
  // matchmaker found. Stored against THAT record, so a re-run that finds a
  // different one asks again; false withdraws it.
  keep_separate: z.boolean().optional(),
  // Answer to "this photo has N different things — keep them together, or split?"
  // true = keep as one record; the offer stops asking. An UNANSWERED offer and a
  // declined one must look different, or we'd nag on every render.
  keep_grouped: z.boolean().optional(),
  // "Treat it as one item": the person's answer to a receipt whose read
  // failed (#3581). The row stops being a failed receipt and asks for a
  // name like any photo; Read again stays one tap away in its tools.
  read_as_item: z.boolean().optional(),
  // "I will photograph this myself." Set from a desk, where the camera is not
  // the one you want; the scanner and the dashboard then carry the item to the
  // phone, instead of you finding it again in a long inbox.
  photo_wanted: z.boolean().optional(),
  // Values the person typed against the destination's fields, kept on the
  // row without filing it (services/user-fields.ts). null clears one. Each
  // is stamped as the person's in field_provenance, so no pass and no
  // re-run outranks it (acquisition-source.ts, #3008).
  fields: z.record(z.string().min(1).max(80), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
  // The table the fields were typed for ("yarn:item"). Absent: the top
  // candidate's table at the time of the write.
  fields_kind: optionalText(120),
  // The category the person chose, by name, for a table that keeps its own
  // categories and so has no field to type it into (#3223). Kept beside
  // `fields` for the same table and read back as the top candidate's
  // category by every door. null or "" clears it.
  category: z.string().max(200).nullable().optional(),
  // Where the PERSON said this goes (the pill's pick), kept on the row and
  // stamped as theirs, so a better system suggestion never replaces it; the
  // system's own route (the top candidate) may be (#3062). null clears the
  // choice, and the row reads as the system's again.
  destination: z
    .object({
      module: z.string().min(1).max(120),
      instance: z.string().max(120).nullable().optional(),
      kind: z.string().max(120).nullable().optional(),
      label: z.string().max(160).nullable().optional(),
    })
    .nullable()
    .optional(),
});

// AI-TOOL: change_scan_item
listRouter.patch(
  "/inbox/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.quantity !== undefined) patch.quantity = parsed.data.quantity;
    if (parsed.data.name !== undefined) {
      patch.suggested_name = parsed.data.name;
      // A person's name is not an identification at some confidence: the
      // lookup's score (a store code's 0) must not follow the row around as
      // "Identified at 0% confidence" once they have said what it is (#3017).
      patch.ai_confidence = null;
    }
    if (parsed.data.target_location_id !== undefined) patch.target_location_id = parsed.data.target_location_id;
    // One transaction, the row locked from the read to the write: the rider
    // merges below (a person's field values, their name, their table) are
    // computed in JS over the bag as it stands, so two edits arriving
    // together must not both read the same bag and each write back only
    // their own change (#3625). The second waits and reads the first's.
    const txDb = tenantDb(req);
    const { row, prior } = await txDb.transaction().execute(async (db) => {
      // Metadata-riders (box_state / reviewed): merge into suggested_metadata
      // without clobbering the rest of the blob.
      if (
        parsed.data.send_drop_unmapped !== undefined ||
        parsed.data.send_unplaced !== undefined ||
        parsed.data.box_state !== undefined ||
        parsed.data.reviewed !== undefined ||
        parsed.data.quantity !== undefined ||
        parsed.data.reject_name !== undefined ||
        parsed.data.keep_separate !== undefined ||
        parsed.data.keep_grouped !== undefined ||
        parsed.data.read_as_item !== undefined ||
        parsed.data.photo_wanted !== undefined ||
        parsed.data.fields !== undefined ||
        parsed.data.category !== undefined ||
        parsed.data.name !== undefined ||
        parsed.data.destination !== undefined
      ) {
        const cur = await db
          .selectFrom("core_scan_inbox_items")
          .select(["suggested_metadata", "suggested_candidates", "suggested_name"])
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        let meta = (cur?.suggested_metadata ?? {}) as Record<string, unknown>;
        if (parsed.data.send_drop_unmapped !== undefined) meta.send_drop_unmapped = parsed.data.send_drop_unmapped;
        if (parsed.data.send_unplaced !== undefined) meta.send_unplaced = parsed.data.send_unplaced;
        if (parsed.data.fields !== undefined) {
          const kind = parsed.data.fields_kind ?? candidateKind(storedCandidateList(cur?.suggested_candidates)[0]);
          meta = applyUserFieldPatch(meta, parsed.data.fields, kind);
          // Who put it there: the person. A cleared value drops the stamp
          // too, so the field reads as whatever the pipeline says again.
          const stamps: FieldProvenanceMap = { ...fieldProvenanceOf(meta) };
          const at = new Date().toISOString();
          for (const [name, v] of Object.entries(parsed.data.fields)) {
            if (v === null || v === "") delete stamps[name];
            else stamps[name] = { by: "person", from: "card", at, ...(stamps[name]?.role ? { role: stamps[name]!.role } : {}) };
          }
          if (Object.keys(stamps).length) meta[FIELD_PROVENANCE_KEY] = stamps;
          else delete meta[FIELD_PROVENANCE_KEY];
        }
        if (parsed.data.category !== undefined) {
          const kind = parsed.data.fields_kind ?? candidateKind(storedCandidateList(cur?.suggested_candidates)[0]);
          meta = applyUserCategory(meta, parsed.data.category, kind);
        }
        // The name is a field (#2982): the person's is kept on the row and
        // stamped person, so the re-run that rewrites the column never shows
        // over it (services/user-name.ts; every reader resolves through the
        // contract's displayName).
        if (parsed.data.reject_name) meta = applyRejectName(meta, displayName({ suggested_name: cur?.suggested_name ?? null, suggested_metadata: meta }));
        if (parsed.data.name !== undefined) meta = applyPersonName(meta, parsed.data.name);
        if (parsed.data.box_state !== undefined) {
          if (parsed.data.box_state === null) delete meta.box_state;
          else meta.box_state = parsed.data.box_state;
        }
        if (parsed.data.reviewed !== undefined) meta.reviewed = parsed.data.reviewed;
        // A count the person set is theirs: a label read never replaces it
        // (services/label-quantity.ts, #3729).
        if (parsed.data.quantity !== undefined) {
          meta[FIELD_PROVENANCE_KEY] = { ...fieldProvenanceOf(meta), quantity: { by: "person", from: "edit", at: new Date().toISOString() } };
          // A count set by hand answers "two of them, or one scanned twice?" (#8851).
          delete meta[SCANNED_TOO_KEY];
        }
        if (parsed.data.keep_separate !== undefined) {
          const stamp = parsed.data.keep_separate ? scanKeepSeparateStamp(meta, new Date().toISOString()) : null;
          if (stamp) meta[KEEP_SEPARATE_KEY] = stamp;
          else delete meta[KEEP_SEPARATE_KEY];
        }
        if (parsed.data.keep_grouped !== undefined) meta.keep_grouped = parsed.data.keep_grouped;
        if (parsed.data.read_as_item !== undefined) meta.read_as_item = parsed.data.read_as_item;
        if (parsed.data.destination !== undefined) {
          if (parsed.data.destination === null) delete meta[DESTINATION_KEY];
          else {
            const d = parsed.data.destination;
            const stored: StoredDestination = { module: d.module, instance: d.instance ?? null, kind: d.kind ?? null, label: d.label ?? null, by: "person", at: new Date().toISOString() };
            meta[DESTINATION_KEY] = stored;
          }
        }
        // Cleared rather than stored false: the queue asks "which items want a
        // photo", and a row answering "not me" is noise in a jsonb bag that four
        // other writers share.
        if (parsed.data.photo_wanted !== undefined) {
          if (parsed.data.photo_wanted) meta.photo_wanted = true;
          else delete meta.photo_wanted;
        }
        patch.suggested_metadata = JSON.stringify(meta);
      }
      // Capture the prior name first: renaming a barcode item is a correction we
      // feed back to the shared Barcode Intelligence DB (below), and we need the
      // value the resolver gave to record what was wrong.
      const prior =
        parsed.data.name !== undefined
          ? await db
              .selectFrom("core_scan_inbox_items")
              .select(["barcode_text", "suggested_name"])
              .where("id", "=", id)
              .executeTakeFirst()
          : undefined;
      const row = await db
        .updateTable("core_scan_inbox_items")
        .set(patch)
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirst();
      return { row, prior };
    });
    const db = txDb;
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    // Who changed what, on the row's History: an Undo split reads it, so a
    // teammate's rename of a piece is never discarded unseen (#8557).
    const changed: ScanEditPart[] = [
      ...(parsed.data.name !== undefined ? (["name"] as const) : []),
      ...(parsed.data.quantity !== undefined ? (["count"] as const) : []),
      ...(parsed.data.target_location_id !== undefined ? (["place"] as const) : []),
      ...(parsed.data.fields !== undefined ? (["fields"] as const) : []),
      ...(parsed.data.category !== undefined ? (["category"] as const) : []),
      ...(parsed.data.destination !== undefined ? (["table"] as const) : []),
    ];
    if (changed.length) await appendScanHistory(db, id, { action: "edit", by: sessionUser(req)?.id ?? null, by_name: sessionUser(req)?.display_name ?? null, changed });
    // An inline rename of a barcode item ALSO propagates to the Barcode
    // Intelligence DB — the resolver's name was wrong and the human's is truth,
    // so the next scan of this UPC (any workspace) gets the fix. Mirrors the
    // confirm-time report; reportBarcodeCorrection guards trivial edits. Inert
    // unless the resolver + a correction token are configured.
    if (prior?.barcode_text && parsed.data.name !== undefined && parsed.data.name.trim()) {
      // DETACHED: a correction sent to the shared barcode database; this workspace's row is saved without it
      void reportBarcodeCorrection({
        upc: prior.barcode_text,
        field: "title",
        was: prior.suggested_name,
        now: parsed.data.name.trim(),
        userId: sessionUser(req).id,
        lots: unitLotsOf(row.suggested_metadata),
      });
    }

    // Manual-name fallback: when the user NAMES a previously-unidentified item
    // (a bare photo on a no-vision workspace — see enrich-photo's "fill in
    // manually"), re-route it through the matchmaker so the heuristic (or AI)
    // suggests a table + fills fields, instead of leaving them to pick. Detached,
    // forced (the row had no name, so it was never matched). The web polls /inbox.
    const token = bearer(req);
    if (parsed.data.name !== undefined && parsed.data.name.trim() && token) {
      const ctx = tenantContext(req);
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      // DETACHED: re-matching after a rename; the suggestion refreshes when it lands
      void matchItem({
        orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null,
        orgSlug: ctx.org.slug,
        token,
        baseUrl,
        itemId: id,
        force: true,
      }).catch((err) => console.error("[core-scan] re-match after rename threw:", (err as Error).message));
      // Name changed → the catalog image likely shows the OLD product; refresh it
      // to match the new name (detached, best-effort).
      if (prior?.suggested_name !== parsed.data.name.trim()) {
        // DETACHED: a new catalog picture for the new name; the row keeps its picture until then
        void refreshCatalogImageByName(
          ctx.org.id,
          id,
          parsed.data.name.trim(),
          (row.suggested_manufacturer as string | null) ?? null,
        ).catch((err) => console.error("[core-scan] catalog refresh after rename threw:", (err as Error).message));
      }
    }
    // A rename is what the row is called now, so its match is re-derived
    // under the new name before the row goes back: the card and File
    // everything read this one stamp (services/tracked-stamp.ts, #3726). A
    // "not the same" answer stays tied to its record, so a re-derived match
    // on that record stays declined. A matcher that fails keeps the old
    // stamp and says so; the detached re-match above tries again.
    let out = row;
    if (parsed.data.name !== undefined && row.status === "pending") {
      try {
        const named = withPersonName(row);
        const dest = filingDestination(named, await destinationTablesFor(req));
        await restampTrackedMatch(tenantContext(req).org.id, db as never, id, row, (dest?.fields as Record<string, unknown> | undefined) ?? null, topCandidateCategory(row.suggested_candidates));
        out = (await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst()) ?? row;
      } catch (err) {
        console.error("[core-scan] re-deriving the match after rename failed; the old one stands:", (err as Error).message);
      }
    }
    // A pack's part renamed to what another part of the pack already is:
    // the two are one row, units and money added (pack-groups.ts, #5764).
    if (parsed.data.name !== undefined && row.status === "pending") {
      const token = bearer(req);
      const http = token ? { baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API, slug: tenantContext(req).org.slug, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } } : null;
      const { merged } = await regroupPack(db, id, http).catch((err: Error) => {
        console.error("[core-scan] regrouping the pack after a rename failed:", err.message);
        return { merged: [] };
      });
      if (merged.length) out = (await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst()) ?? out;
    }
    // What the row says it looks like may have changed (a colour field, the
    // name): its catalog picture is judged again against it (#3729).
    if ((parsed.data.fields !== undefined || parsed.data.name !== undefined) && row.status === "pending") {
      try {
        if ((await withholdContradictedPicture(tenantContext(req).org.id, db as never, id)) === "withheld") {
          out = (await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst()) ?? out;
        }
        // A colour the person gave the item that its picture does not show
        // is looked for, in the background (the response does not wait).
        // DETACHED: looking for a picture in the item's colour; the row keeps its picture until then
        void rechoosePictureForColour(tenantContext(req).org.id, db as never, id).catch((err) =>
          console.error("[core-scan] choosing a picture in the item's colour after an edit failed:", (err as Error).message),
        );
      } catch (err) {
        console.error("[core-scan] judging the picture after an edit failed:", (err as Error).message);
      }
    }
    res.json(await served(req, out));
  }),
);

const FileSelectedBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  target_module: optionalField(z.string().min(1)),
  target_kind: optionalField(z.string().min(1)),
  instance: optionalField(z.string().min(1)),
  /** File a thing the workspace already tracks as a second record anyway. */
  allow_duplicate: z.boolean().optional(),
  /** Per item, a catalog entry to file it bound to (#6888), as confirm takes it. */
  catalog_entries: z.record(z.string().min(1).max(300)).optional(),
});

// AI-TOOL: file_inbox_items
listRouter.post("/inbox/file-selected", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const parsed = FileSelectedBody.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const token = bearer(req);
  if (!token) { res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } }); return; }
  const ctx = tenantContext(req);
  const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
  const { ids, allow_duplicate, catalog_entries, ...target } = parsed.data;
  // This door CREATES a record per item. One the workspace already tracks
  // (its card offers "+1 more") or whose match is a choice a person must
  // make is never made a second record here: the dashboard's Add and an
  // agent's file_inbox_items both came through this door and duplicated a
  // printer the workspace already had (review of #4912). scanRebuy is the
  // card's own rule.
  const tables = await destinationTablesFor(req);
  const rows = await tenantDb(req).selectFrom("core_scan_inbox_items").selectAll().where("id", "in", ids).execute();
  const already = new Map<string, string>();
  if (!allow_duplicate) {
    for (const r of rows) {
      const row = withPersonName(r as never) as unknown as ScanTriageRow;
      const rebuy = scanRebuy(row, { tables });
      if (rebuy.kind === "none") continue;
      const title = scanTrackedMatch(row)?.title;
      already.set(r.id, rebuy.kind === "hold" && "sentence" in rebuy && rebuy.sentence ? rebuy.sentence : `already tracked as "${title ?? "something you have"}"; add to it from its card`);
    }
  }
  const { fileSelected } = await import("../../services/file-selected.js");
  const result = await fileSelected(ids, target.instance ? `${target.instance}:item` : target.target_kind ?? "", async (id) => {
    const held = already.get(id);
    if (held) throw new Error(held);
    const response = await apiFetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/core-scan/inbox/${encodeURIComponent(id)}/confirm`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...target, filed_with: ids, ...(catalog_entries?.[id] ? { catalog_entry_id: catalog_entries[id] } : {}) }),
    });
    const body = await response.json() as { error?: { message?: string }; item?: { target_kind?: string | null }; created?: { id?: string; name?: unknown; title?: unknown } };
    if (!response.ok) throw new Error(body.error?.message || "It could not be added");
    return body;
  });
  res.json(result);
}));

// The catalog entries a scan could be, for its confirm (#6888): a part
// number first, then a strong name, and only then the model, among plausible
// entries. Empty when no catalog binds to where it goes. Writes nothing.
// `kind` is where it is being filed (the confirm's table); without one, the
// row's own best destination. `ai=0` never asks the model (an assistant
// reading the item).
listRouter.get(
  "/inbox/:id/catalog-candidates",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const row = await tenantDb(req).selectFrom("core_scan_inbox_items").selectAll().where("id", "=", String(req.params.id)).executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const asked = typeof req.query.kind === "string" && req.query.kind.trim() ? req.query.kind.trim() : null;
    const best = candidateKind(storedCandidateList(row.suggested_candidates)[0]) ?? null;
    const out = await catalogCandidatesFor({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      row,
      destinationKind: asked ?? best,
      allowAi: req.query.ai !== "0",
    });
    res.json({ candidates: out.candidates, asked_ai: out.askedAi });
  }),
);

export async function servedAll<T extends ScanTriageRow & {
  suggested_name: string | null;
  suggested_manufacturer?: string | null;
  suggested_candidates?: unknown;
  suggested_metadata?: unknown;
}>(req: Request, rows: T[]): Promise<Array<T & { needs_review: boolean; waiting_days: number | null; group_image_file_id: string | null }>> {
  const live = await liveTablesFor(req);
  const containers = await containerKindsFor(req);
  const format = titleFormatFor(req);
  const tables = await destinationTablesFor(req);
  const viewer = await scanViewerFor(req);
  return (await withGroupImages(req, rows)).map((r, i) => withHeld(withDestination(withTitle(withResolvedOffers(r, live), containers, format), rows[i]!, tables, live), viewer));
}

// ──────────────────────── POST /inbox/combine ───────────────────────
// ─────────── Session theme: derive a tag + category ON THE FLY ───────────
// After a capture session, the pending items often share a theme (a mixed
// batch of related gear: some books, some accessories). One AI call over the pending
// items proposes (a) ONE cross-cutting TAG that fits them ALL regardless of
// where each lands, and (b) a CATEGORY value for the subset that are generic
// products (not titled media like books, which route to a Bookshelf). Nothing
// is hardcoded — the theme is derived; degrades to no-suggestion when AI is off.

type ThemeItemLite = ThemeItem;

async function pendingThemeItems(
  db: ReturnType<typeof tenantDb>,
  batchId: string,
  askedIds: readonly string[] | null,
): Promise<ThemeItemLite[]> {
  let q = db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "suggested_name", "suggested_metadata", "suggested_candidates"])
    .where("status", "=", "pending")
    .where("scan_batch_id", "=", batchId);
  if (askedIds) q = askedIds.length ? q.where("id", "in", [...askedIds]) : q.where(sql<boolean>`false`);
  const rows = await q.orderBy("created_at", "desc").limit(askedIds ? 200 : 50).execute();
  const mediaField = /^(author|isbn|director|artist|composer|writer|edition|publisher|issn)$/i;
  return rows.map((r) => {
    const meta = (r.suggested_metadata ?? {}) as { category?: unknown; hint_category?: { domain?: unknown } };
    const cands = (r.suggested_candidates ?? []) as Array<{ fields?: Record<string, unknown> }>;
    const isMedia = cands.some((c) => Object.keys(c.fields ?? {}).some((k) => mediaField.test(k)));
    const cat = typeof meta.category === "string" ? meta.category : typeof meta.hint_category?.domain === "string" ? meta.hint_category.domain : null;
    return { id: r.id, name: r.suggested_name, category: cat, is_titled_media: isMedia };
  });
}
