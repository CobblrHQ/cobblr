// A scan of something already here: tracked matches, place, attach, unconfirm, and a bin's contents.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { attachPhotoFileId } from "../../services/attach-photo.js";
import { appendScanHistory } from "../../services/scan-history.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { reportPackIfFiled } from "../../services/pack-network.js";
import { rowLots } from "../../services/row-lots.js";
import { SCAN_COUNT_REASONS, scanCountLedgerReason, scanCountLeftLow } from "@cobblr/platform-contract/scan-count";
import { candidatesWithUserFields } from "../../services/user-fields.js";
import { isMachineReadCode } from "../../services/barcode-source.js";
import { buildCadenceEvents } from "../../cadence-events.js";
import { moveQuantity, scanTargetOf, type QuantityMove } from "../../services/scan-target.js";
import { RAN_OUT_KEY, ranOut, withdrawRanOut, type RanOutOutcome } from "../../services/ran-out.js";
import { FiledQuantity, filedQuantityOf } from "../../services/filed-quantity.js";
import { sql } from "kysely";
import { z } from "zod";
import { claimOrderLine } from "../../services/receipt-order.js";
import { platform, isActionStep, type ActionUndoStep } from "@cobblr/platform-contract";
import { splitEntityKind } from "@cobblr/platform-contract/entity-kind";
import { scanPurpose, scanPurposeReview, FILED_INTO_KEY, isPaperworkRow, scanMatchTier } from "@cobblr/platform-contract/scan-triage";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { brokenMarkOf, markBroken, unmarkBroken } from "../../services/mark-broken.js";
import { mergeMeta } from "../../services/metadata.js";
import { newPlaceAt } from "../../services/tracked-stamp.js";
import { matchQuery, scanPlaceOf, trackedMatchFor, type TrackedMatchStamp } from "../../services/tracked-stamp.js";
import { filingDestination } from "../../services/destination.js";
import { evidencedFill } from "@cobblr/platform-contract/scan-evidence";
import { findBinContents, findTracked, placesOfCard } from "../../services/entity-match.js";
import { withArticle } from "@cobblr/platform-contract/plural";
import { apiFetch } from "@cobblr/platform-contract/self-api";
import { optionalField } from "@cobblr/platform-contract/optional-fields";
import { INTERNAL_API, INTO_BIN, NEW_BIN, destinationTablesFor, filedIntoFor, putPaperworkOn, storedCandidateList, topCandidateCategory } from "./shared.js";

export const attachRouter = Router({ mergeParams: true });

// ─────────────────── GET /inbox/:id/tracked-matches ─────────────────
// "Already tracked?" — entities the workspace ALREADY has that match this
// scan, by exact barcode (metadata.barcode, stamped by every confirm) or by
// name-token overlap. Powers the heads-up banner + attach targets.
attachRouter.get(
  "/inbox/:id/tracked-matches",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["barcode_text", "suggested_name", "suggested_manufacturer", "status", "target_entity_id", "suggested_candidates", "suggested_metadata"])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    // Asked the way the stamp is (the person's name first), so the banner
    // never lists records the row's own match was not derived from (#3726).
    const matches = await findTracked(ctx.org.id, matchQuery(row, topCandidateFields(row.suggested_candidates), topCandidateCategory(row.suggested_candidates)));
    // One thing kept in several places: every place, so the banner can ask
    // which one this scan goes to (and which one it already picked).
    const tier = scanMatchTier(matches);
    const cards = new Set(tier.map((m) => m.card_id ?? m.id));
    let places: Array<{ id: string; location_id: string | null; location_name: string | null; qty: number | null }> = [];
    const best = tier[0];
    if (best && cards.size === 1) {
      const raw = await placesOfCard(ctx.org.id, best.kind, best.card_id ?? best.id);
      if (raw.length > 1) {
        const locs = await platform().entities.lookupMany(
          ctx.org.id,
          [...new Set(raw.map((p) => p.location_id).filter((x): x is string => !!x))].map((lid) => ({ kind: "core-locations:location", id: lid })),
        );
        const name = new Map(locs.map((l) => [l.id, l.title]));
        places = raw.map((p) => ({ id: p.id, location_id: p.location_id, location_name: p.location_id ? (name.get(p.location_id) ?? null) : null, qty: p.qty }));
      }
    }
    const pick = scanPlaceOf(row).place_choice ?? null;
    res.json({ ...matches, places, place_choice: pick });
  }),
);

