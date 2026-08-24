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

import { sql, type Kysely } from "kysely";
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";
import { recordConsumption } from "./stock-ledger.js";
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
  consumeOldest,
  reconcileToQty,
  visibleFrom,
  expiryFor,
  localToday,
  type Batch,
} from "../batches.js";

let registered = false;

interface AdjustStockPayload {
  partId?: string;
  delta?: number;
  reason?: string;
  // Optional source attribution for the consumption ledger — e.g. the wire
  // fired by digifab.print.completed passes sourceKind:"digifab:job" + the job id.
  sourceKind?: string;
  sourceId?: string;
}

/** The core stock-delta path, shared by adjust-stock (wire/HTTP) and the
 *  one-tap consume actions (use-one/use-up). Applies the delta, writes the
 *  consumption ledger, re-emits stock.changed, and fires stock.low on a
 *  decrease at/below min_qty — so every consumption route trips the same
 *  "running low → shopping list" wire. Honours the tracked_by external-tracker
 *  opt-out. A non-zero `delta` is assumed (callers guard). */
async function applyStockDelta(
  orgId: string,
  p: { partId: string; delta: number; reason: string; sourceKind?: string | null; sourceId?: string | null },
): Promise<Record<string, unknown>> {
  const { partId, delta, reason } = p;
  const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;

  // Externally-tracked stock (e.g. a Spoolman spool, metadata.tracked_by): the
  // external system counts usage and Cobblr mirrors it on sync — mutating here
  // too would double-count. Generic — any external tracker opts a part out.
  const ext = await db
    .selectFrom("inventory_parts")
    .select(sql<string | null>`metadata->>'tracked_by'`.as("tracked_by"))
    .where("id", "=", partId)
    .executeTakeFirst();
  if (ext?.tracked_by) {
    return { ok: true, skipped: true, reason: `externally tracked by ${ext.tracked_by}` };
  }

  const updated = await db
    .updateTable("inventory_parts")
    .set({ qty: sql<string>`qty + ${delta}::numeric`, updated_at: new Date() })
    .where("id", "=", partId)
    .returning(["id", "name", "qty", "min_qty"])
    .executeTakeFirst();
  if (!updated) return { ok: false, error: "part_not_found" };

  // Consumption ledger (append-only): WHAT drew the part down and HOW MUCH —
  // also the raw data the burn-rate predictor reads. Through the ONE shared
  // writer (stock-ledger.ts) so every qty path leaves the same statement line.
  // Best-effort here; a ledger hiccup must never fail a standalone stock change.
  try {
    await recordConsumption(db, {
      partId,
      delta,
      reason: reason ?? null,
      sourceKind: p.sourceKind ?? null,
      sourceId: p.sourceId ?? null,
    });
  } catch (e) {
    console.error("[inventory.applyStockDelta] ledger write failed:", (e as Error).message);
  }

  await platform().events.emit("inventory.stock.changed", {
    orgId,
    partId: updated.id,
    delta,
    newQty: Number(updated.qty),
    reason,
  });

  // Low-stock signal on a DECREASE landing at/below min_qty (only decreases, so
  // a restock doesn't re-alert). This is what trips "running low → shopping
  // list", so a one-tap "use one" that crosses the threshold reorders for free.
  const newQty = Number(updated.qty);
  const minQty = updated.min_qty == null ? null : Number(updated.min_qty);
  if (delta < 0 && minQty != null && minQty > 0 && newQty <= minQty) {
    await platform().events.emit("inventory.stock.low", { orgId, partId: updated.id, newQty, minQty });
  }
  return { ok: true, partId: updated.id, delta, newQty };
}

