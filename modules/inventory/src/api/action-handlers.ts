import { assertStorageReady } from "./storage.js";
import { PART_EDITABLE_KEYS, updatePartFields } from "./update-fields.js";
import { recordName } from "@cobblr/platform-contract/record-name";
import { readRecordDisposition } from "@cobblr/platform-contract/disposition";
import { stockTrackerAllows } from "../stock-tracker.js";
// Action handlers — the wire-engine-callable + Tier-B-invokable side of
// inventory. All GENERIC inventory capabilities (a use-case lives in a bundle +
// its app, never here):
//   - inventory.adjust-stock — wire/HTTP stock mutation; re-emits stock.changed.
//   - inventory.set-status    — set a part's metadata.status.
//   - inventory.create-item   — create one item (name + fields + location/…).
//   - inventory.create-items  — bulk create N items in one INSERT; returns ids.
//   - inventory.update-item   — set name/brand/location + MERGE metadata fields.
// (The Lego kit→parts expansion that used to live here moved to the Lego domain
//  module, bricklink-connector — it drives create-items + update-item.)

import { sql, type Kysely, type Transaction } from "kysely";
import { ActionRefusal, columnSet, isActionRefusal, platform, quantityWithUnit, requireActionEntity, type ActionInvokeContext } from "@cobblr/platform-contract";
import type { ActionUndoStep } from "@cobblr/platform-contract/action-undo";
import { statedQuantity } from "@cobblr/platform-contract/stated-quantity";
import type { InventoryDB } from "../db.js";
import { logPartCreated } from "./part-created.js";
import { recordConsumption } from "./stock-ledger.js";
import { stockMoved } from "./stock-moved.js";
import { reserveAllocation, settleAllocation } from "./allocations.js";
import {
  estimateShelfLife,
  recordObservation,
  isConfident,
  type LifecycleObservation,
} from "../shelf-life-learning.js";
import {
  batchesFrom,
  addBatch,
  arrivingLotsOf,
  type ArrivingLot,
  consumeOldest,
  consumeLot,
  lotIs,
  lotPickOf,
  type LotPick,
  reconcileToQty,
  visibleFrom,
  expiryFor,
  type Batch,
} from "../batches.js";
import { observation, swapFreshObservations, type StockObservation } from "../observations.js";
import { arrivedToday, freshLotStamps, shelfLifeDaysOf, startsFreshLot } from "../fresh-lot.js";
import { BELOW_ZERO, NOTHING_ON_HAND, floorDelta } from "../stock-floor.js";
import { dayIn } from "@cobblr/platform-contract/day";
import { stillGoodPatch } from "../still-good.js";
import { stateWrite, type StateFieldDef } from "../state-write.js";

/** The day it is for the person doing this: the zone their client sent, else
 *  what the platform knows of them (accounts.dayFor: the zone they told us,
 *  else the day that has arrived everywhere). The SAME rule the shopping row's
 *  promised date uses, so a lot is stamped with the day the row promised. It
 *  used to fall back to the UTC day when no zone was sent, so the row said one
 *  day and the check-off stamped the next, from 00:00 to 12:00 UTC. */
async function personToday(userId: string | null | undefined, timezone: string | undefined): Promise<string> {
  if (timezone) return dayIn(new Date(), timezone);
  return platform().accounts.dayFor(userId ?? null);
}

let registered = false;

/** Tell whoever keeps a consumption ledger what a tap MEANT (observations.ts).
 *  Announced, not called: emit() never rejects, and a workspace without a
 *  ledger hears nothing. Only after the stock change actually happened; an
 *  externally tracked item that skipped the change announces nothing. */
/**
 * Does this record go off?
 *
 * The one question the merged verbs ask. "Used up" ends a lot on a perishable
 * and empties a bin otherwise; "Replaced" swaps a fresh lot in or stamps a
 * spare. Read off the record's own metadata, not the table's configuration,
 * because that is what the lot bookkeeping itself reads: an expiry date, lots
 * dated on arrival, or a shelf life it has learned or been given.
 */
export function isPerishable(metadata: unknown): boolean {
  const md = (metadata as Record<string, unknown> | null) ?? {};
  if (typeof md.expires_on === "string" && md.expires_on) return true;
  if (Array.isArray(md.batches) && md.batches.length > 0) return true;
  if (shelfLifeDaysOf(md.shelf_life_days) !== null) return true;
  return false;
}

/** A note given with a use, cleaned to one line the statement can show. */
export function useNoteOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 280) : null;
}

/** A history line for a one-tap change, so the feed says who took one and
 *  how ("Alex took one of Toilet paper · via label 'Bathroom'", #3897). The
 *  via comes from the request, never from here. */
async function logTap(orgId: string, userId: string | null | undefined, action: "part_used" | "part_restocked", applied: Record<string, unknown>): Promise<void> {
  if (applied.ok !== true || applied.skipped || typeof applied.partId !== "string") return;
  await platform()
    .activity.log({
      orgId,
      userId: userId ?? null,
      action,
      ref: { module: "inventory", entityType: "part", entityId: applied.partId },
      diff: { delta: applied.delta ?? null, qty: applied.newQty ?? applied.qty ?? null },
    })
    .catch(() => undefined);
}

async function announce(orgId: string, userId: string | null | undefined, applied: Record<string, unknown>, obs: StockObservation[]): Promise<void> {
  if (applied.ok !== true || applied.skipped) return;
  for (const o of obs) {
    await platform().events.emit("inventory.stock.observed", { orgId, userId: userId ?? null, ...o });
  }
}

interface StockDraw {
  partId: string;
  quantity: number;
  optional: boolean;
}

interface AdjustStockPayload {
  operationId?: string;
  operationKey?: string;
  /** All required draws succeed together, or none of the stock moves. */
  draws?: StockDraw[];
  partId?: string;
  delta?: number;
  reason?: string;
  /** The delta is stock that ARRIVED (a purchase): a lot dated today, whatever
   *  was on the shelf. The check-off wires set it; so does the record's own
   *  Restock button. See fresh-lot.ts. */
  restock?: boolean;
  /** Of the units arriving, how many carry which lot number, as their
   *  boxes printed it ([{lot, qty}]); the rest arrive with none. */
  lots?: unknown;
  timezone?: string;
  // Optional source attribution for the consumption ledger — e.g. the wire
  // fired by digifab.print.completed passes sourceKind:"digifab:job" + the job id.
  sourceKind?: string;
  sourceId?: string;
  /** The unit `delta` is measured in ("g" for a print's filament). Taken off
   *  a thing kept in another unit (a spool in kg) it is converted first; a
   *  unit that does not convert (grams off a thing counted "each") is not
   *  applied at all, never read as that many of the thing's own unit. */
  unit?: string;
  /** The event happens once per source (a print draws on a spool once): a
   *  second delivery for the same thing, source and direction changes
   *  nothing. */
  once?: boolean;
  /** The source can take what it did back (a shopping line unticked), so a
   *  `once` repeat is judged on what it has done net: one that follows its own
   *  reversal is a fresh application, where a print's refund is never made
   *  twice. */
  reversible?: boolean;
  /** Take back what this source has added, net, whatever it was: a shopping
   *  line unticked. Judged on the ledger inside the same transaction. */
  takeBack?: boolean;
  /** The delta sets the count to what is actually there (a recount): the
   *  ledger line is a correction, never consumption or a purchase. */
  correction?: boolean;
}

const MEASURED = new Set(["mass", "length", "volume", "area"]);

/** Refuse "one" of a thing kept in a measured unit (kg, m, L). */
async function refuseOneOfMeasured(orgId: string, partId: string): Promise<void> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
  const row = await db.selectFrom("inventory_parts").select(["name", "unit"]).where("id", "=", partId).executeTakeFirst();
  const unit = (row?.unit as string | null | undefined)?.trim();
  if (!unit || unit.toLowerCase() === "each") return;
  const info = await platform().units.resolve(orgId, unit);
  if (info && MEASURED.has(info.category)) {
    throw new ActionRefusal(`${row?.name ?? "This"} is kept in ${info.symbol || unit}, so "one" would be a whole ${info.name}. Say how much was used instead.`);
  }
}