// ─────────────────── POST /inbox/:id/place ─────────────────
// Which place of the matched thing this scan goes to, when it is kept in
// several: stored on the row (a reload never asks twice) and the row's match
// re-stamped at that place, so "+1 more" adds there (scanRebuy).
// AI-REACH: exempt, the answer to a question on a scan card; filing is reached through the inbox's own actions
attachRouter.post(
  "/inbox/:id/place",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const recordId = typeof req.body?.record_id === "string" ? req.body.record_id : null;
    if (!recordId) {
      res.status(400).json({ error: { code: "invalid_body", message: "Say which place (record_id)." } });
      return;
    }
    const id = req.params.id ?? "";
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const stored = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst();
    if (!stored) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    // Judged with the pick, and the pick kept only when it is one of the
    // places: a refused pick is not left on the row.
    const prior = (stored.suggested_metadata ?? {}) as Record<string, unknown>;
    const row = { ...stored, suggested_metadata: { ...prior, place_choice: recordId } };
    const tables = await destinationTablesFor(req);
    const dest = filingDestination(row, tables);
    let stamp: TrackedMatchStamp | null;
    try {
      stamp = await trackedMatchFor(ctx.org.id, row, (dest?.fields as Record<string, unknown> | undefined) ?? null, topCandidateCategory(row.suggested_candidates));
    } catch {
      // Could not read where it is kept: say so, never "not one of the
      // places" for a place it may well be (#4985).
      res.status(503).json({ error: { code: "could_not_check", message: "Could not check where this is kept. Try again." } });
      return;
    }
    if (!stamp || stamp.id !== recordId) {
      res.status(409).json({ error: { code: "not_a_place", message: "That is not one of the places this is kept." } });
      return;
    }
    await db
      .updateTable("core_scan_inbox_items")
      // The pick and the match it makes, in one write.
      .set({ suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ place_choice: recordId, tracked_match: stamp })}::jsonb` as never })
      .where("id", "=", id)
      .execute();
    res.json({ ok: true, tracked_match: stamp });
  }),
);

/** The ledger's name for what one inbox item did, so an undo can ask the
 *  ledger to forget exactly that (core-cadence:remove-event by source_ref). */
const inboxSourceRef = (itemId: string) => `core-scan:inbox:${itemId}`;

/** Take an attach's quantity bump back off the record it attached to, through
 *  the record's own quantity door, and ask the ledger to forget the purchase.
 *
 *  The door matters. Inventory's quantity write carries the floor (a count
 *  cannot go below zero, and says so), the lots and the consumption ledger;
 *  a kernel writer.update of `qty - n` bypassed all three and, since the
 *  floor became a CHECK constraint, would fail as a bare 500 once a person
 *  had used some in between. So: the kind's declared `adjustAction` when it
 *  has one (invoked ON the record with delta -n; what it reports as moved is
 *  what is reported here), else the module route the bump itself used.
 *  The cadence ledger learns intervals from purchases, and a -n adjust does
 *  not un-teach one, so the purchase the attach filed is removed by its
 *  source_ref instead; best-effort, a ledger the workspace does not keep is
 *  not an error.
 *
 *  Returns what it took and the record's title, or null when there was
 *  nothing recorded to take (an attach from before the qty was written down,
 *  or a kind with no quantity). A refusal from the door (nothing on hand) is
 *  returned with qty 0 and the door's own sentence. Never throws into the
 *  caller: an unconfirm that cannot reverse the bump still reopens the item
 *  and says so. */
async function reverseAttachedQty(
  orgId: string,
  itemId: string,
  attached: { kind?: string; id?: string; instance?: string | null; mode?: string; qty_added?: number; qty_field?: string },
  userId: string | null,
  door: { baseUrl: string; slug: string; headers: Record<string, string> },
): Promise<{ qty: number; title: string; refused?: string } | null> {
  if (attached.mode !== "add-qty" || !attached.id || !attached.kind) return null;
  const qty = Number(attached.qty_added ?? 0);
  const field = attached.qty_field;
  if (!(qty > 0) || !field) return null;
  const current = await platform().entities.lookup(orgId, attached.kind, attached.id);
  if (!current) return null;
  const target = await scanTargetOf(orgId, attached.kind, attached.instance);
  if (!target) return null;

  // Through the one quantity door (services/scan-target.ts): the record's
  // adjust action when it declares one, else its module route. Same helper
  // the attach itself moves the count with.
  const cur = Number((current.fields as Record<string, unknown>)[field] ?? 0);
  const moved = await moveQuantity(orgId, target, { kind: attached.kind, id: attached.id }, -qty, {
    userId,
    reason: "undo: scan attach",
    source: { kind: "core-scan:inbox", id: itemId },
    door,
    current: Number.isFinite(cur) ? cur : 0,
  });
  const took = moved.ok ? Math.abs(moved.delta) : 0;
  const refused = moved.ok ? undefined : (moved.refused ?? "the record's quantity could not be changed");

  await forgetLedgerPurchase(orgId, userId, itemId);
  return { qty: took, title: current.title, ...(refused ? { refused } : {}) };
}

/** The ledger's purchase, by the name the attach gave it. A workspace with
 *  no ledger, or one that predates source refs, simply has nothing to forget. */
async function forgetLedgerPurchase(orgId: string, userId: string | null, itemId: string): Promise<void> {
  await platform()
    .actions.invoke("core-cadence:remove-event", {
      orgId,
      userId,
      scope: "workspace",
      event: {
        name: "core-scan.inbox.unconfirm",
        payload: {},
        actor: { user_id: userId, display_name: null, auth_method: "session" },
        timestamp: new Date().toISOString(),
        trigger_type: "user-invoked",
      },
      args: { source_ref: inboxSourceRef(itemId) },
    })
    .catch((err: unknown) => console.warn("[core-scan] ledger purchase not removed:", (err as Error)?.message ?? err));
}

/** Put the record back the way the attach found it, through the steps the
 *  record's own action handed back at attach time (inventory: restore-part
 *  from the snapshot: the lot goes, the dates and the count go back). The
 *  honest inverse of a dated lot is that lot, not `-n`.
 *
 *  Only while the record still reads what the attach left. A snapshot put
 *  back over a record somebody has used since would resurrect what they used
 *  (attach +2 to 3 = 5, they use 4, the snapshot says 5): then the caller
 *  falls through to taking `-n` off, which says how many were left. Returns
 *  null when the steps were not run. */
async function restoreAttachedRecord(
  orgId: string,
  itemId: string,
  attached: { kind?: string; id?: string; qty_field?: string; qty_after?: number; undo?: unknown },
  userId: string | null,
): Promise<{ title: string; refused?: string } | null> {
  const steps = Array.isArray(attached.undo) ? (attached.undo as ActionUndoStep[]) : [];
  if (!steps.length || !attached.id || !attached.kind || !attached.qty_field || typeof attached.qty_after !== "number") return null;
  const current = await platform().entities.lookup(orgId, attached.kind, attached.id);
  if (!current) return null;
  const now = Number((current.fields as Record<string, unknown>)[attached.qty_field] ?? NaN);
  if (now !== attached.qty_after) return null;
  let refused: string | undefined;
  for (const step of steps) {
    if (!isActionStep(step)) continue;
    const r = (await platform()
      .actions.invoke(step.action_id, {
        orgId,
        userId,
        entity: { kind: step.entity_kind ?? attached.kind, id: step.entity_id ?? attached.id },
        event: {
          name: "core-scan.inbox.unconfirm",
          payload: {},
          actor: { user_id: userId, display_name: null, auth_method: "session" },
          timestamp: new Date().toISOString(),
          trigger_type: "user-invoked",
        },
        args: step.args,
      })
      .catch((err: unknown) => ({ ok: false, error: (err as Error)?.message ?? String(err) }))) as { ok?: boolean; error?: string } | null;
    if (r?.ok !== true) {
      refused = r?.error ?? "the record could not be put back";
      break;
    }
  }
  await forgetLedgerPurchase(orgId, userId, itemId);
  return { title: current.title, ...(refused ? { refused } : {}) };
}

// ─────────────────────── POST /inbox/:id/broken ─────────────────────
// The thing this scan matched is broken (#6889): one repair entry in its
// service log instead of a new thing, and the scan is done. Offered only on a
// scan that matched one thing by its code (scanBrokenTarget); Undo is
// /unconfirm, which takes the entry back off.
const BrokenBody = z.object({ note: optionalField(z.string().trim().max(500)) });

// AI-REACH: action core-scan:mark-broken
attachRouter.post(
  "/inbox/:id/broken",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:mark-broken"))) return;
    const parsed = BrokenBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const r = await markBroken(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, String(req.params.id), parsed.data.note || null);
    if (!r.ok) {
      res.status(r.status).json({ error: { code: r.code, message: r.message } });
      return;
    }
    res.json({ item: r.item, entry_id: r.entry_id, record: r.record });
  }),
);

// ─────────────────────── POST /inbox/:id/unconfirm ─────────────────────
// REVERT a commit: bring a resolved scan back to the pending inbox so a wrong
// confirm can be redone (the mirror of restore-from-discarded, for the other
// resolution). Two cases, split on how the row resolved:
//   - CONFIRMED (an entity was CREATED from this scan): the created entity is
//     deleted through its kind's registered writer — module validation +
//     events fire — and the row reopens. If the entity is already gone (user
//     deleted it by hand) or the kind has no writer, the row still reopens
//     and the response says what was left behind.
//   - ATTACHED (this scan updated a PRE-EXISTING entity — add-qty/link/move):
//     the entity is NEVER deleted; the row reopens and the response notes any
//     quantity bump is yours to undo.

// AI-TOOL: change_scan_item
attachRouter.post(
  "/inbox/:id/unconfirm",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const id = String(req.params.id);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    if (row.status !== "resolved") {
      res.status(422).json({
        error: { code: "not_resolved", message: "Only a committed scan can be sent back." },
      });
      return;
    }

    // A SPLIT parent resolved without a target entity; un-confirming it while
    // its children sit in the inbox doubles the pile (parent reopens AND all N
    // children stay). Refuse with the honest instruction.
    const splitChild = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id"])
      .where(sql`suggested_metadata->>'split_from'`, "=", id)
      .where("status", "!=", "discarded")
      .limit(1)
      .executeTakeFirst();
    if (splitChild) {
      res.status(409).json({
        error: {
          code: "was_split",
          message:
            "This scan was split into separate items, sending it back would duplicate them. Discard the split items first if you want the original back.",
        },
      });
      return;
    }

    const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    const attached = meta.attached_to as
      | { kind?: string; id?: string; instance?: string | null; mode?: string; qty_added?: number; qty_field?: string; qty_after?: number; undo?: unknown }
      | undefined;
    let entityDeleted = false;
    let note: string | null = null;

    const broken = brokenMarkOf(meta);
    if (broken) {
      // A broken mark made no thing: its repair entry comes off, the record stays.
      note = await unmarkBroken(ctx.org.id, sessionUser(req)?.id ?? null, broken);
    } else if (attached?.id && (attached.mode === NEW_BIN || attached.mode === INTO_BIN)) {
      // A bin this scan made goes away with it; a bin that was already there
      // stays, given back what it said before the scan's identity landed.
      const writer = await platform().entities.getWriter(ctx.org.id, attached.kind ?? "core-locations:location");
      const before = (attached as { before?: { metadata?: unknown; description?: unknown; image_path?: unknown } }).before;
      if (attached.mode === NEW_BIN) {
        const gone = writer?.delete ? await writer.delete(ctx.org.id, attached.id).then(() => true).catch(() => false) : false;
        if (gone) entityDeleted = true;
        else note = "The bin it made couldn't be removed automatically. Delete it from Locations.";
      } else if (writer && before) {
        await writer.update(ctx.org.id, attached.id, { metadata: before.metadata ?? {}, description: before.description ?? null, image_path: before.image_path ?? null })
          .then(() => { note = "The bin stays, as it was before this scan."; })
          .catch(() => { note = "The bin stays; its product details from this scan couldn't be taken off."; });
      } else note = "The bin stays.";
    } else if (attached?.id && attached.mode === "add-place") {
      // Another place of an item: that place's row goes, through its module's
      // own delete (which unhooks it from the item), and the item stays.
      const target = attached.kind ? await scanTargetOf(ctx.org.id, attached.kind, attached.instance ?? undefined).catch(() => null) : null;
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      const path = target?.instance
        ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${target.instance}/items/${attached.id}`
        : target
          ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${target.scannable.createEndpoint}/${attached.id}`
          : null;
      const gone = path
        ? await apiFetch(path, { method: "DELETE", headers: { Authorization: `Bearer ${bearer(req) ?? ""}` } }).then((r) => r.ok || r.status === 404).catch(() => false)
        : false;
      if (gone) entityDeleted = true;
      else note = "The place it added couldn't be removed automatically. Remove that place from the item's page.";
    } else if (attached?.id) {
      // An attach that restocked kept the record's own way back (the lot it
      // started, the dates it stamped, the count): put that back, while the
      // record still reads what the attach left. Otherwise, or for an older
      // attach that only recorded what it added, take exactly that back off
      // the record through its own quantity door. Either way the ledger is
      // asked to forget the purchase, so a bulk "File everything" that
      // attached to the wrong thing is undoable line by line.
      const who = sessionUser(req)?.id ?? null;
      const restored =
        attached.mode === "add-qty" || attached.mode === "replace" || attached.mode === "count"
          ? await restoreAttachedRecord(ctx.org.id, id, attached, who).catch(() => null)
          : null;
      if (restored) {
        note = restored.refused
          ? `${restored.title}: ${restored.refused}. Nothing was put back.`
          : `Took the ${Number(attached.qty_added ?? 0)} back off ${restored.title}, and the lot it started.`;
      } else {
        const token = bearer(req) ?? "";
        const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
        const took = await reverseAttachedQty(ctx.org.id, id, attached, who, {
          baseUrl,
          slug: ctx.org.slug,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        }).catch(() => null);
        note =
          attached.mode === "add-qty"
            ? took
              ? took.refused
                ? `${took.title}: ${took.refused}. Nothing was taken back.`
                : took.qty < Number(attached.qty_added ?? 0)
                  ? `Took the ${took.qty} back off ${took.title} (only that many were left).`
                  : `Took the ${took.qty} back off ${took.title}.`
              : "The existing entry it attached to was left untouched — undo the quantity bump there if needed."
            : "The existing entry it attached to was left untouched.";
      }
    } else if (row.target_entity_id && row.target_module && row.target_kind) {
      const kindKey = row.target_kind.includes(":")
        ? row.target_kind
        : `${row.target_module}:${row.target_kind}`;
      const existing = await platform()
        .entities.lookup(ctx.org.id, kindKey, row.target_entity_id)
        .catch(() => null);
      if (!existing) {
        note = "The created entry was already deleted.";
      } else if (row.target_entity_id === row.target_location_id) {
        // The record is the very place the scan was taken in: a scan put onto
        // the bin it was scanned into, from before Undo recorded whether the
        // scan made it. That bin was there first (and may hold things), so it
        // stays. Nothing a scan creates is ever its own location.
        note = `${existing.title} stays: it is the place this scan was taken in.`;
      } else {
        const writer = await platform().entities.getWriter(ctx.org.id, kindKey);
        if (!writer?.delete) {
          note = `The created entry couldn't be removed automatically — delete it from its own page (${existing.title}).`;
        } else {
          try {
            await writer.delete(ctx.org.id, row.target_entity_id);
            entityDeleted = true;
          } catch (err) {
            note = `The created entry couldn't be removed (${(err as Error).message}) — delete it from its own page.`;
          }
        }
      }
    }

    // If this line came off a receipt, its order line was born at parse and
    // stays: sending the item back only RELEASES the claim (part_id back to
    // NULL). This used to delete the line and then the order when it emptied,
    // which was right when confirm had created both; now the receipt is the
    // order's reason to exist, and undoing a filing is not un-reading it.
    const receiptOrderId = typeof meta.receipt_order_id === "string" ? meta.receipt_order_id : null;
    const receiptOrderItemId =
      typeof meta.receipt_order_item_id === "string" ? meta.receipt_order_item_id : null;
    if (receiptOrderId && receiptOrderItemId) {
      const token = bearer(req);
      if (token) {
        const released = await claimOrderLine({
          baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
          slug: ctx.org.slug,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          orderId: receiptOrderId,
          itemId: receiptOrderItemId,
          partId: null,
        });
        if (released) note = note ? `${note} Its line on the purchase order is unclaimed again.` : "Its line on the purchase order is unclaimed again.";
      }
    }
    // Ran out's list line comes off with it (#6526): Undo leaves nothing it added.
    if (meta[RAN_OUT_KEY]) {
      await withdrawRanOut(ctx.org.id, sessionUser(req)?.id ?? null, meta[RAN_OUT_KEY]).catch((e: Error) => {
        note = note ? `${note} Its shopping list line stayed (${e.message}).` : `Its shopping list line stayed (${e.message}).`;
      });
    }
    // Reopen: back to pending, resolution cleared, RESTORED to its original
    // spot — un-confirm is an UNDO, not a re-scan. created_at stays (it's when
    // the item was scanned, immutable history); rewriting it to now() dragged
    // the item's whole SESSION header time + sort position forward to the undo
    // moment (the session reads max(created_at) across its items). Only
    // updated_at moves. suggested_* stays — the point is to FIX + redo.
    const reopened = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "pending",
        target_module: null,
        target_kind: null,
        target_entity_id: null,
        resolved_at: null,
        // Unconfirm clears the attach link + the receipt-order linkage (the order
        // line is gone now) — DB-side delete of just those keys, leaving every
        // other pass's keys intact (this used to full-replace).
        // The receipt-order linkage STAYS: the order line is a fact about the
        // receipt, born at parse, and filing this row again must claim that
        // same line. Only the attach link is cleared.
        suggested_metadata: mergeMeta({}, ["attached_to", FILED_INTO_KEY, RAN_OUT_KEY]) as never,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendScanHistory(db, id, {
      action: "unconfirm",
      note: entityDeleted ? "commit reverted; created entry removed" : (note ?? "commit reverted"),
    });
    void platform().events.emit("core-scan.scan.unconfirmed", {
      orgId: ctx.org.id,
      itemId: id,
      entityDeleted,
    });
    res.json({ item: reopened, entity_deleted: entityDeleted, note });
  }),
);