export function registerInventoryActionHandlers(): void {
  if (registered) return;
  registered = true;

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

    const writer = platform().entities.getWriter("core-locations:location");
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

  platform().actions.registerHandler("inventory.adjust-stock", async (ctx) => {
    // Args take precedence (an admin can hardwire a wire to "always
    // add 1"); otherwise we pull from the event payload.
    const args = (ctx.args as AdjustStockPayload | null) ?? {};
    const ev = (ctx.event?.payload as AdjustStockPayload | null) ?? {};
    const partId = args.partId ?? ev.partId;
    const delta = args.delta ?? ev.delta;
    const reason = args.reason ?? ev.reason ?? "wire-driven adjustment";
    if (!partId || typeof delta !== "number" || delta === 0) {
      return { ok: true, skipped: true, reason: "missing partId or delta" };
    }
    return applyStockDelta(ctx.orgId, {
      partId,
      delta,
      reason,
      sourceKind: args.sourceKind ?? ev.sourceKind,
      sourceId: args.sourceId ?? ev.sourceId,
    });
  });


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
async function withBatches(
  orgId: string,
  partId: string,
  reason: string,
  delta: number,
  mutate: (batches: Batch[], ctx: { today: string; shelfLifeDays: number | null }) => Batch[],
  opts: { timezone?: string } = {},
): Promise<Record<string, unknown>> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
  const row = await db
    .selectFrom("inventory_parts")
    .select(["id", "qty", "metadata"])
    .where("id", "=", partId)
    .executeTakeFirst();
  if (!row) return { ok: false, error: "missing_part" };

  const md = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const qtyNow = Number(row.qty);
  const expiresOn = typeof md.expires_on === "string" ? md.expires_on : null;

  const current = reconcileToQty(batchesFrom(md, qtyNow, expiresOn), qtyNow);
  const shelfLifeDays =
    typeof md.shelf_life_days === "number" && md.shelf_life_days > 0 ? md.shelf_life_days : null;
  const today = localToday(new Date(), opts.timezone ?? "UTC");

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
  const qtyAfter = Math.max(0, qtyNow + delta);
  const next = reconcileToQty(mutate(current, { today, shelfLifeDays }), qtyAfter);
  const visible = visibleFrom(next);

  // Metadata first, so a failure in the stock write leaves the lots describing
  // what is really there rather than what we hoped to do.
  await db
    .updateTable("inventory_parts")
    .set({
      metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({
        batches: next,
        ...(visible.expires_on !== null ? { expires_on: visible.expires_on } : {}),
      })}::jsonb`,
    })
    .where("id", "=", partId)
    .execute();

  // Through the normal path, so the consumption ledger, stock.changed and the
  // running-low wire all fire exactly as they do for any other stock move.
  const applied =
    delta === 0 ? { ok: true, skipped: true, reason: "no quantity change" } : await applyStockDelta(orgId, { partId, delta, reason });

  return { ...applied, batches: next, expires_on: visible.expires_on, qty: qtyAfter };
}

  // ───────────── one-tap consumption (P1 — consumption capture) ─────────────
  // The binary "used" signal, at the moment you're already handling the item —
  // NO number entry (that's the typed StockAdjust popup, kept for when you DO
  // want exact). userInvokable, unlike adjust-stock: these are buttons a person
  // taps. Both decrement through applyStockDelta, so the ledger, stock.changed,
  // and the stock.low → shopping-list wire all fire for free.

  // Use one: knock a single unit off. The everyday tap ("took one out").
  platform().actions.registerHandler("inventory.use-one", async (ctx) => {
    const partId = ctx.entity?.id ?? (ctx.args as { partId?: string } | null)?.partId;
    if (!partId) return { ok: false, error: "missing_part" };
    const tz = (ctx.args as { timezone?: string } | null)?.timezone;
    // Always the OLDEST lot. It is the one the warning named, so taking from
    // anywhere else would leave the warning standing after the user did what it
    // asked - and once that lot empties the deadline moves on by itself.
    return withBatches(
      ctx.orgId,
      partId,
      "used one",
      -1,
      (batches) => consumeOldest(batches, 1).batches,
      { ...(tz ? { timezone: tz } : {}) },
    );
  });

  // Restock one: another arrived today, good until its own date. NOT qty + 1 -
  // a container arriving today has its own shelf life, and incrementing a count
  // would leave it inheriting the previous lot's deadline.
  platform().actions.registerHandler("inventory.restock-one", async (ctx) => {
    const args = (ctx.args as { partId?: string; qty?: number; timezone?: string } | null) ?? {};
    const partId = ctx.entity?.id ?? args.partId;
    if (!partId) return { ok: false, error: "missing_part" };
    const add = Math.max(1, Math.trunc(Number(args.qty ?? 1)));
    return withBatches(
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
      { ...(args.timezone ? { timezone: args.timezone } : {}) },
    );
  });


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
  ): Promise<Record<string, unknown>> {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
    const row = await db
      .selectFrom("inventory_parts")
      .select(["qty", "metadata", "created_at"])
      .where("id", "=", partId)
      .executeTakeFirst();
    if (!row) return { ok: false, error: "missing_part" };
    const md = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    const today = localToday(new Date(), timezone ?? "UTC");
    const lots = reconcileToQty(
      batchesFrom(md, Number(row.qty), typeof md.expires_on === "string" ? md.expires_on : null),
      Number(row.qty),
    );
    const oldest = lots[0];

    const result = await withBatches(orgId, partId, reason, -1, (batches) => consumeOldest(batches, 1).batches, {
      ...(timezone ? { timezone } : {}),
    });

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
  platform().actions.registerHandler("inventory.mark-opened", async (ctx) => {
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
    const md = ((row.metadata as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
    const today = localToday(new Date(), args.timezone ?? "UTC");
    const openedDays =
      typeof md.shelf_life_opened_days === "number" && md.shelf_life_opened_days > 0
        ? md.shelf_life_opened_days
        : null;
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
  });

  // Used up: finished it. A LOWER BOUND on the shelf life, never a measurement.
  platform().actions.registerHandler("inventory.mark-finished", async (ctx) => {
    const args = (ctx.args as { partId?: string; timezone?: string } | null) ?? {};
    const partId = ctx.entity?.id ?? args.partId;
    if (!partId) return { ok: false, error: "missing_part" };
    return endOldestLot(ctx.orgId, partId, "used", args.timezone, "finished it");
  });

  // Threw it out: it went bad. THE measurement, and the only thing that ever
  // teaches a shelf life. Also a cadence discard, which is what feeds the
  // buy-less advice - the signal that says somebody is over-buying.
  platform().actions.registerHandler("inventory.mark-spoiled", async (ctx) => {
    const args = (ctx.args as { partId?: string; timezone?: string } | null) ?? {};
    const partId = ctx.entity?.id ?? args.partId;
    if (!partId) return { ok: false, error: "missing_part" };
    return endOldestLot(ctx.orgId, partId, "spoiled", args.timezone, "threw it out");
  });

  // Used up: it's gone (tossing the empty). Drive on-hand to 0 in one tap —
  // no "how many left?" guess. Reads current qty and deltas it to zero so the
  // ledger + low-stock path stay uniform; a no-op if already 0.
  platform().actions.registerHandler("inventory.use-up", async (ctx) => {
    const partId = ctx.entity?.id ?? (ctx.args as { partId?: string } | null)?.partId;
    if (!partId) return { ok: false, error: "missing_part" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const row = await db
      .selectFrom("inventory_parts")
      .select(["qty"])
      .where("id", "=", partId)
      .executeTakeFirst();
    if (!row) return { ok: false, error: "part_not_found" };
    const cur = Number(row.qty);
    if (!(cur > 0)) return { ok: true, partId, delta: 0, newQty: cur, note: "already empty" };
    return applyStockDelta(ctx.orgId, { partId, delta: -cur, reason: "used up" });
  });

  // ───────── Replaced (P2 — the replace-clock's one tap) ─────────
  // The single tap you make at the moment of a scheduled swap (furnace filter,
  // water filter, printer nozzle): (a) reset the clock — stamp last_replaced_at
  // = now, so the recurrence scanner re-anchors and won't nag again until the
  // next interval; (b) consume a spare — knock one off on-hand, which (via the
  // shared decrement) trips stock.low → shopping list if you're now short. So
  // "Replaced" = reset + consume-spare + maybe-reorder, in one tap.
  platform().actions.registerHandler("inventory.replaced", async (ctx) => {
    const partId = ctx.entity?.id ?? (ctx.args as { partId?: string } | null)?.partId;
    if (!partId) return { ok: false, error: "missing_part" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
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
  });

  // ─────────────────────── set-stock ───────────────────────────────
  // Set a part's on-hand qty to an ABSOLUTE value (not a delta). The
  // natural op for a scale ("grams remaining"), a stocktake, or a recount —
  // adjust-stock can't express "set to N" without a racy read-then-delta.
  // Same downstream signals as adjust-stock (stock.changed + low-stock).
  platform().actions.registerHandler("inventory.set-stock", async (ctx) => {
    const args = (ctx.args as { partId?: string; qty?: number; reason?: string } | null) ?? {};
    const ev = (ctx.event?.payload as { partId?: string; qty?: number } | null) ?? {};
    const partId = args.partId ?? ev.partId;
    const qty = args.qty ?? ev.qty;
    const reason = args.reason ?? "set to an absolute value";
    if (!partId || typeof qty !== "number" || qty < 0) {
      return { ok: true, skipped: true, reason: "missing partId or a non-negative qty" };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const updated = await db
      .updateTable("inventory_parts")
      .set({ qty: sql<string>`${qty}::numeric`, updated_at: new Date() })
      .where("id", "=", partId)
      .returning(["id", "name", "qty", "min_qty"])
      .executeTakeFirst();
    if (!updated) return { ok: false, error: "part_not_found" };
    const newQty = Number(updated.qty);
    await platform().events.emit("inventory.stock.changed", {
      orgId: ctx.orgId,
      partId: updated.id,
      newQty,
      reason,
    });
    const minQty = updated.min_qty == null ? null : Number(updated.min_qty);
    if (minQty != null && minQty > 0 && newQty <= minQty) {
      await platform().events.emit("inventory.stock.low", {
        orgId: ctx.orgId,
        partId: updated.id,
        newQty,
        minQty,
      });
    }
    return { ok: true, partId: updated.id, newQty };
  });

  // ─────────────────────── set-status ──────────────────────────────
  // A small, member-appropriate write: set a part's metadata.status
  // (the Lego set Built/Unbuilt/Missing-pieces field). This is the
  // canonical action a custom (Tier B) app block invokes — capability
  // -gated (`inventory:set-status`) like any other, so a worker can only
  // run it if granted. partId comes from args or the targeted entity.
  platform().actions.registerHandler("inventory.set-status", async (ctx) => {
    const args = (ctx.args as { partId?: string; status?: string } | null) ?? {};
    const partId = args.partId ?? (ctx.entity as { id?: string } | null)?.id;
    const status = typeof args.status === "string" ? args.status.trim().slice(0, 60) : undefined;
    if (!partId || !status) return { ok: false, error: "missing partId or status" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const row = await db
      .selectFrom("inventory_parts")
      .select(["metadata"])
      .where("id", "=", partId)
      .executeTakeFirst();
    if (!row) return { ok: false, error: "part_not_found" };
    await db
      .updateTable("inventory_parts")
      .set({
        // Overlay just `status`, DB-side — a part's metadata is multi-writer (the
        // Lego lifecycle, scan-confirm fields, connector namespaces), and a
        // snapshot rewrite that set status dropped whatever else had changed.
        metadata: sql`coalesce(metadata, '{}'::jsonb) || ${JSON.stringify({ status })}::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", partId)
      .execute();
    return { ok: true, partId, status };
  });

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
    const instance = typeof a.instance === "string" && a.instance.trim() ? a.instance.trim() : undefined;
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 200) : "Untitled";
    const manufacturer = typeof a.manufacturer === "string" && a.manufacturer.trim() ? a.manufacturer.trim().slice(0, 120) : null;
    const locationId = typeof a.location_id === "string" && a.location_id ? a.location_id : null;
    const fields = (a.fields && typeof a.fields === "object" ? a.fields : {}) as Record<string, unknown>;
    const qty = typeof a.qty === "number" ? String(a.qty) : "1";
    const unit = typeof a.unit === "string" && a.unit.trim() ? a.unit.trim().slice(0, 30) : "each";
    const imagePath = typeof a.image_path === "string" && a.image_path ? a.image_path.slice(0, 500) : null;

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

    await platform().events.emit("inventory.part.created", { orgId: ctx.orgId, partId: created.id });
    return { ok: true, item_id: created.id, name: created.name };
  });

  // ─────────────────────── create-items (bulk) ─────────────────────
  // Generic bulk create — one INSERT for N items (a kit BOM, a CSV import, a
  // batch from another module). Returns the new ids in input order so the
  // caller can wire pairings. Deliberately does NOT fan out per-item
  // inventory.part.created events (a 700-part expansion shouldn't fire 700
  // wires); a caller that needs a signal emits its own. Generic — no use-case.
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
    return { ok: true, ids: inserted.map((r) => r.id) };
  });

  // ─────────────────────── update-item ─────────────────────────────
  // Generic field update — set a part's name / brand / location and/or MERGE
  // metadata fields (e.g. mark a kit metadata.lifecycle='parted-out'). The
  // companion to create-item; lets a Tier-B app or another module edit an item
  // through inventory's public interface instead of touching the table. Generic.
  platform().actions.registerHandler("inventory.update-item", async (ctx) => {
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
  });

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
    const NATIVE = new Set(["name", "manufacturer", "qty", "unit"]);
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
    for (const t of existingTypes) typeByKey.set(keyOf(t as Record<string, unknown>), t.id);

    let typesCreated = 0, linked = 0, converted = 0, toppedUp = 0;
    // Types whose copy_fields we've already ensured this run (avoid re-querying
    // for every spool of the same type).
    const toppedUpTypes = new Set<string>();
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
          const trow = await db.selectFrom("inventory_parts").select("metadata").where("id", "=", typeId).executeTakeFirst();
          const existing = (trow?.metadata as Record<string, unknown> | null) ?? {};
          const merged = { ...existing };
          let changed = false;
          for (const [mk, mv] of Object.entries(add)) if (merged[mk] == null) { merged[mk] = mv; changed = true; }
          if (changed) {
            await db.updateTable("inventory_parts")
              .set({ metadata: sql`${JSON.stringify(merged)}::jsonb` as never })
              .where("id", "=", typeId)
              .execute();
            toppedUp++;
          }
        }
      }
    }
    return { ok: true, types_created: typesCreated, linked, converted, topped_up: toppedUp };
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
    await platform().events.emit("inventory.stock.changed", {
      orgId: ctx.orgId, partId, delta: -splitQty, newQty: srcQty - splitQty, reason: "split-lot",
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
}