/** Has this source already moved this thing in this direction? */
/** What this source has already done to the count, net. */
export async function appliedBySource(orgId: string, partId: string, sourceKind: string, sourceId: string, on?: Kysely<InventoryDB>): Promise<number> {
  const db = on ?? ((await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>);
  const row = await db
    .selectFrom("inventory_consumption")
    .select(sql<string>`coalesce(sum(delta::numeric), 0)`.as("net"))
    .where("part_id", "=", partId)
    .where("source_kind", "=", sourceKind)
    .where("source_id", "=", sourceId)
    .executeTakeFirst();
  return Number(row?.net ?? 0);
}

async function alreadyApplied(orgId: string, partId: string, sourceKind: string, sourceId: string, delta: number, reversible: boolean, on?: Kysely<InventoryDB>): Promise<boolean> {
  if (reversible) return Math.sign(await appliedBySource(orgId, partId, sourceKind, sourceId, on)) === Math.sign(delta);
  const db = on ?? ((await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>);
  const row = await db
    .selectFrom("inventory_consumption")
    .select(["part_id"])
    .where("part_id", "=", partId)
    .where("source_kind", "=", sourceKind)
    .where("source_id", "=", sourceId)
    .where(sql<boolean>`sign(delta::numeric) = ${Math.sign(delta)}`)
    .executeTakeFirst();
  return !!row;
}

/** `delta` in the thing's own unit. A 40 g print taken off a spool kept in
 *  kg is 0.04, never 40 (40 took a whole spool to zero). A thing in a unit
 *  the stated one does not convert to is left alone. */
async function inPartUnit(orgId: string, partId: string, delta: number, unit: string | undefined): Promise<{ ok: true; delta: number } | { ok: false; reason: string }> {
  if (!unit?.trim()) return { ok: true, delta };
  const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
  const row = await db.selectFrom("inventory_parts").select(["unit"]).where("id", "=", partId).executeTakeFirst();
  const own = (row?.unit as string | null | undefined)?.trim();
  // "each" is the column's default, not a unit anyone chose: the number is
  // taken as it comes, as it always was.
  if (!own || own.toLowerCase() === "each" || own.toLowerCase() === unit.trim().toLowerCase()) return { ok: true, delta };
  const converted = await platform().units.convert(orgId, delta, unit, own);
  if (converted == null || !Number.isFinite(converted)) return { ok: false, reason: `${unit} does not convert to ${own}` };
  return { ok: true, delta: Math.round(converted * 1e6) / 1e6 };
}

/** A record marked gone (sold, lost, cleared by a stocktake: its
 *  disposition) is not on hand: what it held is history, kept for Undo, and
 *  no use or restock moves it (#6153). Bringing it back is the way to stock
 *  it again. Not `archived` alone: a split-off open ball is archived to keep
 *  it out of the lists and still holds the yarn on it. */
export function isGone(metadata: unknown): boolean {
  return readRecordDisposition(metadata) !== null;
}
export function goneStockRefusal(name: string | null | undefined): string {
  return `${name || "This record"} is marked gone, so it has nothing on hand. Bring it back before changing its stock.`;
}

const NO_SUCH_LOT = "That lot is not there any more. Refresh the list and try again.";

/** The core stock-delta path, shared by adjust-stock (wire/HTTP) and the
 *  one-tap consume actions (use-one/use-up). Applies the delta, writes the
 *  consumption ledger, re-emits stock.changed, and fires stock.low on a
 *  decrease at/below min_qty — so every consumption route trips the same
 *  "running low → shopping list" wire. Honours the tracked_by external-tracker
 *  opt-out. A non-zero `delta` is assumed (callers guard). */
export async function applyStockDelta(
  orgId: string,
  p: { partId: string; delta: number; reason: string; sourceKind?: string | null; sourceId?: string | null; correction?: boolean; reporter?: "firmware"; operationKey?: string; operationId?: string },
): Promise<Record<string, unknown>> {
  const { delta } = p;
  if (p.operationKey !== undefined && (typeof p.operationKey !== "string" || !p.operationKey.trim() || p.operationKey.length > 200 || delta >= 0)) {
    throw new ActionRefusal("A stock draw receipt needs a key of at most 200 characters and a negative quantity.");
  }
  const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
  const movement = await db.transaction().execute((trx) => stockDeltaIn(trx, orgId, p));
  return afterStockDelta(db, orgId, p.reason, movement);
}

type StockMovement = Record<string, unknown> & { updated?: { id: string; name: string; qty: unknown; min_qty: unknown }; applied?: number; requested?: number; verdict?: { kind: string; note?: string } };

/** The stock write itself, on the caller's transaction: the row lock, the
 *  floor, the new count and its ledger line. Nothing here may reach for a
 *  second connection: a caller holding this transaction and waiting on the
 *  pool is how a small pool deadlocks. */
export async function stockDeltaIn(
  trx: Transaction<InventoryDB>,
  orgId: string,
  p: { partId: string; delta: number; reason: string; sourceKind?: string | null; sourceId?: string | null; correction?: boolean; reporter?: "firmware"; operationKey?: string; operationId?: string; exact?: boolean; optional?: boolean },
): Promise<StockMovement> {
  const { partId, delta, reason } = p;
  // Externally-tracked stock (e.g. a Spoolman spool, metadata.tracked_by): the
  // external system counts usage and Cobblr mirrors it on sync — mutating here
  // too would double-count. Generic — any external tracker opts a part out.
  const ext = await trx
    .selectFrom("inventory_parts")
    .select([sql<string | null>`metadata->>'tracked_by'`.as("tracked_by"), "qty", "metadata", "name"])
    .where("id", "=", partId)
    .forUpdate().executeTakeFirst();
  if (!ext) return { ok: false, error: "part_not_found", final: true };
  if (p.operationId) {
    const already = await trx.selectFrom("inventory_stock_operations").select("operation_id")
      .where("operation_id", "=", p.operationId).where("part_id", "=", partId).executeTakeFirst();
    if (already) return { ok: true, skipped: true, deliverySatisfied: true, reason: "operation already applied", newQty: Number(ext.qty) };
  }
  if (p.operationKey) {
    const prior = await trx.selectFrom("inventory_consumption").select(["delta", "source_kind", "source_id"])
      .where("part_id", "=", partId).where("operation_key", "=", p.operationKey).executeTakeFirst();
    if (prior) {
      if (prior.source_kind !== (p.sourceKind ?? null) || prior.source_id !== (p.sourceId ?? null)) throw new ActionRefusal("Stock operation belongs to another source");
      return { ok: true, partId, delta: Number(prior.delta), replayed: true };
    }
  }
  if (isGone(ext.metadata)) return { ok: false, error: goneStockRefusal(ext.name), final: true };
  if (!stockTrackerAllows(ext.tracked_by, p.reporter)) {
    return { ok: true, skipped: true, deliverySatisfied: true, reason: `externally tracked by ${ext.tracked_by}` };
  }

  if (delta < 0 && !p.correction) {
    try {
      await assertStorageReady(trx, orgId, partId);
    } catch (error) {
      if (p.optional && isActionRefusal(error)) return { ok: false, error: error.message };
      throw error;
    }
  }

  // The floor. A decrement on an empty record is refused with the one
  // sentence every surface shows; one larger than what is on hand takes what
  // is there and says so. Applied here, at the write, so use-one, use-up,
  // mark-spoiled and a wire's negative delta all inherit it (stock-floor.ts).
  const verdict = floorDelta(Number(ext.qty), delta);
  if (verdict.kind === "refuse") {
    return { ok: false, error: verdict.error, partId, delta: 0, newQty: Math.max(0, Number(ext.qty)) };
  }
  if (p.exact && verdict.applied !== delta) {
    throw new ActionRefusal(`Not enough ${ext.name} in stock for the required draw.`);
  }
  const applied = verdict.applied;

  if (p.operationId) {
    // check-then-insert: the part row is locked before the operation lookup, serializing writers for this stock.
    await trx.insertInto("inventory_stock_operations").values({ operation_id: p.operationId, part_id: partId }).execute();
  }
  const updated = await trx
    .updateTable("inventory_parts")
    .set({ qty: sql<string>`greatest(0, qty + ${applied}::numeric)`, updated_at: new Date() })
    .where("id", "=", partId)
    .where(sql<boolean>`coalesce(metadata->>'tracked_by', '') = ${p.reporter === "firmware" ? "firmware" : ""}`)
    .returning(["id", "name", "qty", "min_qty"])
    .executeTakeFirst();
  if (!updated) return { ok: false, error: "This item is no longer available to this usage tracker." };

  await recordConsumption(trx, { partId: updated.id, delta: applied, reason, sourceKind: p.sourceKind ?? null, sourceId: p.sourceId ?? null, kind: p.correction ? "correction" : null, operationKey: p.operationKey });
  return { updated, applied, verdict, requested: delta };
}

/** What follows a committed count change: the statement line's event, the
 *  running-low wire. Run it after the transaction that wrote the count. */
export async function afterStockDelta(db: Kysely<InventoryDB>, orgId: string, reason: string, movement: StockMovement): Promise<Record<string, unknown>> {
  if (!movement.updated) return movement;
  const { updated, verdict } = movement as { updated: NonNullable<StockMovement["updated"]>; verdict: NonNullable<StockMovement["verdict"]> };
  const applied = movement.applied as number;
  const requested = movement.requested as number;

  // The statement line (WHAT drew it down, HOW MUCH: also what the burn-rate
  // predictor reads), stock.changed, and low stock on a decrease, the one
  // sequence every count change runs (stock-moved.ts). A one-tap "use one"
  // that crosses the minimum reorders for free.
  const newQty = Number(updated.qty);
  const minQty = updated.min_qty == null ? null : Number(updated.min_qty);
  const { low } = await stockMoved(db, orgId, {
    partId: updated.id,
    delta: applied,
    newQty,
    minQty,
    reason,
    ledger: false,
  });
  // `delta` is what actually moved (the inverse of this is +delta); a clamp
  // says what was asked and why less happened.
  return {
    ok: true,
    partId: updated.id,
    name: updated.name,
    delta: applied,
    newQty,
    // Where it now stands against the minimum kept, so a surface that just
    // took one off can offer the shopping list there and then (#3897).
    minQty,
    low,
    ...(verdict.kind === "clamp" ? { clamped: true, requested, note: verdict.note } : {}),
  };
}

/** Lock in part order so overlapping recipes cannot deadlock or share a draw.
 * The ledger commits with the quantities; listeners hear only committed moves. */
async function applyStockDraws(orgId: string, draws: StockDraw[], reason: string): Promise<Record<string, unknown>> {
  if (!Array.isArray(draws) || draws.some(d => !d || typeof d.partId !== "string" || !d.partId || !Number.isFinite(d.quantity) || d.quantity <= 0 || typeof d.optional !== "boolean")) {
    throw new ActionRefusal("Choose stock records and positive quantities for the draw.");
  }
  const grouped = new Map<string, StockDraw>();
  for (const d of draws) {
    const old = grouped.get(d.partId);
    grouped.set(d.partId, { ...d, quantity: d.quantity + (old?.quantity ?? 0), optional: d.optional && (old?.optional ?? true) });
  }
  const db = await platform().tenants.getDb(orgId) as Kysely<InventoryDB>;
  const movements = await db.transaction().execute(async trx => {
    const out = [];
    for (const d of [...grouped.values()].sort((a, b) => a.partId.localeCompare(b.partId))) {
      const p = { partId: d.partId, delta: -d.quantity, reason, exact: !d.optional, optional: d.optional };
      const movement = await stockDeltaIn(trx, orgId, p);
      if (!movement.updated && !d.optional) {
        throw new ActionRefusal(movement.error === "part_not_found" ? "A required component is no longer available." : String(movement.error || "A required component could not be drawn from stock."));
      }
      out.push({ p, movement });
    }
    return out;
  });
  const consumed = [];
  for (const { p, movement } of movements) {
    await afterStockDelta(db, orgId, p.reason, movement);
    if (movement.updated) consumed.push({ part_id: p.partId, quantity: -(movement.applied as number) });
  }
  return { ok: true, consumed };
}



// ─────────────────────────── the way back ───────────────────────────────
// Every stock move and lifecycle mark changes a part's count and a few keys
// of its metadata (the lots, the dates, a status); the item edit changes its
// name, fields and place. The honest inverse of any of them is the part the
// way it was, and one action puts it there: restore-part, given what the run
// changed and the values before. The wrapper takes the snapshot on the way
// in, diffs on the way out, and hands the difference back with the result;
// the undoer registered beside each handler turns that into the step.

interface PartSnapshot {
  qty: number;
  name: string;
  location_id: string | null;
  metadata: Record<string, unknown>;
}

async function partSnapshot(orgId: string, partId: string): Promise<PartSnapshot | null> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
  const row = await db
    .selectFrom("inventory_parts")
    .select(["qty", "name", "location_id", "metadata"])
    .where("id", "=", partId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    qty: Number(row.qty),
    name: row.name,
    location_id: row.location_id ?? null,
    metadata: ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>,
  };
}

/** What a run changed, with the values before: the arguments of restore-part. */
export interface PartUndoState {
  partId: string;
  qty?: number;
  name?: string;
  location_id?: string | null;
  /** Metadata keys to set back, with their values before. */
  metadata?: Record<string, unknown>;
  /** Metadata keys that did not exist before, to remove. */
  absent?: string[];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The part the action names, wherever the handler reads it from. */
function partIdOf(ctx: ActionInvokeContext): string | null {
  const args = (ctx.args as { partId?: unknown } | null) ?? {};
  const ev = (ctx.event?.payload as { partId?: unknown } | null) ?? {};
  const id = ctx.entity?.id ?? args.partId ?? ev.partId;
  return typeof id === "string" && id ? id : null;
}

/** Run a handler on a part and hand back, with its result, what it changed. A
 *  run that did nothing (refused, skipped, or changed nothing) hands back no
 *  undo state, and the card offers nothing to put back. */
async function withPartUndo(
  ctx: ActionInvokeContext,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const partId = partIdOf(ctx);
  const before = partId ? await partSnapshot(ctx.orgId, partId) : null;
  const result = await run();
  if (!partId || !before || result.ok !== true || result.skipped) return result;
  const after = await partSnapshot(ctx.orgId, partId);
  if (!after) return result;
  const state: PartUndoState = { partId };
  if (after.qty !== before.qty) state.qty = before.qty;
  if (after.name !== before.name) state.name = before.name;
  if (after.location_id !== before.location_id) state.location_id = before.location_id;
  const keys = new Set([...Object.keys(before.metadata), ...Object.keys(after.metadata)]);
  for (const k of keys) {
    if (same(before.metadata[k], after.metadata[k])) continue;
    if (k in before.metadata) (state.metadata ??= {})[k] = before.metadata[k];
    else (state.absent ??= []).push(k);
  }
  if (Object.keys(state).length === 1) return result;
  return { ...result, undo_state: state };
}

/** The step that puts the part back, from a result the wrapper decorated. */
export function partUndoStep(result: unknown): ActionUndoStep | null {
  const state = (result as { undo_state?: PartUndoState } | null)?.undo_state;
  if (!state || typeof state.partId !== "string") return null;
  return { action_id: "inventory:restore-part", args: { ...state } };
}

/** Put a part back to a snapshot: the count through the stock path (so the
 *  statement shows the reversal and the wires hear it), the fields and place
 *  through the same seams the edit used, the metadata keys merged back and
 *  the ones that were not there removed. Itself wrapped, so undoing an undo
 *  is another restore. */
async function restorePart(ctx: ActionInvokeContext): Promise<Record<string, unknown>> {
  const a = (ctx.args as Partial<PartUndoState> | null) ?? {};
  const partId = typeof a.partId === "string" ? a.partId : "";
  if (!partId) return { ok: false, error: "missing partId" };
  const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
  const current = await partSnapshot(ctx.orgId, partId);
  if (!current) return { ok: false, error: "part_not_found" };
  if (typeof a.qty === "number" && a.qty !== current.qty) {
    const applied = await applyStockDelta(ctx.orgId, { partId, delta: a.qty - current.qty, reason: "put back" });
    if (applied.ok !== true) return applied;
  }
  if (typeof a.name === "string" && a.name !== current.name) {
    await db.updateTable("inventory_parts").set({ name: a.name, updated_at: new Date() }).where("id", "=", partId).execute();
  }
  if (a.location_id !== undefined && a.location_id !== current.location_id) {
    try {
      if (a.location_id) {
        await platform().placement.place({
          orgId: ctx.orgId,
          containee: { kind: "inventory:part", id: partId },
          container: { kind: "core-locations:location", id: a.location_id },
        });
      } else {
        await platform().placement.remove({ orgId: ctx.orgId, containee: { kind: "inventory:part", id: partId } });
      }
    } catch {
      await db.updateTable("inventory_parts").set({ location_id: a.location_id ?? null } as never).where("id", "=", partId).execute();
    }
  }
  const set = a.metadata && typeof a.metadata === "object" ? a.metadata : {};
  const absent = Array.isArray(a.absent) ? a.absent.filter((k): k is string => typeof k === "string") : [];
  if (Object.keys(set).length || absent.length) {
    // Each step in its own parens: `-` binds tighter than `||` in Postgres,
    // so `a || b - 'k'` removes k from b (where it never was) and leaves it
    // on a. The lot an undone restock started stayed on the record that way.
    let expr = sql`coalesce(metadata, '{}'::jsonb)`;
    if (Object.keys(set).length) expr = sql`(${expr} || ${JSON.stringify(set)}::jsonb)`;
    for (const k of absent) expr = sql`(${expr} - ${k}::text)`;
    await db.updateTable("inventory_parts").set({ metadata: expr as never, updated_at: new Date() }).where("id", "=", partId).execute();
  }
  await platform().events.emit("inventory.part.updated", { orgId: ctx.orgId, partId });
  return { ok: true, summary: `Put ${current.name} back the way it was.`, partId };
}

/**
 * Change stock while keeping the lots underneath honest.
 *
 * Batches are the detail; `qty` and `expires_on` are the visible summary every
 * other consumer reads. They have to move together or the summary starts lying,
 * so both writes happen here and nowhere else.
 *
 * RECONCILES FIRST. Most of inventory does not know batches exist - adjust-stock,
 * the restock wire, a scan add-qty - and any of them can have moved `qty` since
 * the lots were last touched. Rather than forbidding that (which would mean
 * teaching every path about batches), the drift is absorbed: fewer than the lots
 * expect means the oldest went, more means stock arrived by a route that recorded
 * no date.
 */
/** What a positive move does to the lots, for every door that adds stock:
 *  a restock, or anything landing on an empty shelf, is a fresh lot dated
 *  today, good until today plus the item's shelf life (fresh-lot.ts). A
 *  correction on a stocked record stays a bare count; reconcile files it as
 *  an undated lot. */
export function arrivingLots(delta: number, restock: boolean, lots: readonly ArrivingLot[] = []) {
  return (batches: Batch[], { today, shelfLifeDays, qtyBefore }: { today: string; shelfLifeDays: number | null; qtyBefore: number }): Batch[] => {
    if (delta <= 0) return batches;
    // The units whose boxes printed a lot number arrive as those lots, dated
    // today; the rest arrive as they always did (#5764).
    let out = batches;
    let rest = delta;
    for (const l of lots) {
      out = addBatch(out, { received_on: today, expires_on: expiryFor(today, shelfLifeDays) ?? "", qty: l.qty, lot: l.lot });
      rest -= l.qty;
    }
    if (rest <= 0 || !startsFreshLot({ delta: rest, qtyBefore: qtyBefore + (delta - rest), restock })) return out;
    return addBatch(out, { received_on: today, expires_on: expiryFor(today, shelfLifeDays) ?? "", qty: rest });
  };
}

/** Reads that need a connection of their own, made before a transaction takes
 *  one: the day where the person is, and which fields of this record play the
 *  expiry and acquired-on roles. */
interface BatchPrep {
  today: string;
  roles: { acquiredOn: string | null; expiry: string | null } | null;
}

async function prepareBatches(orgId: string, partId: string, opts: { timezone?: string; userId?: string | null }): Promise<BatchPrep> {
  const today = await personToday(opts.userId, opts.timezone);
  let roles: BatchPrep["roles"] = null;
  try {
    const kind = await platform().entities.resolvedKindForEntity(orgId, "inventory:part", partId);
    const roled = await platform().entities.roledFieldsFor(orgId, kind);
    roles = {
      acquiredOn: roled.find((f) => f.field_role === "acquired-on")?.name ?? null,
      expiry: roled.find((f) => f.field_role === "expiry")?.name ?? null,
    };
  } catch (err) {
    console.warn(`[inventory] field roles skipped for ${partId}:`, (err as Error).message);
  }
  return { today, roles };
}

/** A stock change through the lots, not yet finished: its answer so far, and
 *  the count movement whose events still wait for the commit. */
export interface BatchRun {
  out: Record<string, unknown>;
  movement?: StockMovement;
  reason: string;
  extra?: Record<string, unknown>;
}

/** What follows the commit of a `withBatchesIn`. */
export async function finishBatches(db: Kysely<InventoryDB>, orgId: string, run: BatchRun): Promise<Record<string, unknown>> {
  if (!run.extra) return run.out;
  const applied = run.movement ? await afterStockDelta(db, orgId, run.reason, run.movement) : { ok: true, skipped: true, deliverySatisfied: true, reason: "no quantity change" };
  return { ...applied, ...run.extra };
}

export async function withBatches(
  orgId: string,
  partId: string,
  reason: string,
  delta: number,
  mutate: (batches: Batch[], ctx: { today: string; shelfLifeDays: number | null; qtyBefore: number }) => Batch[],
  opts: { timezone?: string; userId?: string | null; sourceKind?: string | null; sourceId?: string | null; correction?: boolean; operationId?: string } = {},
): Promise<Record<string, unknown>> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
  const prep = await prepareBatches(orgId, partId, opts);
  const run = await db.transaction().execute((trx) => withBatchesIn(trx, orgId, partId, reason, delta, mutate, opts, prep));
  return finishBatches(db, orgId, run);
}

/** The lots and the count of one record, changed together on the caller's
 *  transaction. The record's row is locked first, so two taps at once (two
 *  people, two tabs) change it one after the other, each reading what the
 *  last left: before this, both read the same lots, and the count went to 0
 *  while the lots still held the stock. Nothing in here may need a second
 *  connection (`prepareBatches` is what does, beforehand). */
export async function withBatchesIn(
  trx: Transaction<InventoryDB>,
  orgId: string,
  partId: string,
  reason: string,
  delta: number,
  mutate: (batches: Batch[], ctx: { today: string; shelfLifeDays: number | null; qtyBefore: number }) => Batch[],
  opts: { timezone?: string; userId?: string | null; sourceKind?: string | null; sourceId?: string | null; correction?: boolean; operationId?: string },
  prep: BatchPrep,
): Promise<BatchRun> {
  if (delta < 0 && !opts.correction) await assertStorageReady(trx, orgId, partId);
  const row = await trx
    .selectFrom("inventory_parts")
    .select(["id", "qty", "metadata", "name"])
    .where("id", "=", partId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return { out: { ok: false, error: "missing_part", final: true }, reason };
  if (isGone(row.metadata)) return { out: { ok: false, error: goneStockRefusal(row.name), final: true }, reason };

  const md = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const qtyNow = Number(row.qty);
  const roleDate = prep.roles?.expiry ? md[prep.roles.expiry] : undefined;
  const expiresOn = typeof md.expires_on === "string" && md.expires_on ? md.expires_on : typeof roleDate === "string" && roleDate ? roleDate : null;

  const current = reconcileToQty(batchesFrom(md, qtyNow, expiresOn), qtyNow);
  // Through the one reader the shopping row uses too (fresh-lot.ts): a
  // number field typed on a form arrives as "10", and a `typeof` check here
  // dated no lot while the row promised one.
  const shelfLifeDays = shelfLifeDaysOf(md.shelf_life_days);
  const today = prep.today;

  // The CALLER decides how much stock moves; the lots only describe it. This
  // used to run the other way - the delta was read back out of the mutated
  // batches - and an item with stock but no expiry date has no lots to read, so
  // `use-one` computed 0 - qty and wiped the whole record to zero. Every screw,
  // spool and tool in a workspace is exactly that shape, so one everyday tap
  // emptied it, with a ledger line that looked deliberate.
  //
  // Reconciling the lots to the new qty afterwards keeps them honest without
  // ever letting them govern: a dateless item stays batch-free and behaves
  // exactly as it did before batches existed.
  // The floor, before any lot is touched: a decrement on an empty record is
  // refused with the one sentence every surface shows, and a larger one than
  // what is on hand is clamped (stock-floor.ts). The stock write below applies
  // the same rule again; this keeps the lots from being rewritten for nothing.
  const verdict = floorDelta(qtyNow, delta);
  if (verdict.kind === "refuse") {
    return { out: { ok: false, error: verdict.error, partId, delta: 0, newQty: Math.max(0, qtyNow), qty: Math.max(0, qtyNow) }, reason };
  }
  const qtyAfter = Math.max(0, qtyNow + verdict.applied);
  const next = reconcileToQty(mutate(current, { today, shelfLifeDays, qtyBefore: qtyNow }), qtyAfter);
  const visible = visibleFrom(next);

  // A lot dated today grew: stock arrived. The record's own role fields say
  // so, by the workspace's declarations rather than by name. A use-one, or a
  // bare correction (reconcile files those as an undated lot), never rewrites
  // a bought-on date.
  const stamps: Record<string, string | null> = arrivedToday(current, next, today) && prep.roles
    ? freshLotStamps({
        today,
        visibleExpiry: visible.expires_on,
        qtyBefore: qtyNow,
        roles: { acquiredOn: prep.roles.acquiredOn, expiry: prep.roles.expiry },
      })
    : {};

  // The count first, then the lots, on the one transaction: a stock write that
  // is refused (an externally tracked record, a usage tracker that is not the
  // caller) changes nothing, so the lots must not be rewritten either, or the
  // next reconcile finds fewer units than the lots claim and drops the oldest
  // lot's real dates (#7116). The events that follow wait for the commit.
  const movement =
    verdict.applied === 0
      ? undefined
      : await stockDeltaIn(trx, orgId, {
          partId,
          delta: verdict.applied,
          reason,
          sourceKind: opts.sourceKind ?? null,
          sourceId: opts.sourceId ?? null,
          operationId: opts.operationId,
          ...(opts.correction ? { correction: true } : {}),
        });
  if (movement && !movement.updated) return { out: movement, reason };

  await trx
    .updateTable("inventory_parts")
    .set({
      metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({
        batches: next,
        ...(visible.expires_on !== null ? { expires_on: visible.expires_on } : {}),
        ...stamps,
      })}::jsonb`,
    })
    .where("id", "=", partId)
    .execute();

  return { out: {}, movement, reason, extra: { batches: next, expires_on: visible.expires_on, qty: qtyAfter } };
}

export function registerInventoryActionHandlers(): void {
  if (registered) return;
  registered = true;

  // Parts are editable through platform:update-fields (an app's edit form, the
  // API, Cobb), with the same grant the part page asks for.
  platform().entities.registerUpdater("inventory:part", updatePartFields, { capability: "inventory:update-part", nativeFields: [...PART_EDITABLE_KEYS] });

  // How a device reading maps to inventory's own stock actions — so
  // core-devices can apply a scale/counter reading to a part WITHOUT knowing
  // about inventory (the device-side knowledge lives here, in the owner).
  // (Audit 2026-06-26 follow-up — replaces core-devices' hardcoded branch.)
  platform().entities.registerDeviceApply("inventory:part", (ctx) => {
    if (ctx.mode === "set" && typeof ctx.value === "number") {
      return { actionId: "inventory:set-stock", args: { partId: ctx.entityId, qty: ctx.value, reason: ctx.reason } };
    }
    if (ctx.mode === "add" && typeof ctx.value === "number") {
      return { actionId: "inventory:adjust-stock", args: { partId: ctx.entityId, delta: ctx.value, reason: ctx.reason } };
    }
    return null;
  });

  // ───────────── field-to-location (bundle-migration engine) ─────────────
  // Retire a bundle's bespoke PLACE field (e.g. Home Inventory's "room" text
  // field) into the platform's canonical Location: for each item in an instance
  // that has a value in that field, find-or-create a matching Location AREA and
  // file the item into it (set location_id), then clear the field. This is how a
  // bundle drops a location-shaped custom field in favour of the real Location on
  // a version bump — no per-workspace script. Cross-module writes go through the
  // registered core-locations WRITER seam (no HTTP/token). Idempotent + safe:
  // never invents a place (only moves what the user already typed), never
  // overwrites an item that's already filed somewhere, and re-files into an
  // existing same-named area instead of duplicating it. Args: { field, instance }.
  platform().actions.registerHandler("inventory.field-to-location", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const field = typeof a.field === "string" ? a.field : "";
    const instance = typeof a.instance === "string" ? a.instance : "";
    if (!field || !instance) return { ok: false, error: "missing field / instance" };

    const writer = await platform().entities.getWriter(ctx.orgId, "core-locations:location");
    if (!writer) return { ok: false, error: "core-locations not available" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const parts = await db
      .selectFrom("inventory_parts")
      .selectAll()
      .where("instance", "=", instance as never)
      .where("archived", "=", false)
      .execute();

    // Existing locations by lowercased name → id, so we file into a place the
    // user already has instead of duplicating it (the homebox-import merge rule).
    const existing = writer.listForMatch ? await writer.listForMatch(ctx.orgId) : [];
    const areaByName = new Map<string, string>();
    for (const l of existing) areaByName.set(l.name.trim().toLowerCase(), l.id);

    let filed = 0;
    let areasCreated = 0;
    for (const p of parts) {
      const meta = (p.metadata as Record<string, unknown> | null) ?? {};
      if (!(field in meta)) continue; // already migrated / never had it → skip (idempotent)
      const raw = meta[field];
      const name = raw == null ? "" : String(raw).trim();
      const nextMeta = { ...meta };
      delete nextMeta[field];
      const patch: Record<string, unknown> = { metadata: sql`${JSON.stringify(nextMeta)}::jsonb` as never };
      // File into a location ONLY when the item isn't already located AND the
      // field held a real value — never clobber an existing filing, never invent.
      let fileInto: string | null = null;
      if (!p.location_id && name) {
        const key = name.toLowerCase();
        let locId = areaByName.get(key);
        if (!locId) {
          locId = await writer.create(ctx.orgId, { name, kind: "area" });
          areaByName.set(key, locId);
          areasCreated++;
        }
        fileInto = locId;
        filed++;
      }
      await db.updateTable("inventory_parts").set(patch as never).where("id", "=", p.id).execute();
      // The filing itself rides the placement seam (placement-cutover-plan
      // step 1); place() mirrors the legacy column. Fallback: direct write.
      if (fileInto) {
        try {
          await platform().placement.place({
            orgId: ctx.orgId,
            containee: { kind: "inventory:part", id: p.id },
            container: { kind: "core-locations:location", id: fileInto },
          });
        } catch {
          await db.updateTable("inventory_parts").set({ location_id: fileInto } as never).where("id", "=", p.id).execute();
        }
      }
    }
    return { ok: true, filed, areas_created: areasCreated };
  });

  platform().actions.registerHandler("inventory.adjust-stock", (ctx) => {
    const args = (ctx.args as AdjustStockPayload | null) ?? {};
    if (args.draws !== undefined) return applyStockDraws(ctx.orgId, args.draws, args.reason ?? "Stock draw");
    return withPartUndo(ctx, async () => {
      // Args take precedence (an admin can hardwire a wire to "always
      // add 1"); otherwise we pull from the event payload. The one thing that
      // beats a fixed arg is a QUANTITY the person stated on the gesture
      // ("I got 3", checked off the shopping list): the fixed amount exists for
      // events that do not say, and the shopping row shows it as the default.
      const args = (ctx.args as AdjustStockPayload | null) ?? {};
      const ev = (ctx.event?.payload as AdjustStockPayload | null) ?? {};
      // The record the action was invoked ON counts too: a chat card or a row
      // button targets the entity and sends no partId, and the invoke used to
      // answer "skipped: missing partId" while claiming ok.
      const partId = args.partId ?? ev.partId ?? ctx.entity?.id;
      const takeBack = (args as { takeBack?: unknown }).takeBack === true;
      const stated = takeBack ? -1 : (statedQuantity((ev as { quantity?: unknown }).quantity, args.delta) ?? args.delta ?? ev.delta);
      const reason = args.reason ?? ev.reason ?? "wire-driven adjustment";
      if (!partId || typeof stated !== "number") {
        return { ok: true, skipped: true, reason: "missing partId or delta" };
      }
      if (stated === 0) return { ok: true, skipped: true, deliverySatisfied: true, reason: "no stock change requested" };
      const sourceKind = args.sourceKind ?? ev.sourceKind;
      const sourceId = args.sourceId ?? ev.sourceId;
      if (takeBack && !(sourceKind && sourceId)) return { ok: true, skipped: true, reason: "nothing to take back without a source" };
      const inUnit = takeBack ? { ok: true as const, delta: stated } : await inPartUnit(ctx.orgId, partId, stated, args.unit ?? ev.unit);
      if (!inUnit.ok) return { ok: true, skipped: true, reason: inUnit.reason };
      if (args.operationKey !== undefined) {
        return applyStockDelta(ctx.orgId, { partId, delta: inUnit.delta, reason, sourceKind: args.sourceKind, sourceId: args.sourceId, operationKey: args.operationKey });
      }
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
      const once = (args.once ?? ev.once) === true && !!sourceKind && !!sourceId;
      const restock = ((args as { restock?: unknown }).restock ?? (ev as { restock?: unknown }).restock) === true;
      // What other connections have to say (the day, the field roles) is read
      // before the transaction takes its own, so a small pool is never asked
      // for a second connection by one that is holding the first.
      const prep = await prepareBatches(ctx.orgId, partId, { timezone: typeof args.timezone === "string" ? args.timezone : undefined, userId: ctx.userId });

      // The whole of one source's say about this record, on ONE transaction:
      // the record's row is locked first, so the "has this source already
      // done it?" read below sees what the request before it committed, and
      // its write cannot be slipped between (#7115: two ticks of one shopping
      // line each read "not yet" and each added the purchase). The events
      // that follow a count change wait for the commit.
      const settled = await db.transaction().execute(async (trx): Promise<{ skipped: Record<string, unknown> } | { after: () => Promise<Record<string, unknown>> }> => {
        await trx.selectFrom("inventory_parts").select("id").where("id", "=", partId).forUpdate().execute();
        let delta = inUnit.delta;
        if (takeBack) {
          // What this source has added, net: all of it goes, and a line that
          // added nothing (never ticked, or already taken back) takes nothing.
          const net = await appliedBySource(ctx.orgId, partId, sourceKind!, sourceId!, trx);
          if (net <= 0) return { skipped: { ok: true, skipped: true, reason: "nothing applied for this source" } };
          delta = -net;
        } else if (once && (await alreadyApplied(ctx.orgId, partId, sourceKind!, sourceId!, delta, (args.reversible ?? ev.reversible) === true, trx))) {
          return { skipped: { ok: true, skipped: true, deliverySatisfied: true, reason: "already applied for this source" } };
        }
        // Stock arriving goes through the lots, so a restock (the wire says
        // `restock: true`) or anything landing on an empty shelf is a fresh lot
        // dated today, good until today plus the item's shelf life, and the
        // record's bought-on and expiry role fields say so. Before this, the
        // check-off wire's +1 was a bare count and the fresh milk inherited the
        // old lot's dates (fresh-lot.ts). A correction on a stocked record stays
        // a bare count: reconcile files it as an undated lot, as it always did.
        if (delta > 0) {
          const run = await withBatchesIn(
            trx,
            ctx.orgId,
            partId,
            reason,
            delta,
            arrivingLots(delta, restock, arrivingLotsOf(args.lots, delta)),
            {
              ...(typeof args.timezone === "string" ? { timezone: args.timezone } : {}),
              userId: ctx.userId,
              operationId: ev.operationId,
              sourceKind: sourceKind ?? null,
              sourceId: sourceId ?? null,
              ...(args.correction === true ? { correction: true } : {}),
            },
            prep,
          );
          return { after: () => finishBatches(db, ctx.orgId, run) };
        }
        const movement = await stockDeltaIn(trx, ctx.orgId, {
          partId,
          delta,
          reason,
          sourceKind,
          sourceId,
          operationId: ev.operationId,
          ...(args.correction === true ? { correction: true } : {}),
        });
        return { after: () => afterStockDelta(db, ctx.orgId, reason, movement) };
      });
      return "skipped" in settled ? settled.skipped : settled.after();
    });
  });



  // ───────────── one-tap consumption (P1 — consumption capture) ─────────────
  // The binary "used" signal, at the moment you're already handling the item —
  // NO number entry (that's the typed StockAdjust popup, kept for when you DO
  // want exact). userInvokable, unlike adjust-stock: these are buttons a person
  // taps. Both decrement through applyStockDelta, so the ledger, stock.changed,
  // and the stock.low → shopping-list wire all fire for free.

  // What a one-tap change will do, in the words a confirm shows before
  // anything moves: "Toilet paper: 12 → 11". An action label's page reads it
  // (#3897), as does any confirm card.
  const stockPlanner = (delta: (args: Record<string, unknown>) => number) => async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const partId = ctx.entity?.id ?? (typeof args.partId === "string" ? args.partId : null);
    if (!partId) return null;
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const part = await db.selectFrom("inventory_parts").select(["name", "qty", "min_qty"]).where("id", "=", partId).executeTakeFirst();
    if (!part) return { error: "that item is not here any more" };
    const now = Number(part.qty ?? 0);
    const next = Math.max(0, now + delta(args));
    const min = part.min_qty == null ? null : Number(part.min_qty);
    return {
      title: `${part.name}: ${now} → ${next}`,
      lines: min != null && min > 0 ? [`Keep at least ${min}${next <= min ? " (this takes it there)" : ""}`] : [],
    };
  };
  platform().actions.registerPlanner("inventory.use-one", stockPlanner(() => -1));
  platform().actions.registerPlanner("inventory.restock-one", stockPlanner((a) => Math.max(1, Math.trunc(Number(a.qty ?? 1)))));

  // Use one: knock a single unit off. The everyday tap ("took one out").
  platform().actions.registerHandler("inventory.use-one", (ctx) =>
    withPartUndo(ctx, async () => {
      const partId = ctx.entity?.id ?? (ctx.args as { partId?: string } | null)?.partId;
      if (!partId) return { ok: false, error: "missing_part" };
      // One of a thing kept in kg is a whole kilogram: a spool emptied by a
      // tap. A measured thing is used by saying how much, never by one.
      await refuseOneOfMeasured(ctx.orgId, partId);
      const tz = (ctx.args as { timezone?: string } | null)?.timezone;
      // A note said about this one (a bottle's tasting note, asked by the
      // collection's own button) is kept on the statement line of the use,
      // dated with it, rather than overwriting a field the next use replaces.
      const note = useNoteOf((ctx.args as { note?: unknown } | null)?.note);
      // Always the OLDEST lot. It is the one the warning named, so taking from
      // anywhere else would leave the warning standing after the user did what it
      // asked - and once that lot empties the deadline moves on by itself.
      const applied = await withBatches(
        ctx.orgId,
        partId,
        note ? `used one: ${note}` : "used one",
        -1,
        (batches) => consumeOldest(batches, 1).batches,
        { ...(tz ? { timezone: tz } : {}), userId: ctx.userId },
      );
      await announce(ctx.orgId, ctx.userId, applied, [observation(partId, "consume", -1)]);
      await logTap(ctx.orgId, ctx.userId, "part_used", applied);
      return applied;
    }),
  );

  // Restock one: another arrived today, good until its own date. NOT qty + 1 -
  // a container arriving today has its own shelf life, and incrementing a count
  // would leave it inheriting the previous lot's deadline.
  platform().actions.registerHandler("inventory.restock-one", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; qty?: number; timezone?: string } | null) ?? {};
      const partId = ctx.entity?.id ?? args.partId;
      if (!partId) return { ok: false, error: "missing_part" };
      const add = Math.max(1, Math.trunc(Number(args.qty ?? 1)));
      const applied = await withBatches(
        ctx.orgId,
        partId,
        "restocked one",
        add,
        (batches, { today, shelfLifeDays }) => {
          const expires = expiryFor(today, shelfLifeDays);
          // No shelf life declared means no date. Adding one anyway would put a
          // confident deadline on something nobody measured.
          return addBatch(batches, {
            received_on: today,
            expires_on: expires ?? "",
            qty: add,
          });
        },
        { ...(args.timezone ? { timezone: args.timezone } : {}), userId: ctx.userId },
      );
      await announce(ctx.orgId, ctx.userId, applied, [observation(partId, "purchase", add)]);
      await logTap(ctx.orgId, ctx.userId, "part_restocked", applied);
      return applied;
    }),
  );

  // Replaced with a fresh one: the old box is finished and an identical new
  // one arrived, in one tap. The count does not move (so nothing trips the
  // running-low wire on the way through), the old lot ends as "used" and
  // teaches its floor, the new lot is dated today, and the ledger hears one
  // consumed and one bought - which is exactly how it learns the interval.
  async function swapFresh(
    orgId: string,
    userId: string | null | undefined,
    partId: string,
    timezone: string | undefined,
  ): Promise<Record<string, unknown>> {
    const args = { timezone };
    const ctx = { orgId, userId };
    const applied = await withBatches(
      ctx.orgId,
      partId,
      "replaced with a fresh one",
      0,
      (batches, { today, shelfLifeDays }) => {
        const expires = expiryFor(today, shelfLifeDays);
        return addBatch(consumeOldest(batches, 1).batches, {
          received_on: today,
          expires_on: expires ?? "",
          qty: 1,
        });
      },
      { ...(args.timezone ? { timezone: args.timezone } : {}) },
    );
    if (applied.ok !== true) return applied;
    // withBatches skipped the stock write (delta 0) and says so; the swap is
    // still a real event, so the "skipped" is not passed on.
    const { skipped: _skipped, reason: _reason, ...rest } = applied;
    await announce(ctx.orgId, ctx.userId, { ok: true }, swapFreshObservations(partId));
    return { ...rest, ok: true, swapped: 1 };
  }

  // Wire-only alias now: the button is "Replaced", which comes here for a
  // perishable. Kept so a wire or the assistant saying "swapped in a new box"
  // still lands.
  platform().actions.registerHandler("inventory.swap-fresh", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; timezone?: string } | null) ?? {};
      const partId = ctx.entity?.id ?? args.partId;
      if (!partId) return { ok: false, error: "missing_part" };
      return swapFresh(ctx.orgId, ctx.userId, partId, args.timezone);
    }),
  );


  // ───────────── lifecycle marks (learning what you never knew) ─────────────
  // Nobody knows how long a jar of pesto keeps. Everybody knows what they did
  // to it. Three taps with dates on them, and the durations fall out.
  //
  // The asymmetry is the whole point and is enforced in shelf-life-learning.ts:
  // "threw it out" MEASURES a shelf life; "used it up" only puts a floor under
  // one. Averaging the two teaches a fast eater that pesto keeps six days and
  // then warns them about food that was never going to spoil.

  /** Shared tail: close the oldest lot, record what happened to it, and fold the
   *  learning back onto the item. */
  async function endOldestLot(
    orgId: string,
    partId: string,
    ended: "used" | "spoiled",
    timezone: string | undefined,
    reason: string,
    userId: string | null | undefined,
    pick?: LotPick,
  ): Promise<Record<string, unknown>> {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
    const row = await db
      .selectFrom("inventory_parts")
      .select(["qty", "metadata", "created_at"])
      .where("id", "=", partId)
      .executeTakeFirst();
    if (!row) return { ok: false, error: "missing_part" };
    const md = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    const today = await personToday(userId, timezone);
    const lots = reconcileToQty(
      batchesFrom(md, Number(row.qty), typeof md.expires_on === "string" ? md.expires_on : null),
      Number(row.qty),
    );
    // The lot a row named, or the oldest when none was (the record's own buttons).
    const oldest = pick ? lots.find((l) => l.qty > 0 && lotIs(l, pick)) : lots[0];
    if (pick && !oldest) return { ok: false, error: NO_SUCH_LOT };

    let vanished = false;
    const result = await withBatches(
      orgId,
      partId,
      reason,
      -1,
      (batches) => {
        if (!pick) return consumeOldest(batches, 1).batches;
        const taken = consumeLot(batches, pick, 1);
        if ("refused" in taken) {
          vanished = true;
          return batches;
        }
        return taken.batches;
      },
      { ...(timezone ? { timezone } : {}), userId },
    );
    if (vanished) return { ok: false, error: NO_SUCH_LOT };
    // Nothing ended: nothing to learn from. A refused decrement (the record
    // was empty) must not teach a shelf life it never measured.
    if (result.ok !== true) return result;

    // When it turned up. A dated lot knows; most items do not have one, because
    // only `restock-one` creates them - anything filed by a scan, an import or
    // the plain create form is a bare quantity. Without a fallback the learning
    // would quietly never fire for the great majority of a workspace, which
    // looks identical to a feature that does not work.
    //
    // The record's own creation date is the honest stand-in: you filed it when
    // it showed up. It is wrong for a backfilled inventory, which is why a dated
    // lot always wins and why one observation never becomes confident on its own.
    const startedOn =
      oldest?.received_on ||
      (typeof md.received_on === "string" ? md.received_on : "") ||
      (row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : "");

    if (startedOn) {
      const prior = Array.isArray(md.shelf_life_observations)
        ? (md.shelf_life_observations as LifecycleObservation[])
        : [];
      const observations = recordObservation(prior, {
        received_on: startedOn,
        ...(typeof md.opened_on === "string" && md.opened_on ? { opened_on: md.opened_on } : {}),
        ended_on: today,
        ended,
      });
      const estimate = estimateShelfLife(observations);
      // Only APPLY a learned figure once more than one thing has actually gone
      // off. Below that it is stored and shown, never acted on.
      const apply =
        isConfident(estimate) && estimate.shelf_life_days !== null
          ? {
              shelf_life_days: estimate.shelf_life_days,
              ...(estimate.shelf_life_opened_days !== null
                ? { shelf_life_opened_days: estimate.shelf_life_opened_days }
                : {}),
            }
          : {};
      await db
        .updateTable("inventory_parts")
        .set({
          metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({
            shelf_life_observations: observations,
            shelf_life_estimate: estimate,
            // The lot is gone, so the opened clock that belonged to it is too.
            opened_on: null,
            ...apply,
          })}::jsonb`,
        })
        .where("id", "=", partId)
        .execute();
      return { ...result, learned: estimate };
    }
    return result;
  }

  // Opened: starts the shorter clock on ONE unit, and records when, so the
  // opened-to-spoiled duration can be measured later.
  platform().actions.registerHandler("inventory.mark-opened", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; timezone?: string } | null) ?? {};
      const partId = ctx.entity?.id ?? args.partId;
      if (!partId) return { ok: false, error: "missing_part" };
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
      const row = await db
        .selectFrom("inventory_parts")
        .select(["qty", "metadata"])
        .where("id", "=", partId)
        .executeTakeFirst();
      if (!row) return { ok: false, error: "missing_part" };
      // Nothing to open: stamping an opened date on an empty record made the
      // next one restocked read as already open.
      if (!(Number(row.qty) > 0)) return { ok: false, error: "Nothing on hand to open", partId, qty: Math.max(0, Number(row.qty)) };
      const md = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const today = await personToday(ctx.userId, args.timezone);
      const openedDays = shelfLifeDaysOf(md.shelf_life_opened_days);
      // Opening does not change how many you have, so the lot count is untouched.
      // What changes is the DEADLINE on the one you opened: if we know the opened
      // clock, it takes over, because it is much shorter than the sealed one.
      const shortened = expiryFor(today, openedDays);
      await db
        .updateTable("inventory_parts")
        .set({
          metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({
            opened_on: today,
            ...(shortened ? { expires_on: shortened } : {}),
          })}::jsonb`,
        })
        .where("id", "=", partId)
        .execute();
      return { ok: true, opened_on: today, expires_on: shortened };
    }),
  );

  // Used up: finished it. A LOWER BOUND on the shelf life, never a measurement.
  platform().actions.registerHandler("inventory.mark-finished", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; timezone?: string; lot_received_on?: string; lot_expires_on?: string; lot_number?: string } | null) ?? {};
      const partId = ctx.entity?.id ?? args.partId;
      if (!partId) return { ok: false, error: "missing_part" };
      const applied = await endOldestLot(ctx.orgId, partId, "used", args.timezone, "finished it", ctx.userId, lotPickOf(args));
      await announce(ctx.orgId, ctx.userId, applied, [observation(partId, "consume", -1)]);
      return applied;
    }),
  );

  // Threw it out: it went bad. THE measurement, and the only thing that ever
  // teaches a shelf life. Also a cadence discard, which is what feeds the
  // buy-less advice - the signal that says somebody is over-buying.
  platform().actions.registerHandler("inventory.mark-spoiled", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; timezone?: string; lot_received_on?: string; lot_expires_on?: string; lot_number?: string } | null) ?? {};
      const partId = ctx.entity?.id ?? args.partId;
      if (!partId) return { ok: false, error: "missing_part" };
      const applied = await endOldestLot(ctx.orgId, partId, "spoiled", args.timezone, "threw it out", ctx.userId, lotPickOf(args));
      await announce(ctx.orgId, ctx.userId, applied, [observation(partId, "discard", -1)]);
      return applied;
    }),
  );

  // Still good: checked, fine, ask again in a few days (still-good.ts).
  platform().actions.registerHandler("inventory.still-good", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; timezone?: string; days?: unknown } | null) ?? {};
      const partId = ctx.entity?.id ?? args.partId;
      if (!partId) return { ok: false, error: "missing_part" };
      const n = Number(args.days ?? 3);
      const days = Number.isFinite(n) && n >= 1 && n <= 60 ? Math.round(n) : 3;
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
      const row = await db.selectFrom("inventory_parts").select(["qty", "metadata"]).where("id", "=", partId).executeTakeFirst();
      if (!row) return { ok: false, error: "part_not_found" };
      const md = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const today = await personToday(ctx.userId, args.timezone);
      // The collection's own expiry field, by role: the date its reminders read.
      let expiryField: string | null = null;
      try {
        const kind = await platform().entities.resolvedKindForEntity(ctx.orgId, "inventory:part", partId);
        expiryField = (await platform().entities.roledFieldsFor(ctx.orgId, kind)).find((f) => f.field_role === "expiry")?.name ?? null;
      } catch {
        expiryField = null;
      }
      const patch = stillGoodPatch(md, Number(row.qty), today, days, expiryField);
      if (!patch) return { ok: false, error: "This has no date to move." };
      await db
        .updateTable("inventory_parts")
        .set({ metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updated_at: new Date() })
        .where("id", "=", partId)
        .execute();
      return { ok: true, partId, expires_on: patch.expires_on, message: `Good until ${String(patch.expires_on)}` };
    }),
  );

  // Used up: it's gone (tossing the empty). Drive on-hand to 0 in one tap —
  // no "how many left?" guess. Reads current qty and deltas it to zero so the
  // ledger + low-stock path stay uniform; a no-op if already 0.
  platform().actions.registerHandler("inventory.use-up", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; timezone?: string; lot_received_on?: string; lot_expires_on?: string; lot_number?: string } | null) ?? {};
      const partId = ctx.entity?.id ?? args.partId;
      if (!partId) return { ok: false, error: "missing_part" };
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
      const row = await db
        .selectFrom("inventory_parts")
        .select(["qty", "metadata"])
        .where("id", "=", partId)
        .executeTakeFirst();
      if (!row) return { ok: false, error: "part_not_found" };
      // ONE button for the end of a thing. "Used up" and "Finished it" were two
      // chips for one gesture; the difference between them is a property of the
      // RECORD (does it go off?), so the record decides. A perishable ends its
      // oldest lot and learns from how long it lasted; plain stock just empties.
      if (isPerishable(row.metadata)) {
        const applied = await endOldestLot(ctx.orgId, partId, "used", args.timezone, "used up", ctx.userId, lotPickOf(args));
        await announce(ctx.orgId, ctx.userId, applied, [observation(partId, "consume", -1)]);
        return applied;
      }
      const cur = Number(row.qty);
      // Already empty: nothing to record, and the same sentence every other
      // decrement gives. ok, because tossing an empty that is already recorded
      // empty is not a mistake to undo.
      if (!(cur > 0)) return { ok: true, skipped: true, partId, delta: 0, newQty: Math.max(0, cur), note: "already empty", reason: NOTHING_ON_HAND };
      const applied = await applyStockDelta(ctx.orgId, { partId, delta: -cur, reason: "used up" });
      await announce(ctx.orgId, ctx.userId, applied, [observation(partId, "consume", -cur)]);
      return applied;
    }),
  );

  // ───────── Replaced (P2 — the replace-clock's one tap) ─────────
  // The single tap you make at the moment of a scheduled swap (furnace filter,
  // water filter, printer nozzle): (a) reset the clock — stamp last_replaced_at
  // = now, so the recurrence scanner re-anchors and won't nag again until the
  // next interval; (b) consume a spare — knock one off on-hand, which (via the
  // shared decrement) trips stock.low → shopping list if you're now short. So
  // "Replaced" = reset + consume-spare + maybe-reorder, in one tap.
  platform().actions.registerHandler("inventory.replaced", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; timezone?: string } | null) ?? {};
      const partId = ctx.entity?.id ?? args.partId;
      if (!partId) return { ok: false, error: "missing_part" };
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
      // Same rule as use-up: one button, the record decides. A perishable swaps
      // a fresh lot in (what swap-fresh does); a durable stamps the replacement
      // and consumes a spare.
      const current = await db
        .selectFrom("inventory_parts")
        .select(["metadata"])
        .where("id", "=", partId)
        .executeTakeFirst();
      if (current && isPerishable(current.metadata)) {
        return swapFresh(ctx.orgId, ctx.userId, partId, args.timezone);
      }
      // Reset the clock: merge last_replaced_at into metadata (jsonb, wholesale-
      // safe merge so other keys survive).
      const nowIso = new Date().toISOString();
      const reset = await db
        .updateTable("inventory_parts")
        .set({
          metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ last_replaced_at: nowIso })}::jsonb`,
          updated_at: new Date(),
        })
        .where("id", "=", partId)
        .returning(["id", "qty"])
        .executeTakeFirst();
      if (!reset) return { ok: false, error: "part_not_found" };
      // Consume the spare that went in — but only if there's one on hand; a
      // replacement with no spares still resets the clock (the point) without
      // driving qty negative. The decrement trips stock.low → reorder if short.
      const cur = Number(reset.qty);
      const consumed =
        cur > 0
          ? await applyStockDelta(ctx.orgId, { partId, delta: -1, reason: "replaced (consumed a spare)" })
          : { ok: true, skipped: true, reason: "no spare on hand" };
      return { ok: true, partId, last_replaced_at: nowIso, consumed };
    }),
  );

  // ─────────────────────── set-stock ───────────────────────────────
  // Set a part's on-hand qty to an ABSOLUTE value (not a delta). The
  // natural op for a scale ("grams remaining"), a stocktake, or a recount —
  // adjust-stock can't express "set to N" without a racy read-then-delta.
  // Same downstream signals as adjust-stock (stock.changed + low-stock).
  platform().actions.registerHandler("inventory.set-stock", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; qty?: number; reason?: string } | null) ?? {};
      const ev = (ctx.event?.payload as { partId?: string; qty?: number } | null) ?? {};
      const partId = args.partId ?? ev.partId ?? ctx.entity?.id;
      const qty = args.qty ?? ev.qty;
      const reason = args.reason ?? "set to an absolute value";
      if (!partId || typeof qty !== "number") {
        return { ok: true, skipped: true, reason: "missing partId or qty" };
      }
      if (qty < 0) return { ok: false, error: BELOW_ZERO, partId, requested: qty };
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
      const was = await db.selectFrom("inventory_parts").select("qty").where("id", "=", partId).executeTakeFirst();
      if (!was) return { ok: false, error: "part_not_found" };
      const updated = await db
        .updateTable("inventory_parts")
        .set({ qty: sql<string>`${qty}::numeric`, updated_at: new Date() })
        .where("id", "=", partId)
        .returning(["id", "name", "qty", "min_qty"])
        .executeTakeFirst();
      if (!updated) return { ok: false, error: "part_not_found" };
      const newQty = Number(updated.qty);
      // A recount is a correction: a statement line the burn rate never reads
      // as use, and low stock when it lands the part at its minimum.
      await stockMoved(db, ctx.orgId, {
        partId: updated.id,
        delta: newQty - Number(was.qty),
        newQty,
        minQty: updated.min_qty == null ? null : Number(updated.min_qty),
        reason,
        ledger: { kind: "correction" },
      });
      return { ok: true, partId: updated.id, newQty };
    }),
  );

  // ─────────────────────── set-status ──────────────────────────────
  // A small, member-appropriate write: set a part's state, metadata.status by
  // default. This is the canonical action a custom (Tier B) app block invokes,
  // capability-gated (`inventory:set-status`) like any other, so a worker can
  // only run it if granted. partId comes from args or the targeted entity.
  //
  // `field` names another state field on the record's table: the shipped Lego
  // bundle keeps a set's state in `lifecycle` (sealed / built / disassembled),
  // and with only `status` a Club Member's Build Tracker could never mark a
  // set of that table built. The field must be one the table declares, and a
  // field with choices takes only one of them (stateWrite).
  platform().actions.registerHandler("inventory.set-status", (ctx) =>
    withPartUndo(ctx, async () => {
      const args = (ctx.args as { partId?: string; status?: string; field?: string } | null) ?? {};
      const partId = args.partId ?? (ctx.entity as { id?: string } | null)?.id;
      const status = typeof args.status === "string" ? args.status.trim().slice(0, 60) : undefined;
      if (!partId || !status) return { ok: false, error: "missing partId or status" };
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
      const row = await db
        .selectFrom("inventory_parts")
        .select(["metadata", "instance"])
        .where("id", "=", partId)
        .executeTakeFirst();
      if (!row) return { ok: false, error: "part_not_found" };
      const field = args.field?.trim() || "status";
      let def: StateFieldDef | null = null;
      if (field !== "status") {
        const kind = row.instance ? `${row.instance}:item` : "inventory:part";
        const meta = platform().db.meta as unknown as Kysely<{ module_field_defs: { org_id: string; entity_kind: string; name: string; choices: unknown } }>;
        const found = await meta
          .selectFrom("module_field_defs")
          .select(["name", "choices"])
          .where("org_id", "=", ctx.orgId)
          .where("entity_kind", "in", [kind, "inventory:part"])
          .where("name", "=", field)
          .executeTakeFirst();
        def = found ? { name: found.name, choices: Array.isArray(found.choices) ? (found.choices as unknown[]).filter((c): c is string => typeof c === "string") : null } : null;
      }
      const write = stateWrite(field, status, def);
      if (!write.ok) return { ok: false, error: write.error };
      await db
        .updateTable("inventory_parts")
        .set({
          // Overlay just this one key, DB-side: a part's metadata is
          // multi-writer (the Lego lifecycle, scan-confirm fields, connector
          // namespaces), and a snapshot rewrite dropped whatever else changed.
          metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ [write.field]: write.value })}::jsonb` as never,
          updated_at: new Date(),
        })
        .where("id", "=", partId)
        .execute();
      return { ok: true, partId, status: write.value, field: write.field };
    }),
  );

  // ─────────────────────── create-item ─────────────────────────────
  // Generic item creation — the canonical write a custom (Tier B) app block
  // performs when it needs to ADD an entity (there was no invokable create
  // action before; apps could only set-status / adjust-stock). Creates an
  // inventory item in a given instance with a name + custom fields (metadata)
  // + an optional location/manufacturer/qty. Knows nothing about any specific
  // use-case — the caller composes the name + fields and decides what to make.
  // Capability-gated (`inventory:create-item`). Emits inventory.part.created so
  // wires fire as they would for an HTTP create.
  platform().actions.registerHandler("inventory.create-item", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    // Empty → undefined so the column DEFAULT ('inventory') applies (see
    // create-items); "" would hide the row in an unreadable instance.
    const said = typeof a.instance === "string" && a.instance.trim() ? a.instance.trim() : undefined;
    // The list has to exist. "new spice: garam masala" arrived with instance
    // "spices" in a workspace with no such list; the row was written with
    // that tag, reported made, and could be opened from nowhere: not in
    // Inventory, not in any list, its page a dead link (#3092). A list is
    // matched the way a person names it (its name or its label, case aside)
    // and a list nobody has is refused with the ones they do have.
    let instance: string | undefined;
    if (said) {
      const lists = (await platform().instances.list(ctx.orgId)).filter((i) => i.module_name === "inventory");
      const norm = (v: string) => v.trim().toLowerCase();
      const hit = lists.find((i) => norm(i.instance_name) === norm(said) || norm(i.display_name) === norm(said));
      if (!hit) {
        const have = lists.map((i) => (i.is_default ? `${i.instance_name} (Inventory itself)` : `${i.instance_name} ("${i.display_name}")`)).join(", ");
        return { ok: false, error: `there is no list called "${said}". The inventory lists here are: ${have || "inventory"}. Leave instance out to add it to Inventory itself.` };
      }
      instance = hit.is_default ? undefined : hit.instance_name;
    }
    // No name is no item: a call with nothing said used to create "Untitled"
    // and report it made (#3141, the #3133 family). The schema marks it
    // required, so the door refuses first; this is the handler's own word.
    // A name of real values only (record-name.ts, #6283): an app's or an
    // assistant's answer that carried "SKU: None Brand: …" keeps the name.
    const name = recordName(typeof a.name === "string" ? a.name : "").slice(0, 200);
    if (!name) return { ok: false, error: "say what the item is called (name)" };
    const manufacturer = typeof a.manufacturer === "string" && a.manufacturer.trim() ? a.manufacturer.trim().slice(0, 120) : null;
    const locationId = typeof a.location_id === "string" && a.location_id ? a.location_id : null;
    const fields = (a.fields && typeof a.fields === "object" ? a.fields : {}) as Record<string, unknown>;
    const qty = typeof a.qty === "number" ? String(a.qty) : "1";
    const unit = typeof a.unit === "string" && a.unit.trim() ? a.unit.trim().slice(0, 30) : "each";
    // A photo sent with the call (the Cataloging Bench's photo box) is the
    // record's picture and the first in its Photos, never drawn and dropped
    // (#5922). An image_path argument still wins: the caller chose it.
    const photo = ctx.document?.mimeType.startsWith("image/") && ctx.document.bytes.length
      ? await platform().files.write(ctx.orgId, ctx.document.bytes, { filename: ctx.document.name || "photo.png", mimeType: ctx.document.mimeType, photoSource: { kind: "camera", at: new Date().toISOString() } })
      : null;
    if (ctx.document && !photo?.fileId) return { ok: false, error: "The photo could not be kept, so nothing was added. Take it again." };
    const slug = photo?.fileId ? (await platform().orgs.get(ctx.orgId))?.slug : null;
    const imagePath = typeof a.image_path === "string" && a.image_path
      ? a.image_path.slice(0, 500)
      : photo?.fileId && slug ? `/api/v1/orgs/${slug}/modules/core-files/files/${photo.fileId}/raw?variant=medium` : null;

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const created = await db
      .insertInto("inventory_parts")
      .values({
        name,
        qty,
        unit,
        instance,
        manufacturer,
        image_path: imagePath,
        metadata: sql`${JSON.stringify(fields)}::jsonb` as never,
      })
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!created) return { ok: false, error: "create_failed" };

    // Create-then-place (placement-cutover-plan step 1); place() mirrors the
    // legacy column. Fall back to the direct write if placement refuses.
    if (locationId) {
      try {
        await platform().placement.place({
          orgId: ctx.orgId,
          containee: { kind: "inventory:part", id: created.id },
          container: { kind: "core-locations:location", id: locationId },
        });
      } catch {
        await db
          .updateTable("inventory_parts")
          .set({ location_id: locationId })
          .where("id", "=", created.id)
          .execute();
      }
    }

    if (photo?.fileId) await platform().files.attach(ctx.orgId, { fileId: photo.fileId, source_module: "inventory", source_type: "part", source_id: created.id, role: "gallery" });
    await logPartCreated(ctx.orgId, created.id, { name: created.name, qty, instance: instance ?? "inventory" }, ctx.userId);
    await platform().events.emit("inventory.part.created", { orgId: ctx.orgId, partId: created.id });
    return {
      ok: true,
      item_id: created.id,
      name: created.name,
      instance: instance ?? "inventory",
      // The card and the reply say what was made and where; without a
      // sentence the card said only "Add an item".
      summary: `Added ${created.name} (${quantityWithUnit(Number(qty), unit, await platform().units.resolve(ctx.orgId, unit).catch(() => null))}) to ${instance ?? "Inventory"}`,
    };
  });

  // ─────────────────────── create-items (bulk) ─────────────────────
  // Generic bulk create — one INSERT for N items (a kit BOM, a CSV import, a
  // batch from another module). Returns the new ids in input order so the
  // caller can wire pairings. Deliberately does NOT fan out per-item
  // inventory.part.created events (a 700-part expansion shouldn't fire 700
  // wires); a caller that needs a signal emits its own. Each part still gets
  // its History entry, as one made on the form does (#5923). Generic — no use-case.
  platform().actions.registerHandler("inventory.create-items", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const items = Array.isArray(a.items) ? (a.items as Record<string, unknown>[]) : [];
    if (items.length === 0) return { ok: true, ids: [] };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const rows = items.map((o) => ({
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 200) : "Untitled",
      qty: typeof o.qty === "number" ? String(o.qty) : typeof o.qty === "string" && o.qty ? o.qty : "1",
      unit: typeof o.unit === "string" && o.unit.trim() ? o.unit.trim().slice(0, 30) : "each",
      // Omit when not given so the column DEFAULT ('inventory') applies —
      // forcing "" would bury the rows in an empty instance the default
      // list/detail reads (instanceOf → 'inventory') never return.
      instance: typeof o.instance === "string" && o.instance.trim() ? o.instance.trim() : undefined,
      // Bulk keeps the direct column write for now: N place() calls per batch
      // would undo the one-INSERT design, and the sync trigger mirrors it into
      // placement. Converts with the bulk placeMany seam
      // (placement-cutover-plan step 1, bulk special case).
      location_id: typeof o.location_id === "string" && o.location_id ? o.location_id : null,
      manufacturer: typeof o.manufacturer === "string" && o.manufacturer.trim() ? o.manufacturer.trim().slice(0, 120) : null,
      image_path: typeof o.image_path === "string" && o.image_path ? o.image_path : null,
      metadata: sql`${JSON.stringify(o.fields && typeof o.fields === "object" ? o.fields : {})}::jsonb` as never,
    }));
    const inserted = await db.insertInto("inventory_parts").values(rows).returning(["id"]).execute();
    for (const [i, r] of inserted.entries()) await logPartCreated(ctx.orgId, r.id, { name: rows[i]!.name, qty: rows[i]!.qty, instance: rows[i]!.instance ?? "inventory" }, ctx.userId);
    return { ok: true, ids: inserted.map((r) => r.id) };
  });

  // ─────────────────────── update-item ─────────────────────────────
  // Generic field update — set a part's name / brand / location and/or MERGE
  // metadata fields (e.g. mark a kit metadata.lifecycle='parted-out'). The
  // companion to create-item; lets a Tier-B app or another module edit an item
  // through inventory's public interface instead of touching the table. Generic.
  platform().actions.registerHandler("inventory.update-item", (ctx) =>
    withPartUndo(ctx, async () => {
      const a = (ctx.args as Record<string, unknown> | null) ?? {};
      const id = typeof a.id === "string" && a.id ? a.id : (ctx.entity as { id?: string } | null)?.id;
      if (!id) return { ok: false, error: "missing id" };
      const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
      const row = await db.selectFrom("inventory_parts").select("metadata").where("id", "=", id).executeTakeFirst();
      if (!row) return { ok: false, error: "not_found" };
      const set: Record<string, unknown> = { updated_at: new Date() };
      if (typeof a.name === "string" && a.name.trim()) set.name = a.name.trim().slice(0, 200);
      if (typeof a.manufacturer === "string") set.manufacturer = a.manufacturer.trim().slice(0, 120) || null;
      if (a.fields && typeof a.fields === "object") {
        const existing = (row.metadata as Record<string, unknown> | null) ?? {};
        set.metadata = sql`${JSON.stringify({ ...existing, ...(a.fields as Record<string, unknown>) })}::jsonb` as never;
      }
      await db.updateTable("inventory_parts").set(set as never).where("id", "=", id).execute();
      // A location change rides the placement seam (placement-cutover-plan
      // step 1); place()/remove() keep the legacy location_id column mirrored.
      // Fall back to the direct column write if placement refuses.
      if (typeof a.location_id === "string") {
        try {
          if (a.location_id) {
            await platform().placement.place({
              orgId: ctx.orgId,
              containee: { kind: "inventory:part", id },
              container: { kind: "core-locations:location", id: a.location_id },
            });
          } else {
            await platform().placement.remove({
              orgId: ctx.orgId,
              containee: { kind: "inventory:part", id },
            });
          }
        } catch {
          await db.updateTable("inventory_parts")
            .set({ location_id: a.location_id || null } as never)
            .where("id", "=", id)
            .execute();
        }
      }
      await platform().events.emit("inventory.part.updated", { orgId: ctx.orgId, partId: id });
      return { ok: true, id };
    }),
  );

  // ───────────────── lift-to-type (bundle-migration engine) ─────────────────
  // Generic data migration: lift each item in a SOURCE instance into a TYPE in a
  // target instance — deduped by key fields, linked via a pairing, optionally
  // converting the qty unit. This is what turns a flat single-instance bundle
  // (filament 0.3.x: one row per spool) into the type→instances model (a type +
  // its spools) when the user UPGRADES the bundle — no script, no use-case here:
  // the bundle declares the params. Idempotent: skips items already linked, so a
  // re-run (or a re-upgrade) is safe. Args: { source_instance, type_instance,
  // key_fields[], relationship_kind?, convert_qty?: { from_unit, to_unit, factor } }.
  platform().actions.registerHandler("inventory.lift-to-type", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const sourceInstance = typeof a.source_instance === "string" ? a.source_instance : "";
    const typeInstance = typeof a.type_instance === "string" ? a.type_instance : "";
    const keyFields = Array.isArray(a.key_fields) ? (a.key_fields as string[]) : [];
    // Additional fields to copy from the source item onto the TYPE (beyond the
    // dedup key) — the defining attributes that belong on the type, not the unit
    // (e.g. nozzle/bed temp, needs-drying). Taken from the first item of each type.
    const copyFields = Array.isArray(a.copy_fields) ? (a.copy_fields as string[]) : [];
    const rel = typeof a.relationship_kind === "string" && a.relationship_kind ? a.relationship_kind : "instance-of";
    const conv = (a.convert_qty && typeof a.convert_qty === "object" ? a.convert_qty : null) as
      | { from_unit?: string; to_unit?: string; factor?: number }
      | null;
    // Optional: scope the lift to specific source items (by id) instead of the
    // whole source instance. The "lift just this one item I created/scanned"
    // path — the bundle migration omits it (lifts everything); the create-time
    // auto-lift passes the new item's id.
    const sourceIds = Array.isArray(a.source_ids)
      ? (a.source_ids as unknown[]).filter((x): x is string => typeof x === "string")
      : null;
    if (!sourceInstance || !typeInstance || keyFields.length === 0) {
      return { ok: false, error: "missing source_instance / type_instance / key_fields" };
    }

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const NATIVE = columnSet<InventoryDB["inventory_parts"]>()(["name", "manufacturer", "qty", "unit"]);
    const fieldVal = (row: Record<string, unknown>, f: string): string => {
      const v = NATIVE.has(f) ? row[f] : (row.metadata as Record<string, unknown> | null)?.[f];
      return v == null ? "" : String(v).trim().toLowerCase();
    };
    const keyOf = (row: Record<string, unknown>) => keyFields.map((f) => fieldVal(row, f)).join("|");

    let sourcesQ = db
      .selectFrom("inventory_parts").selectAll()
      .where("instance", "=", sourceInstance as never)
      .where("archived", "=", false);
    if (sourceIds) sourcesQ = sourcesQ.where("id", "in", sourceIds as never);
    const sources = await sourcesQ.execute();
    if (sources.length === 0) return { ok: true, types_created: 0, linked: 0, converted: 0 };

    // Dedupe against existing types so a re-run doesn't duplicate them.
    const existingTypes = await db
      .selectFrom("inventory_parts").selectAll()
      .where("instance", "=", typeInstance as never)
      .execute();
    const typeByKey = new Map<string, string>();
    const typeName = new Map<string, string>();
    for (const t of existingTypes) {
      typeByKey.set(keyOf(t as Record<string, unknown>), t.id);
      typeName.set(t.id, t.name);
    }
    // Per source item, the type it sits under now and whether this run made
    // it, so the door that created the item can say so ("added a spool of
    // Royal Blue PLA, a new filament type").
    const placed: Array<{ source_id: string; type_id: string; type_name: string; type_created: boolean }> = [];

    let typesCreated = 0, linked = 0, converted = 0, toppedUp = 0;
    // Types whose copy_fields we've already ensured this run (avoid re-querying
    // for every spool of the same type).
    const toppedUpTypes = new Set<string>();
    const madeNow = new Set<string>();
    for (const s of sources) {
      const meta = (s.metadata as Record<string, unknown> | null) ?? {};
      // Is this spool already linked to a type (from an earlier migration)?
      const pairs = await platform().pairings.findBySources({
        orgId: ctx.orgId, sourceKind: "inventory:part", sourceIds: [s.id],
        targetKind: "inventory:part", relationshipKind: rel,
      });
      let typeId: string | undefined = pairs[0]?.targetId;

      if (!typeId) {
        // Unlinked — find or create the type, link it, convert the unit.
        const k = keyOf(s as Record<string, unknown>);
        typeId = typeByKey.get(k);
        if (!typeId) {
          const typeMeta: Record<string, unknown> = {};
          for (const f of [...keyFields, ...copyFields]) if (!NATIVE.has(f) && meta[f] != null) typeMeta[f] = meta[f];
          // Prefer the item's own (user-given) name — it's the meaningful label
          // ("Royal Blue PLA"); a brand+colour+material composite is the fallback
          // (and would be ugly for filament, whose colour is a hex).
          const nameParts = [s.manufacturer, meta.color, meta.material].filter((x) => x && String(x).trim());
          const name = ((s.name && s.name.trim()) || nameParts.join(" ") || "Untitled type").slice(0, 200);
          // check-then-insert: the only key is the spoolman link, which this insert never sets
          const created = await db
            .insertInto("inventory_parts")
            .values({
              name,
              instance: typeInstance as never,
              manufacturer: s.manufacturer ?? null,
              metadata: sql`${JSON.stringify(typeMeta)}::jsonb` as never,
            })
            .returning(["id"])
            .executeTakeFirst();
          if (!created) continue;
          typeId = created.id;
          typeByKey.set(k, typeId);
          typeName.set(typeId, name);
          madeNow.add(typeId);
          typesCreated++;
          toppedUpTypes.add(typeId); // a fresh type already carries the copy_fields
        }
        await platform().pairings.create({
          orgId: ctx.orgId, sourceKind: "inventory:part", sourceId: s.id,
          targetKind: "inventory:part", targetId: typeId, relationshipKind: rel,
          createdBy: ctx.userId,
        });
        linked++;
        if (conv?.from_unit && conv.to_unit && typeof conv.factor === "number" &&
            String(s.unit).toLowerCase() === conv.from_unit.toLowerCase()) {
          await db.updateTable("inventory_parts")
            .set({ qty: sql`(qty * ${conv.factor})` as never, unit: conv.to_unit })
            .where("id", "=", s.id)
            .execute();
          converted++;
        }
      }

      if (typeId) placed.push({ source_id: s.id, type_id: typeId, type_name: typeName.get(typeId) ?? "", type_created: madeNow.has(typeId) });

      // Ensure the type carries the copy_fields. This runs for ALREADY-LINKED
      // spools too — so a second migration that introduces copy_fields (e.g.
      // moving the temps onto the type) tops up types created by an earlier
      // pass. Only fills MISSING keys, so a user's edit to the type is never
      // clobbered. Once per type per run.
      if (typeId && copyFields.length > 0 && !toppedUpTypes.has(typeId)) {
        toppedUpTypes.add(typeId);
        const add: Record<string, unknown> = {};
        for (const f of copyFields) if (!NATIVE.has(f) && meta[f] != null) add[f] = meta[f];
        if (Object.keys(add).length > 0) {
          // Fill only the keys the type lacks, in one statement against the
          // live row: the type's own values win (`add || existing`), so a
          // user's edit landing meanwhile is never overwritten (#3625).
          const r = await db.updateTable("inventory_parts")
            .set({ metadata: sql`(${JSON.stringify(add)}::jsonb || jsonb_strip_nulls(coalesce(metadata, '{}'::jsonb)))` as never })
            .where("id", "=", typeId)
            .where(sql<boolean>`not (coalesce(metadata, '{}'::jsonb) @> ${JSON.stringify(add)}::jsonb)`)
            .executeTakeFirst();
          if (Number(r.numUpdatedRows ?? 0) > 0) toppedUp++;
        }
      }
    }
    return { ok: true, types_created: typesCreated, linked, converted, topped_up: toppedUp, placed };
  });

  // ─────────────────────── split-lot ───────────────────────────────
  // Split N units off an item's quantity into a NEW separate item, linked to
  // the same parent (so type rollups still count it). The "I entered 5 × 1kg
  // spools as one lot; now I opened one — track it on its own" move. Generic:
  // works on any inventory item with a numeric qty, in any instance — the new
  // item inherits the source's instance, fields, manufacturer, location, image,
  // and parent pairing(s). Default split = 1 (the common "open one" case); pass
  // a `quantity` arg for more. The lot must keep ≥1 — you can't split off the
  // whole lot (that would just be the single item you'd end up with).
  platform().actions.registerHandler("inventory.split-lot", async (ctx) => {
    const a = (ctx.args as { partId?: string; quantity?: number } | null) ?? {};
    const partId = a.partId ?? (ctx.entity as { id?: string } | null)?.id;
    const splitQty = typeof a.quantity === "number" && a.quantity > 0 ? a.quantity : 1;
    if (!partId) return { ok: false, error: "missing partId" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const src = await db
      .selectFrom("inventory_parts")
      .select([
        "id", "name", "qty", "unit", "instance",
        "manufacturer", "location_id", "image_path", "metadata",
      ])
      .where("id", "=", partId)
      .executeTakeFirst();
    if (!src) return { ok: false, error: "part_not_found" };

    const srcQty = Number(src.qty);
    if (!Number.isFinite(srcQty) || srcQty - splitQty < 1) {
      return {
        ok: false,
        error: "nothing_to_split",
        message: `The lot must keep at least 1 after the split (have ${srcQty}, splitting ${splitQty}).`,
      };
    }

    // 1. Decrement the lot.
    await db
      .updateTable("inventory_parts")
      .set({ qty: sql<string>`qty - ${splitQty}::numeric`, updated_at: new Date() })
      .where("id", "=", partId)
      .execute();

    // 2. Create the split-off item — same instance + fields, its own qty.
    // check-then-insert: the only key is the spoolman link, which this insert never sets
    const created = await db
      .insertInto("inventory_parts")
      .values({
        name: src.name,
        qty: String(splitQty),
        unit: src.unit,
        instance: src.instance as never,
        manufacturer: src.manufacturer ?? null,
        image_path: src.image_path ?? null,
        metadata: sql`${JSON.stringify((src.metadata as Record<string, unknown> | null) ?? {})}::jsonb` as never,
      })
      .returning(["id"])
      .executeTakeFirst();
    if (!created) return { ok: false, error: "create_failed" };

    // The split-off item inherits the lot's home via the placement seam
    // (placement-cutover-plan step 1); fallback: direct column write.
    if (src.location_id) {
      try {
        await platform().placement.place({
          orgId: ctx.orgId,
          containee: { kind: "inventory:part", id: created.id },
          container: { kind: "core-locations:location", id: src.location_id },
        });
      } catch {
        await db.updateTable("inventory_parts").set({ location_id: src.location_id }).where("id", "=", created.id).execute();
      }
    }

    // 3. Inherit the lot's parent pairing(s) (e.g. instance-of its type) so
    //    type rollups count the split-off item too.
    let linkedToType = false;
    const parents = await platform().pairings.findBySources({
      orgId: ctx.orgId, sourceKind: "inventory:part", sourceIds: [partId],
      targetKind: "inventory:part", relationshipKind: "instance-of",
    });
    for (const p of parents) {
      await platform().pairings.create({
        orgId: ctx.orgId, sourceKind: "inventory:part", sourceId: created.id,
        targetKind: "inventory:part", targetId: p.targetId, relationshipKind: "instance-of",
        createdBy: ctx.userId,
      });
      linkedToType = true;
    }

    // 4. Events: the lot's stock fell; a new item exists.
    // Moved, not used: no statement line (the burn rate would read it as
    // use) and no low stock (the split-off record still holds it).
    await stockMoved(db, ctx.orgId, {
      partId, delta: -splitQty, newQty: srcQty - splitQty, minQty: null, reason: "split-lot", ledger: false, announceLow: false,
    });
    await platform().events.emit("inventory.part.created", { orgId: ctx.orgId, partId: created.id });

    return { ok: true, sourceId: partId, newId: created.id, newQty: srcQty - splitQty, splitQty, linkedToType };
  });

  // ── Allocations ──────────────────────────────────────────────────────────
  //
  // Reserving stock for a project, and later consuming or releasing that
  // reservation, are ordinary things to ask for and had no door: inventory's
  // twelve actions covered stock movement and not allocations. They were the
  // last capability left open by the reach audit, held back because consuming
  // one MOVES STOCK and writes a consumption ledger row in a single
  // transaction - a second copy of that is how a running balance comes to
  // disagree with reality (consumption-ledger.md §7.3 records that happening
  // once already).
  //
  // So neither handler reimplements anything: both call the same
  // reserveAllocation / settleAllocation the HTTP routes call.

  platform().actions.registerHandler("inventory.reserve-stock", async (ctx) => {
    const part = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const qty = typeof args.qty === "number" ? args.qty : Number(args.qty);
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "say how much to reserve (a positive qty)" };

    const forKind = typeof args.for_kind === "string" ? args.for_kind.trim() : "";
    const forId = typeof args.for_id === "string" ? args.for_id.trim() : "";
    if (!forKind || !forId) {
      return {
        ok: false,
        error: "say what the stock is reserved FOR: for_kind (e.g. projects:project) and for_id, which list_records gives you",
      };
    }
    // A kind id is "<module>:<type>"; the allocation stores those separately so
    // a consumer module can find its own reservations without knowing ours.
    const [targetModule, targetType] = forKind.includes(":")
      ? [forKind.split(":")[0]!, forKind.split(":")[1]!]
      : [forKind, forKind];

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const out = await reserveAllocation(db as never, ctx.orgId, ctx.userId ?? "", {
      part_id: part.id,
      qty,
      target_module: targetModule,
      target_entity_type: targetType,
      target_entity_id: forId,
      reason: typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : null,
    });
    if (!out.ok) return { ok: false, error: "that part no longer exists" };
    return {
      ok: true,
      allocation_id: out.row.id,
      qty,
      note: "Reserved. Stock does not move until the reservation is consumed.",
    };
  });

  platform().actions.registerHandler("inventory.settle-allocation", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const id = typeof args.allocation_id === "string" ? args.allocation_id.trim() : "";
    const status = args.status === "released" ? "released" : args.status === "consumed" ? "consumed" : null;
    if (!id) return { ok: false, error: "pass allocation_id - reading a part's allocations gives you the ids" };
    if (!status) return { ok: false, error: 'pass status: "consumed" (the stock was used) or "released" (put it back)' };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const out = await settleAllocation(db as never, ctx.orgId, ctx.userId ?? "", id, status);
    if (!out.ok) {
      return out.code === "not_found"
        ? { ok: false, error: `no allocation with id ${id}` }
        : { ok: false, error: `that allocation is already ${out.status}, so there is nothing to settle` };
    }
    return {
      ok: true,
      allocation_id: out.next.id,
      status: out.next.status,
      note:
        status === "consumed"
          ? `Consumed ${out.qty}: stock is down by that much and the withdrawal is on the part's statement.`
          : `Released ${out.qty} back: stock was never taken, the reservation is simply gone.`,
    };
  });
  // ── the way back, registered beside the handlers above ────────────────────
  platform().actions.registerHandler("inventory.restore-part", (ctx) => withPartUndo(ctx, () => restorePart(ctx)));
  platform().actions.registerUndo("inventory.adjust-stock", partUndoStep);
  platform().actions.registerUndo("inventory.use-one", partUndoStep);
  platform().actions.registerUndo("inventory.restock-one", partUndoStep);
  platform().actions.registerUndo("inventory.swap-fresh", partUndoStep);
  platform().actions.registerUndo("inventory.mark-opened", partUndoStep);
  platform().actions.registerUndo("inventory.mark-finished", partUndoStep);
  platform().actions.registerUndo("inventory.mark-spoiled", partUndoStep);
  platform().actions.registerUndo("inventory.use-up", partUndoStep);
  platform().actions.registerUndo("inventory.still-good", partUndoStep);
  platform().actions.registerUndo("inventory.replaced", partUndoStep);
  platform().actions.registerUndo("inventory.set-stock", partUndoStep);
  platform().actions.registerUndo("inventory.set-status", partUndoStep);
  platform().actions.registerUndo("inventory.update-item", partUndoStep);
  platform().actions.registerUndo("inventory.restore-part", partUndoStep);
  // A created item is deleted again, through the record rail: that delete is
  // itself ledgered with the row, so undoing the undo brings it back whole.
  platform().actions.registerUndo("inventory.create-item", (result) => {
    const r = result as { item_id?: unknown; instance?: unknown } | null;
    if (typeof r?.item_id !== "string") return null;
    const instance = typeof r.instance === "string" && r.instance ? r.instance : "inventory";
    return { tool: "delete", entity_kind: instance === "inventory" ? "inventory:part" : `${instance}:item`, entity_id: r.item_id };
  });
  // A reservation is released; a settled one is reopened, and consumed stock
  // comes back through the stock path.
  platform().actions.registerUndo("inventory.reserve-stock", (result) => {
    const r = result as { allocation_id?: unknown } | null;
    if (typeof r?.allocation_id !== "string") return null;
    return { action_id: "inventory:settle-allocation", args: { allocation_id: r.allocation_id, status: "released" } };
  });
  platform().actions.registerUndo("inventory.settle-allocation", (result) => {
    const r = result as { allocation_id?: unknown; status?: unknown } | null;
    if (typeof r?.allocation_id !== "string") return null;
    return { action_id: "inventory:reopen-allocation", args: { allocation_id: r.allocation_id } };
  });
  platform().actions.registerHandler("inventory.reopen-allocation", async (ctx) => {
    const id = String((ctx.args as { allocation_id?: unknown } | null)?.allocation_id ?? "").trim();
    if (!id) return { ok: false, error: "missing allocation_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const row = await db
      .selectFrom("inventory_allocations")
      .select(["id", "part_id", "qty", "status"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return { ok: false, error: `no allocation with id ${id}` };
    if (row.status === "reserved") return { ok: true, skipped: true, reason: "still reserved" };
    if (row.status === "consumed") {
      const back = await applyStockDelta(ctx.orgId, { partId: row.part_id, delta: Number(row.qty), reason: "put back (reservation reopened)" });
      if (back.ok !== true) return back;
    }
    await db
      .updateTable("inventory_allocations")
      .set({ status: "reserved", consumed_at: null, released_at: null })
      .where("id", "=", id)
      .execute();
    return { ok: true, summary: `Reopened the reservation of ${row.qty}.`, allocation_id: id, was: row.status };
  });
  // Reopening is undone by settling it again the way it was.
  platform().actions.registerUndo("inventory.reopen-allocation", (result) => {
    const r = result as { allocation_id?: unknown; was?: unknown } | null;
    if (typeof r?.allocation_id !== "string" || (r.was !== "consumed" && r.was !== "released")) return null;
    return { action_id: "inventory:settle-allocation", args: { allocation_id: r.allocation_id, status: r.was } };
  });
}