// ─────────────────────── POST /inbox/:id/attach ─────────────────────
// Attach this scan to an entity the workspace ALREADY tracks, instead of
// creating a duplicate. Three modes (scan-parity-final-mile.md, Epic A):
//   add-qty      — "+N, more of the same": bump the kind's qty field by the
//                  item's quantity; append the scanned barcode when the entity
//                  lacks one; attach the item's photo when the entity has none.
//   link-barcode — write metadata.barcode only (teach an existing entity its
//                  barcode; the next scan matches instantly).
//   move         — set the entity's location_id (move mode's unit action).
//   merge-fields — "same one, fill in what this scan learned": write the scan's
//                  structured fields (a plate photo's license_plate/color, a
//                  VIN's make/model) onto the EXISTING entity, only where it's
//                  still blank. The unique-asset analogue of add-qty — you don't
//                  add a second car, you enrich the one you have.
// All writes go through the module's OWN HTTP endpoint under the caller's
// bearer (same inherited-capability pattern as confirm) — never raw SQL into
// another module's table. The inbox item resolves as "attached".
/** A record's number field as it came off its route: a numeric column is a
 *  string there, and an absent one is null. */
function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A count to a ten-thousandth at most: what a measured unit needs, and no
 *  float noise passed off as an amount. */
const atMostFourPlaces = (n: number) => Math.abs(Math.round(n * 10_000) - n * 10_000) < 1e-6;

