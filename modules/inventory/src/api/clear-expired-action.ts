// Clear what's past its date (inventory:clear-expired): the handler its manifest entry names. Wired in ./index.ts.
// "Clear what's past its date": every unit of every lot dated before today, in
// one transaction, for a list of records or a whole list (#9274).
//
// What the one-record buttons could not do for a backlog: they end ONE unit of
// the oldest lot, so a record holding four took four presses; they ran as a
// client loop, so a dropped connection left it half done; and each press taught
// a shelf life from a lot that sat for two months in a cupboard. This ends the
// lot, all of it, keeps any fresher lot, and teaches nothing: no shelf-life
// observation, no ledger line the burn rate reads (a correction), no running-low
// event, so nothing lands on the shopping list because of a cleanup. Waste is
// the one thing it says, and only when the person said "threw out".

import type { Kysely } from "kysely";
import { ActionRefusal, platform, readListArg, type ActionInvokeContext } from "@cobblr/platform-contract";
import type { ActionUndoStep } from "@cobblr/platform-contract/action-undo";
import type { InventoryDB } from "../db.js";
import { batchesFrom, clearPastDate, reconcileToQty, type Batch } from "../batches.js";
import { observation } from "../observations.js";
import { stockMoved } from "./stock-moved.js";
import {
  announce,
  isGone,
  partSnapshot,
  partUndoState,
  personToday,
  prepareBatches,
  withBatchesIn,
  type BatchPrep,
  type PartUndoState,
} from "./action-handlers.js";

/** Records one run may clear: a sweep of a workspace's pantry is a few dozen, and
 *  one transaction should not hold thousands of row locks. */
export const MAX_CLEARED = 500;

interface Args {
  partIds?: unknown;
  instance?: unknown;
  ended?: unknown;
  timezone?: unknown;
  dry_run?: unknown;
}