const AttachBody = z.object({
  kind: z.string().min(1),
  entity_id: z.string().min(1),
  /** Instance slug when the entity lives in a skinned instance (the bare
   *  module route filters to the default instance and would 404). */
  instance: optionalField(z.string()),
  /** `replace`: the one you had ran out and this is its replacement. The
   *  count is SET to what was scanned rather than added to, and the ledger
   *  hears the old one consumed (or discarded, when `resolution` says it went
   *  bad) and the new one bought. The everyday re-buy, said in one tap; `+N`
   *  used to be the only door, and it counted the empty box as still there. */
  /** `add-place`: keep these at the scan's place as another place of the
   *  same item (its kind's holdAction). An `add-qty` at a place the item is
   *  not kept yet files this way too, decided here and not by the door. */
  mode: z.enum(["add-qty", "replace", "link-barcode", "move", "merge-fields", "count", "add-place"]),
  /** What this re-purchase means, for the consumption ledger. Only add-qty is
   *  a purchase ("+N, more of the same"); the other modes teach or move an
   *  entity and consume nothing.
   *
   *  `context` is the scan-time chip: a party-sized or stock-up buy must not
   *  train the rate as if it were your normal weekly shop.
   *
   *  `resolution` answers what happened to the stock you still had, which only
   *  a human can settle - the ledger cannot tell "I ate it faster" from "it
   *  went off" from "I just bought extra", and those imply opposite advice.
   *  Absent, nothing beyond the purchase is recorded, which is the honest
   *  default: silence beats a guess. */
  cadence: z
    .object({
      context: optionalField(z.enum(["normal", "faster", "bulk", "one_off"])),
      resolution: optionalField(z.enum(["over_buy", "consumed", "discarded"])),
    })
    .optional(),
  /** For mode=move: target location; defaults to the item's own
   *  target_location_id (the active bin it was scanned into). */
  location_id: optionalField(z.string()),
  /** How many were bought, for add-qty / replace, when the door says so (a
   *  File everything line, a queue's count); else the row's own. Absent from
   *  this schema, a door's count was stripped and the row's filed instead. */
  qty: FiledQuantity.optional(),
  /** With `count`: "I ran out of this" (#6526). Whatever the record holds is
   *  taken as used up (no change or total needed), and it goes on the
   *  shopping list (services/ran-out.ts). */
  ran_out: z.boolean().optional(),
  /** `count`: what is in your hands, signed (+3 arrived, -1 used up). The
   *  card's Change by. Exactly one of change / total. */
  // A measured record is counted in fractions of its unit (half a metre),
  // to a ten-thousandth; a counted one stays whole on the card (#6142).
  change: optionalField(z.number().finite().min(-1_000_000).max(1_000_000).refine(atMostFourPlaces, "at most four decimal places")),
  /** `count`: the count as it actually is, the card's Set total. Filed in
   *  the ledger as a correction, never as use or a purchase. */
  total: optionalField(z.number().finite().min(0).max(1_000_000).refine(atMostFourPlaces, "at most four decimal places")),
  /** `count`: why, for the ledger line. A chip on the card, never asked. */
  reason: optionalField(z.enum(SCAN_COUNT_REASONS)),
});

// AI-REACH: exempt — attaches the bytes of a file a person uploads with it;
// the assistant files paperwork it holds through core-scan:attach-paperwork
attachRouter.post(
  "/inbox/:id/attach",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const parsed = AttachBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    if (parsed.data.ran_out && parsed.data.mode !== "count") {
      res.status(400).json({ error: { code: "ran_out_is_a_count", message: "Ran out is a count: send mode count" } });
      return;
    }
    if (parsed.data.mode === "count" && !parsed.data.ran_out && !(parsed.data.total != null ? parsed.data.change == null : parsed.data.change != null && parsed.data.change !== 0)) {
      res.status(400).json({ error: { code: "count_needs_one", message: "a count is a non-zero change or a total, exactly one" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    // Only a PENDING item can attach: a resolved item was already committed or
    // attached — attaching again would double-count its quantity (found by the
    // golden e2e: confirm(1) + attach(+2) on the same dedup-bumped row → 3).
    if (row.status !== "pending") {
      res.status(409).json({
        error: { code: "already_resolved", message: "this item was already committed or attached" },
      });
      return;
    }
    const purpose = scanPurpose(row);
    const stockAction = parsed.data.mode === "add-qty" || parsed.data.mode === "replace" || parsed.data.mode === "add-place";
    const countAction = parsed.data.mode === "count";
    if (purpose !== "arrival" && (stockAction || ((purpose === "move" || purpose === "sort") && countAction))) {
      res.status(409).json({ error: { code: "not_an_arrival", message: scanPurposeReview(row) } });
      return;
    }

    // Paperwork for one thing is put on the record, never added to it as
    // another unit or merged field by field: the one paperwork door (#4633).
    if (isPaperworkRow(row as never)) {
      const result = await putPaperworkOn(req, row.id, { kind: parsed.data.kind, id: parsed.data.entity_id });
      if ("status" in result) res.status(result.status).json({ error: result.error });
      else res.json({ paperwork: result });
      return;
    }
    // ATOMIC CLAIM — the read-guard above has the same two-caller race as
    // confirm did, and attach's failure mode is worse: the target entity's
    // quantity gets bumped TWICE. CAS the status first; the loser takes the
    // same 409 before any entity mutation.
    const attachClaim = await db
      .updateTable("core_scan_inbox_items")
      .set({ status: "resolved", updated_at: new Date() })
      .where("id", "=", id ?? "")
      .where("status", "=", "pending")
      .returning(["id"])
      .executeTakeFirst();
    if (!attachClaim) {
      res.status(409).json({
        error: { code: "already_resolved", message: "this item was already committed or attached" },
      });
      return;
    }
    // Release the claim on any post-claim failure or validation bail (the
    // target_entity_id guard protects a stamped success) — same hook shape as
    // confirm's.
    res.once("finish", () => {
      if (res.statusCode < 400) return;
      // DETACHED: runs after a failed answer by design, putting the row back; there is no response left to wait
      void db
        .updateTable("core_scan_inbox_items")
        .set({ status: "pending", updated_at: new Date() })
        .where("id", "=", id ?? "")
        .where("status", "=", "resolved")
        .where("target_entity_id", "is", null)
        .execute()
        .catch(() => {});
    });
    // The match's kind is the kind the record LIVES under (`groceries:item`
    // for a Groceries table's milk); scannability belongs to its module and
    // the instance routes the write. Resolved in one place for every scan
    // route (services/scan-target.ts): a direct lookup on the request's kind
    // answered "groceries:item is not a scan target" on every re-buy button.
    const target = await scanTargetOf(ctx.org.id, parsed.data.kind, parsed.data.instance);
    if (!target) {
      res.status(400).json({
        error: { code: "not_scannable", message: `${parsed.data.kind} is not a scan target` },
      });
      return;
    }
    const { scannable, baseKind } = target;
    const instance = target.instance;
    // One item, a row per place. "+N more" of a thing scanned at a place it is
    // not kept yet is that place's row, never N more in the kitchen while the
    // bins are in the garage, and never a second item (#4552). Asked fresh of
    // the record, so every door that files a match (the card, File
    // everything, the queue) lands the same way.
    const placeAt = parsed.data.location_id ?? row.target_location_id ?? null;
    const newPlace =
      parsed.data.mode === "add-place" || parsed.data.mode === "add-qty"
        ? await newPlaceAt(ctx.org.id, parsed.data.kind, instance ?? null, parsed.data.entity_id, placeAt)
        : null;
    if (parsed.data.mode === "add-place" && !newPlace) {
      res.status(409).json({
        error: {
          code: "not_a_new_place",
          message: placeAt ? "It is already kept there. Add to that place's count instead." : "Say which place these are in.",
        },
      });
      return;
    }
    if (newPlace && scannable.holdAction && placeAt) {
      const qty = parsed.data.qty ?? filedQuantityOf(row.quantity);
      const held = (await platform().actions.invoke(scannable.holdAction, {
        orgId: ctx.org.id,
        userId: sessionUser(req)?.id ?? null,
        entity: { kind: parsed.data.kind, id: newPlace.card },
        event: {
          name: "core-scan.inbox.attach",
          payload: {},
          actor: { user_id: sessionUser(req)?.id ?? null, display_name: null, auth_method: "session" as const, api_token_id: null, api_token_name: null },
          timestamp: new Date().toISOString(),
          trigger_type: "user-invoked" as const,
        },
        args: { location_id: placeAt, qty },
      })) as { ok?: boolean; id?: string; card_id?: string; error?: string; message?: string } | null;
      if (!held?.ok || !held.id) {
        res.status(409).json({ error: { code: "hold_refused", message: held?.message ?? held?.error ?? "That place could not be added." } });
        return;
      }
      const [heldModule] = baseKind.split(":");
      const cardName = await platform()
        .entities.snapshot(ctx.org.id, parsed.data.kind, newPlace.card)
        .then((r) => (typeof r?.name === "string" ? r.name : typeof r?.title === "string" ? r.title : undefined))
        .catch(() => undefined);
      const resolvedPlace = await db
        .updateTable("core_scan_inbox_items")
        .set({
          status: "resolved",
          quantity: qty,
          target_module: heldModule ?? null,
          target_kind: parsed.data.kind,
          target_entity_id: held.id,
          suggested_metadata: mergeMeta({
            [FILED_INTO_KEY]: await filedIntoFor(req, heldModule ?? baseKind, instance ?? null, parsed.data.kind, { name: cardName }),
            attached_to: { kind: parsed.data.kind, id: held.id, ...(instance ? { instance } : {}), mode: "add-place", card_id: newPlace.card, location_id: placeAt },
          }) as never,
          resolved_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", id ?? "")
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendScanHistory(db, id ?? "", { action: "attached", note: `add-place → ${cardName ?? newPlace.card}` });
      void platform().events.emit("core-scan.scan.attached", { orgId: ctx.org.id, itemId: id, targetKind: parsed.data.kind, entityId: held.id, mode: "add-place" });
      // The last part of a split pack filed: what the pack held goes to the
      // barcode network, once, when this instance is connected (pack-network.ts).
      // DETACHED: a store fact sent to the shared network; this filing is complete without it
      void reportPackIfFiled(db, row.suggested_metadata, sessionUser(req)?.id ?? null).catch((e: Error) => console.warn("[core-scan] pack report:", e.message));
      const placeName = await platform()
        .entities.lookup(ctx.org.id, "core-locations:location", placeAt)
        .then((l) => l?.title ?? null)
        .catch(() => null);
      res.json({
        item: resolvedPlace,
        entity_title: cardName ?? null,
        new_qty: qty,
        prev_location_id: null,
        merged_fields: [],
        cadence_recorded: [],
        added_place: { id: held.id, card_id: newPlace.card, location_id: placeAt, location_name: placeName, qty },
      });
      return;
    }
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    // The entity's CRUD path: instance items live under /instances/:slug/items,
    // everything else under the module's own route (same rule confirm uses).
    const entityPath = instance
      ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${instance}/items/${parsed.data.entity_id}`
      : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${scannable.createEndpoint}/${parsed.data.entity_id}`;
    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    // Read the CURRENT entity through its own module (authoritative + fresh —
    // qty for the bump, metadata for the barcode merge, location for undo).
    const getRes = await apiFetch(entityPath, { headers: authHeaders });
    if (!getRes.ok) {
      res.status(getRes.status === 404 ? 404 : 502).json({
        error: { code: "entity_unreachable", message: `Target entity read returned ${getRes.status}` },
      });
      return;
    }
    const entity = (await getRes.json()) as Record<string, unknown>;
    const entityName = typeof entity.name === "string" ? entity.name : parsed.data.entity_id;
    const entityMeta = (entity.metadata ?? {}) as Record<string, unknown>;
    const prevLocationId = typeof entity.location_id === "string" ? entity.location_id : null;

    const patch: Record<string, unknown> = {};
    let newQty: number | null = null;
    let priorQty = 0;
    let qtyAdded = 0;
    /** The way back for the quantity moves, in undo order, from the door. */
    const undoSteps: NonNullable<QuantityMove["undo"]> = [];
    const mergedFields: string[] = [];
    const counting = parsed.data.mode === "count";
    if (counting && !scannable.qtyField) {
      res.status(400).json({ error: { code: "not_counted", message: `${parsed.data.kind} keeps no count` } });
      return;
    }
    if (parsed.data.mode === "add-qty" || parsed.data.mode === "replace" || counting) {
      // A kind without a native quantity (qtyField absent) has nothing to
      // bump — the attach still merges the barcode below.
      if (scannable.qtyField) {
        const cur = Number(entity[scannable.qtyField] ?? 0);
        // The ledger needs both, and the server already knows them - never take
        // a quantity from the client when the entity is authoritative. The
        // moves themselves run after the field PATCH below, so a record with
        // a fresh lot on it is never overwritten by a snapshot taken before
        // the lot existed, and a PATCH that fails leaves the count unmoved.
        priorQty = Number.isFinite(cur) ? cur : 0;
        qtyAdded = counting ? 0 : (parsed.data.qty ?? filedQuantityOf(row.quantity));
      }
      // Barcode-append: a scanned (not AI-read) code the entity doesn't have yet.
      const aiRead = isMachineReadCode(
        (row.suggested_metadata as { barcode_source?: string } | null)?.barcode_source,
      );
      if (row.barcode_text && !aiRead && !entityMeta.barcode) {
        // Only the key this adds: the record's PATCH merges it into the live
        // row, and a copy of the rest read a moment ago would write stale
        // values back over a concurrent edit (#3625).
        patch.metadata = { barcode: row.barcode_text };
      }
    } else if (parsed.data.mode === "link-barcode") {
      if (!row.barcode_text) {
        res.status(400).json({ error: { code: "no_barcode", message: "this item has no barcode to link" } });
        return;
      }
      patch.metadata = { barcode: row.barcode_text };
      // Linking a barcode while an active bin is set ALSO files
      // the entity into that bin — the scan meant "this thing, into here".
      const linkLoc = parsed.data.location_id ?? row.target_location_id;
      if (linkLoc) patch.location_id = linkLoc;
    } else if (parsed.data.mode === "merge-fields") {
      // "Same one — fill in what this scan learned." Take the SAME structured
      // values a confirm would write (native identity keys + the matchmaker's
      // per-instance custom fields), but write them onto the EXISTING entity,
      // and ONLY where it's still blank — enriching, never clobbering. So a
      // plate photo adds license_plate + color to a car the VIN scan created,
      // without touching the make/model/year it already knows.
      const scanMeta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
      const candidates = candidatesWithUserFields(
        storedCandidateList(row.suggested_candidates) as Array<{
          instance?: string | null;
          module?: string;
          fields?: Record<string, unknown>;
        }>,
        row.suggested_metadata,
      );
      const [candMod] = baseKind.split(":");
      const cand = instance
        ? candidates.find((c) => c.instance === instance)
        : (candidates.find((c) => !c.instance && c.module === candMod) ?? candidates[0]);
      const blank = (v: unknown) =>
        v === undefined || v === null || (typeof v === "string" && v.trim() === "");
      // Native identity columns the destination table declares.
      const nativeIn: Record<string, unknown> = {};
      if (row.suggested_manufacturer) nativeIn.manufacturer = row.suggested_manufacturer;
      if (typeof scanMeta.model === "string" && scanMeta.model) nativeIn.model = scanMeta.model;
      if (typeof scanMeta.serial_number === "string" && scanMeta.serial_number)
        nativeIn.serial_number = scanMeta.serial_number;
      for (const [k, v] of Object.entries(nativeIn)) {
        if (blank(v) || !blank(entity[k])) continue;
        patch[k] = v;
        mergedFields.push(k);
      }
      // Custom fields (metadata): matchmaker candidate + any resolver-stamped
      // fields, plus a real scanned barcode/sku for future catalog re-match.
      const metaIn: Record<string, unknown> = {
        ...((scanMeta.fields as Record<string, unknown> | undefined) ?? {}),
        ...(cand?.fields ?? {}),
      };
      const aiRead = isMachineReadCode((scanMeta as { barcode_source?: string }).barcode_source);
      if (row.barcode_text && !aiRead) metaIn.barcode = row.barcode_text;
      if (row.suggested_sku) metaIn.sku = row.suggested_sku;
      // The same evidence rule as the confirm door (scan-evidence.ts,
      // evidencedFill): "same one, fill it in" never writes an identifier
      // the item gives no evidence for onto a record that has none (#3647).
      for (const k of evidencedFill(row, { ...nativeIn, ...metaIn }).held) {
        delete metaIn[k];
        if (k in patch && mergedFields.includes(k)) {
          delete patch[k];
          mergedFields.splice(mergedFields.indexOf(k), 1);
        }
      }
      // Only the keys this fills: the record's PATCH merges them (#3625).
      const nextMeta: Record<string, unknown> = {};
      let metaChanged = false;
      for (const [k, v] of Object.entries(metaIn)) {
        if (blank(v) || !blank(entityMeta[k])) continue;
        nextMeta[k] = v;
        metaChanged = true;
        mergedFields.push(k);
      }
      if (metaChanged) patch.metadata = nextMeta;
    } else {
      const loc = parsed.data.location_id ?? row.target_location_id;
      if (!loc) {
        res.status(400).json({
          error: { code: "no_location", message: "no target location. Set an active bin or pass location_id" },
        });
        return;
      }
      patch.location_id = loc;
    }

    // merge-fields with nothing new to add still counts as "yes, same one" —
    // the item resolves as attached, we just skip an empty PATCH.
    if (Object.keys(patch).length > 0) {
      const patchRes = await apiFetch(entityPath, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify(patch),
      });
      if (!patchRes.ok) {
        const errText = await patchRes.text();
        let targetMsg: string | undefined;
        try {
          targetMsg = (JSON.parse(errText) as { error?: { message?: string } }).error?.message;
        } catch {
          /* non-JSON */
        }
        res.status(patchRes.status).json({
          error: { code: "attach_failed", message: targetMsg ?? `Target update returned ${patchRes.status}`, details: errText },
        });
        return;
      }
    }

    if ((parsed.data.mode === "add-qty" || parsed.data.mode === "replace") && scannable.qtyField && qtyAdded > 0) {
      // A scan attach is a PURCHASE, so it restocks the way a check-off does:
      // through the record's own quantity door (services/scan-target.ts),
      // where the fresh lot dated today, the bought-on and expiry stamps and
      // the floor live. It used to be a PATCH of the count, and the milk you
      // just scanned kept last week's dates (2026-09-12). The door hands the
      // action's own inverse back, kept beside this item for its undo.
      // Replace: the old one is gone first (nothing to take on an empty
      // shelf: the floor would refuse, so that leg is skipped), then the
      // new one arrives; the ledger hears the old one consumed or discarded
      // through buildCadenceEvents below, as before.
      const doorCtx = { baseUrl, slug: ctx.org.slug, headers: authHeaders };
      const who = sessionUser(req)?.id ?? null;
      const source = { kind: "core-scan:inbox", id: id ?? "" };
      const entityRef = { kind: parsed.data.kind, id: parsed.data.entity_id };
      let current = priorQty;
      if (parsed.data.mode === "replace" && priorQty > 0) {
        const gone = await moveQuantity(ctx.org.id, target, entityRef, -priorQty, {
          userId: who,
          reason: parsed.data.cadence?.resolution === "discarded" ? "replaced: the old one went bad" : "replaced: the old one was used up",
          source,
          door: doorCtx,
          current,
        });
        if (!gone.ok) {
          res.status(409).json({ error: { code: "attach_failed", message: gone.refused ?? "the record's quantity could not be changed" } });
          return;
        }
        current = gone.newQty ?? current + gone.delta;
        if (gone.undo) undoSteps.unshift(...gone.undo);
      }
      const arrived = await moveQuantity(ctx.org.id, target, entityRef, qtyAdded, {
        userId: who,
        reason: parsed.data.mode === "replace" ? "replaced, the new one arrived (scan)" : "restocked from a scan",
        restock: true,
        // The batches its boxes printed, kept as lots on the record (#5764).
        lots: await rowLots(db, row, qtyAdded).catch(() => []),
        source,
        door: doorCtx,
        current,
      });
      if (!arrived.ok) {
        res.status(502).json({ error: { code: "attach_failed", message: arrived.refused ?? "the record's quantity could not be changed" } });
        return;
      }
      newQty = arrived.newQty ?? current + arrived.delta;
      if (arrived.undo) undoSteps.unshift(...arrived.undo);
    }

    // `count`: the change in your hands, or the total as it really is,
    // through the same quantity door. A total is a correction in the ledger.
    let counted = 0;
    const correction = counting && !parsed.data.ran_out && parsed.data.total != null;
    let ranOutDone: RanOutOutcome | null = null;
    if (counting && scannable.qtyField && parsed.data.ran_out) {
      // Ran out: what the shelf holds is taken as used up, then the list.
      ranOutDone = await ranOut({
        orgId: ctx.org.id,
        userId: sessionUser(req)?.id ?? null,
        target,
        entity: { kind: parsed.data.kind, id: parsed.data.entity_id },
        current: priorQty,
        rowId: id ?? "",
        door: { baseUrl, slug: ctx.org.slug, headers: authHeaders },
      });
      if (ranOutDone.move && !ranOutDone.move.ok) {
        res.status(409).json({ error: { code: "attach_failed", message: ranOutDone.move.refused ?? "the record's quantity could not be changed" } });
        return;
      }
      counted = ranOutDone.move?.delta ?? 0;
      newQty = ranOutDone.move ? (ranOutDone.move.newQty ?? priorQty + ranOutDone.move.delta) : priorQty;
      if (ranOutDone.move?.undo) undoSteps.unshift(...ranOutDone.move.undo);
    } else if (counting && scannable.qtyField) {
      const want = correction ? parsed.data.total! - priorQty : (parsed.data.change ?? 0);
      newQty = priorQty;
      if (want !== 0) {
        const moved = await moveQuantity(ctx.org.id, target, { kind: parsed.data.kind, id: parsed.data.entity_id }, want, {
          userId: sessionUser(req)?.id ?? null,
          reason: scanCountLedgerReason({ change: want, correction, reason: parsed.data.reason ?? null }),
          ...(want > 0 && !correction ? { restock: true } : {}),
          ...(correction ? { correction: true } : {}),
          source: { kind: "core-scan:inbox", id: id ?? "" },
          door: { baseUrl, slug: ctx.org.slug, headers: authHeaders },
          current: priorQty,
        });
        if (!moved.ok) {
          res.status(409).json({ error: { code: "attach_failed", message: moved.refused ?? "the record's quantity could not be changed" } });
          return;
        }
        counted = moved.delta;
        newQty = moved.newQty ?? priorQty + moved.delta;
        if (moved.undo) undoSteps.unshift(...moved.undo);
      }
    }

    const photoId = attachPhotoFileId(row, parsed.data.mode, entity.image_path);
    if (photoId) {
      // Both halves from one split. This used to hand-roll it and pass the
      // WHOLE kind as source_type, so the row was written "inventory:part"
      // while every reader queries "part" - orphaned on write, and invisible
      // because the PATCH below sets image_path regardless.
      const { module, type } = splitEntityKind(baseKind);
      // Awaited: the record should show the picture when the person opens it.
      await platform()
        .files.attach(ctx.org.id, {
          fileId: photoId,
          source_module: module,
          source_type: type,
          source_id: parsed.data.entity_id,
          role: "gallery",
        })
        .then(() =>
          apiFetch(entityPath, {
            method: "PATCH",
            headers: authHeaders,
            body: JSON.stringify({
              image_path: `/api/v1/orgs/${ctx.org.slug}/modules/core-files/files/${photoId}/raw`,
            }),
          }),
        )
        .catch((err) => console.error("[core-scan] attach photo failed:", (err as Error).message));
    }

    // Resolve the inbox item as "attached" (history + metadata carry the ref).
    // The owning MODULE, from the module's kind: an instance kind's prefix is
    // the instance, not a module.
    const [module] = baseKind.split(":");
    const resolvedRow = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        // The row says what was filed: the door's count when it gave one.
        ...(parsed.data.qty != null && (parsed.data.mode === "add-qty" || parsed.data.mode === "replace") ? { quantity: parsed.data.qty } : {}),
        target_module: module ?? null,
        target_kind: parsed.data.kind,
        target_entity_id: parsed.data.entity_id,
        suggested_metadata: mergeMeta({
          // Where it went, as the commit records it (#3620).
          [FILED_INTO_KEY]: await filedIntoFor(req, module ?? baseKind, instance ?? null, parsed.data.kind, {
            // Filed INTO a record that already existed: its own name.
            name: await platform()
              .entities.snapshot(ctx.org.id, parsed.data.kind, parsed.data.entity_id)
              .then((r) => (typeof r?.name === "string" ? r.name : typeof r?.title === "string" ? r.title : undefined))
              .catch(() => undefined),
          }),
          attached_to: {
            kind: parsed.data.kind,
            id: parsed.data.entity_id,
            ...(instance ? { instance } : {}),
            mode: parsed.data.mode,
            // What the bump was, so unconfirm can take exactly it back off.
            ...(qtyAdded > 0 && scannable.qtyField ? { qty_added: qtyAdded, qty_field: scannable.qtyField, qty_after: newQty } : {}),
            ...(counting && scannable.qtyField ? { qty_changed: counted, qty_field: scannable.qtyField, qty_after: newQty, ...(correction ? { correction: true } : {}) } : {}),
            // The action's own inverse (the record as it was, lot and all),
            // run by unconfirm while the record still reads what this left.
            ...(undoSteps.length ? { undo: undoSteps } : {}),
          },
          // Ran out's list line, which Undo takes back off.
          ...(ranOutDone ? { [RAN_OUT_KEY]: ranOutDone.stamp } : {}),
        }) as never,
        resolved_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id ?? "")
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendScanHistory(db, id ?? "", {
      action: "attached",
      note: `${parsed.data.mode} → ${entityName}`,
    });
    void platform().events.emit("core-scan.scan.attached", {
      orgId: ctx.org.id,
      itemId: id,
      targetKind: parsed.data.kind,
      entityId: parsed.data.entity_id,
      mode: parsed.data.mode,
    });
    // The last part of a split pack filed: what the pack held goes to the
    // barcode network, once, when this instance is connected (pack-network.ts).
    // DETACHED: a store fact sent to the shared network; this filing is complete without it
    void reportPackIfFiled(db, row.suggested_metadata, sessionUser(req)?.id ?? null).catch((e: Error) => console.warn("[core-scan] pack report:", e.message));

    // File the purchase in the consumption ledger by ANNOUNCING it. core-scan
    // does not know who keeps the ledger, or whether anyone does: the ledger
    // is opt-in, and a workspace without one simply has no subscriber. A scan
    // can never fail because a workspace does not track cadence - emit()
    // never rejects, and the subscriber swallows its own failures.
    const cadenceEvents = buildCadenceEvents({
      mode: parsed.data.mode,
      cadence: parsed.data.cadence && { context: parsed.data.cadence.context ?? undefined, resolution: parsed.data.cadence.resolution ?? undefined },
      kind: baseKind,
      entityId: parsed.data.entity_id,
      added: counting ? counted : qtyAdded,
      priorQty: priorQty,
      ...(counting ? { correction, reason: ranOutDone ? "used_up" : (parsed.data.reason ?? null) } : {}),
    });
    for (const ev of cadenceEvents) {
      await platform().events.emit("core-scan.stock.observed", {
        orgId: ctx.org.id,
        userId: sessionUser(req)?.id ?? null,
        // Named after the item, so an undo can ask the ledger to forget it.
        source_ref: inboxSourceRef(id ?? ""),
        ...ev,
      });
    }

    res.json({
      item: resolvedRow,
      entity_title: entityName,
      new_qty: newQty,
      prev_location_id: prevLocationId,
      merged_fields: mergedFields,
      cadence_recorded: cadenceEvents.map((e) => e.event_type),
      // A take (or a recount down) that left it at its minimum or empty: the
      // card offers the shopping list.
      // Ran out put it on the list already, so the card offers it no second time.
      ...(counting ? { low: !ranOutDone?.on_list && scanCountLeftLow(newQty, numOrNull(entity.min_qty), newQty != null && newQty < priorQty) } : {}),
      ...(ranOutDone ? { ran_out: { took: ranOutDone.took, on_list: ranOutDone.on_list, needs_list: ranOutDone.needs_list, note: ranOutDone.list_note } } : {}),
    });
  }),
);

// ─────────────────── GET /bin/:locationId/contents ──────────────────
// What lives in this bin, across the scannable kinds. `single: true` = the
// bin holds exactly ONE SKU (a bin of M3 screws with only the bin labeled) —
// the scanner then offers direct qty adjust instead of the filing flow.
attachRouter.get(
  "/bin/:locationId/contents",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const ctx = tenantContext(req);
    res.json(await findBinContents(ctx.org.id, req.params.locationId ?? ""));
  }),
);