interface Planned {
  id: string;
  name: string;
  units: number;
  lots: Batch[];
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The whole of a record's lots as the stock write reads them. */
function lotsOf(row: { qty: unknown; metadata: unknown }, expiryField: string | null): Batch[] {
  const md = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const roleDate = expiryField ? md[expiryField] : undefined;
  const expiresOn = typeof md.expires_on === "string" && md.expires_on ? md.expires_on : typeof roleDate === "string" && roleDate ? roleDate : null;
  const qty = Number(row.qty);
  return reconcileToQty(batchesFrom(md, qty, expiresOn), qty);
}

async function clearExpired(ctx: ActionInvokeContext): Promise<Record<string, unknown>> {
  const args = (ctx.args as Args | null) ?? {};
  const ended = args.ended === "spoiled" || args.ended === "discarded" ? "spoiled" : "used";
  const timezone = text(args.timezone);
  const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
  const today = await personToday(ctx.userId, timezone);

  let ids: string[];
  let more = false;
  const named = readListArg(ctx.args as Record<string, unknown> | undefined, "partIds");
  if (named.length > 0) {
    ids = [...new Set(named)];
    if (ids.length > MAX_CLEARED) throw new ActionRefusal(`Clear at most ${MAX_CLEARED} items at a time.`);
  } else if (text(args.instance)) {
    const rows = await db
      .selectFrom("inventory_parts")
      .select("id")
      .where("instance", "=", text(args.instance) as never)
      .where("archived", "=", false)
      .where("qty", ">", 0 as never)
      .orderBy("id")
      .limit(MAX_CLEARED + 1)
      .execute();
    more = rows.length > MAX_CLEARED;
    ids = rows.slice(0, MAX_CLEARED).map((r) => r.id);
  } else {
    throw new ActionRefusal("Say which items to clear, or which list.");
  }

  const rows = ids.length
    ? await db.selectFrom("inventory_parts").select(["id", "name", "qty", "metadata", "instance"]).where("id", "in", ids).where("archived", "=", false).execute()
    : [];

  // The expiry field is the list's own, by role: asked once per list, never
  // per record, and before the transaction takes its connection.
  const preps = new Map<string, BatchPrep>();
  for (const r of rows) {
    const key = String(r.instance ?? "");
    if (!preps.has(key)) preps.set(key, await prepareBatches(ctx.orgId, r.id, { ...(timezone ? { timezone } : {}), userId: ctx.userId }));
  }
  const prepOf = (r: { instance: unknown }): BatchPrep => ({ ...(preps.get(String(r.instance ?? "")) as BatchPrep), today });

  const plan: Planned[] = [];
  for (const r of rows) {
    if (isGone(r.metadata)) continue;
    const { cleared, units } = clearPastDate(lotsOf(r, prepOf(r).roles?.expiry ?? null), today);
    if (units > 0) plan.push({ id: r.id, name: r.name, units, lots: cleared });
  }
  plan.sort((a, b) => a.id.localeCompare(b.id));
  const units = plan.reduce((n, p) => n + p.units, 0);

  if (args.dry_run === true || args.dry_run === "true") {
    return { ok: true, dry_run: true, records: plan.map((p) => ({ id: p.id, name: p.name, units: p.units })), cleared: plan.length, units, ...(more ? { more: true } : {}) };
  }
  if (plan.length === 0) return { ok: true, skipped: true, cleared: 0, units: 0, summary: "Nothing is past its date.", ...(more ? { more: true } : {}) };

  const before = new Map<string, Awaited<ReturnType<typeof partSnapshot>>>();
  for (const p of plan) before.set(p.id, await partSnapshot(ctx.orgId, p.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const skipped: Array<{ id: string; name: string; why: string }> = [];
  const cleared: Planned[] = [];
  const moved: Array<{ id: string; delta: number; newQty: number; minQty: number | null }> = [];

  // One transaction: a failure on the fortieth record leaves the other thirty-nine
  // as they were. Each record is read again under its own row lock, so what is
  // cleared is what is past its date NOW, not what the plan saw a moment ago.
  await db.transaction().execute(async (trx) => {
    for (const p of plan) {
      const r = byId.get(p.id)!;
      const prep = prepOf(r);
      const fresh = await trx.selectFrom("inventory_parts").select(["qty", "metadata"]).where("id", "=", p.id).forUpdate().executeTakeFirst();
      if (!fresh) continue;
      const now = clearPastDate(lotsOf(fresh, prep.roles?.expiry ?? null), today);
      if (now.units <= 0) continue;
      const run = await withBatchesIn(trx, ctx.orgId, p.id, "cleared what was past its date", -now.units, (lots) => clearPastDate(lots, today).batches, { correction: true, userId: ctx.userId, ...(timezone ? { timezone } : {}) }, prep);
      if (run.out.ok === false || (run.out as { skipped?: unknown }).skipped) {
        skipped.push({ id: p.id, name: p.name, why: String(run.out.error ?? run.out.reason ?? "it could not be changed") });
        continue;
      }
      const updated = run.movement?.updated;
      cleared.push({ ...p, units: now.units, lots: now.cleared });
      if (updated) moved.push({ id: p.id, delta: -now.units, newQty: Number(updated.qty), minQty: updated.min_qty == null ? null : Number(updated.min_qty) });
    }
  });

  // After the commit: what listeners are told, never a running-low (a cleanup is
  // not the person running out), and the waste only when they said threw out.
  const clearedUnits = cleared.reduce((n, p) => n + p.units, 0);
  for (const m of moved) {
    await stockMoved(db, ctx.orgId, { partId: m.id, delta: m.delta, newQty: m.newQty, minQty: m.minQty, reason: "cleared what was past its date", ledger: false, announceLow: false });
  }
  if (ended === "spoiled") for (const p of cleared) await announce(ctx.orgId, ctx.userId, { ok: true }, [observation(p.id, "discard", -p.units)]);
  await platform().events.emit("inventory.part.updated", { orgId: ctx.orgId, partIds: cleared.map((p) => p.id) });

  const undoStates: PartUndoState[] = [];
  for (const p of cleared) {
    const b = before.get(p.id);
    const a = await partSnapshot(ctx.orgId, p.id);
    const state = b && a ? partUndoState(p.id, b, a) : null;
    if (state) undoStates.push(state);
  }
  return {
    ok: true,
    ended,
    cleared: cleared.length,
    units: clearedUnits,
    records: cleared.map((p) => ({ id: p.id, name: p.name, units: p.units })),
    ...(skipped.length ? { skipped } : {}),
    ...(more ? { more: true } : {}),
    summary: `${ended === "spoiled" ? "Threw out" : "Used up"} ${cleared.length} ${cleared.length === 1 ? "item" : "items"} (${clearedUnits} ${clearedUnits === 1 ? "unit" : "units"}) past their date.`,
    ...(undoStates.length ? { undo_states: undoStates } : {}),
  };
}

/** One step per record the run changed: each put back the way it was, its
 *  count and its lots and its dates together. */
function clearExpiredUndo(result: unknown): ActionUndoStep[] | null {
  const states = (result as { undo_states?: PartUndoState[] } | null)?.undo_states;
  if (!Array.isArray(states) || states.length === 0) return null;
  return states.filter((s) => typeof s?.partId === "string").map((s) => ({ action_id: "inventory:restore-part", args: { ...s } }));
}

export function registerClearExpiredAction(): void {
  platform().actions.registerHandler("inventory.clear-expired", clearExpired);
  platform().actions.registerUndo("inventory.clear-expired", clearExpiredUndo);
}