// ─────────────────── POST /bin/:locationId/adjust ───────────────────
// "Adding 10 of this item / removing 5" — adjust the SKU that lives in this
// bin, straight from its QR label. Bin-scoped by construction: the entity must
// still CALL this bin home (409 if it moved since the contents read). The
// write goes through the module's OWN endpoint under the caller's bearer, the
// same inherited-capability pattern confirm/attach use. Clamped at zero.
const BinAdjustBody = z.object({
  kind: z.string().min(1),
  entity_id: z.string().min(1),
  instance: optionalField(z.string()),
  /** Signed change (+10 / −5) … */
  delta: z.number().int().min(-100_000).max(100_000).optional(), // none-refused-ok: a column that cannot hold null
  /** … or an absolute recount. Exactly one of delta/set. */
  set: optionalField(z.number().int().min(0).max(1_000_000)),
});
// AI-REACH: exempt — a count taken at a bin with the scanner in hand; the
// assistant changes how many through the record's own update
attachRouter.post(
  "/bin/:locationId/adjust",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = BinAdjustBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    if ((parsed.data.delta == null) === (parsed.data.set == null)) {
      res.status(400).json({ error: { code: "delta_or_set", message: "pass exactly one of delta / set" } });
      return;
    }
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const target = await scanTargetOf(ctx.org.id, parsed.data.kind, parsed.data.instance);
    if (!target) {
      res.status(400).json({ error: { code: "not_scannable", message: `${parsed.data.kind} is not a scan target` } });
      return;
    }
    const { scannable, instance } = target;
    const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    const entityPath = instance
      ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${instance}/items/${parsed.data.entity_id}`
      : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${scannable.createEndpoint}/${parsed.data.entity_id}`;
    const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const getRes = await apiFetch(entityPath, { headers: authHeaders });
    if (!getRes.ok) {
      res.status(getRes.status === 404 ? 404 : 502).json({
        error: { code: "entity_unreachable", message: `Entity read returned ${getRes.status}` },
      });
      return;
    }
    const entity = (await getRes.json()) as Record<string, unknown>;
    if (entity.location_id !== req.params.locationId) {
      res.status(409).json({
        error: { code: "moved", message: "This item no longer lives in that bin, rescan the label." },
      });
      return;
    }
    const qtyField = scannable.qtyField;
    if (!qtyField) {
      res.status(400).json({
        error: { code: "no_qty", message: `${withArticle(scannable.noun).replace(/^a/, "A")} has no quantity to adjust.` },
      });
      return;
    }
    const cur = Number(entity[qtyField] ?? 0);
    const oldQty = Number.isFinite(cur) ? cur : 0;
    // A recount is a delta from what is there. Through the one quantity door
    // (services/scan-target.ts): the record's adjust action, with its floor
    // and ledger, else its module route. Nothing to move is not an error.
    const delta = parsed.data.set != null ? parsed.data.set - oldQty : (parsed.data.delta ?? 0);
    let newQty = oldQty;
    if (delta !== 0) {
      const moved = await moveQuantity(
        ctx.org.id,
        target,
        { kind: parsed.data.kind, id: parsed.data.entity_id },
        delta,
        {
          userId: sessionUser(req)?.id ?? null,
          reason: parsed.data.set != null ? "recounted from the bin label" : delta > 0 ? "added from the bin label" : "removed from the bin label",
          ...(delta > 0 && parsed.data.set == null ? { restock: true } : {}),
          ...(parsed.data.set != null ? { correction: true } : {}),
          source: { kind: "core-locations:location", id: req.params.locationId ?? "" },
          door: { baseUrl, slug: ctx.org.slug, headers: authHeaders },
          current: oldQty,
        },
      );
      if (!moved.ok) {
        res.status(409).json({ error: { code: "adjust_failed", message: moved.refused ?? "the record's quantity could not be changed" } });
        return;
      }
      newQty = moved.newQty ?? oldQty + moved.delta;
    }
    res.json({
      entity_title: typeof entity.name === "string" ? entity.name : parsed.data.entity_id,
      old_qty: oldQty,
      new_qty: newQty,
    });
  }),
);

/** Run vision corroboration + the matchmaker for one item and persist the
 *  result (+ a matched_at stamp so intake auto-match never repeats). Returns
 *  the candidates, or null when skipped (no row / nothing identified yet /
 *  already matched / another match in flight). */
/** The row's stored candidate list, as a plain array.
 *
 *  This is a replay's INPUT, which is the whole shift: a replay used to re-ask
 *  the AI (cache-only) and merge the leftovers back in, so it needed a
 *  field-by-field carry-forward to stop a degraded answer erasing what a vision
 *  pass had found. Now the stored list IS what gets refined, so there is nothing
 *  to carry and nothing to lose.
 *
 *  jsonb reaches us as a parsed array under `pg`, but a `JSON.stringify`'d write
 *  read straight back can arrive as a string, so accept both. */
/** The identity a stored row carries: its top candidate's fields, or null. */
function topCandidateFields(raw: unknown): Record<string, unknown> | null {
  const top = storedCandidateList(raw)[0] as { fields?: Record<string, unknown> } | undefined;
  return top?.fields ?? null;
}
