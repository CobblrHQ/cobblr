// Record a parcel (sales:add-parcel): the handler its manifest entry names. Wired in ./index.ts.
import type { Kysely } from "kysely";
import { platform, readJsonArg, requireActionEntity } from "@cobblr/platform-contract";
import type { SalesDB } from "../db.js";
import { recordParcel, setParcelTracking } from "../parcels.js";

type Args = { order_id?: string; tracking_number?: string; carrier?: string; parcel_id?: string };

export function registerAddParcelAction(): void {
  platform().actions.registerHandler("sales.add-parcel", async (ctx) => {
    const record = requireActionEntity(ctx);
    const args = (ctx.args as Args | null) ?? {};
    const orderId = args.order_id?.trim() || record.id;
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const tracking = args.tracking_number?.trim() || null;
    if (args.parcel_id?.trim()) {
      if (!tracking) return { ok: false, error: "Give the tracking number this parcel went with." };
      const r = await setParcelTracking(db, ctx.orgId, orderId, args.parcel_id.trim(), { trackingNumber: tracking, carrier: args.carrier ?? null, userId: ctx.userId ?? null });
      return r.ok ? { ok: true, orderId, tracking_number: r.tracking_number, carrier: r.carrier, summary: `Put tracking number ${r.tracking_number} on that parcel.` } : { ok: false, error: r.message, code: r.code };
    }
    const named = readJsonArg<Array<{ line_id?: string; item_id?: string; qty?: number }>>(ctx.args as Record<string, unknown>, "lines");
    const lines = named?.length ? named.map((l) => ({ item_id: String(l.line_id ?? l.item_id ?? ""), qty: Number(l.qty) })) : null;
    const r = await recordParcel(db, ctx.orgId, orderId, { lines, trackingNumber: tracking, carrier: args.carrier ?? null, userId: ctx.userId ?? null });
    if (!r.ok) return { ok: false, error: r.message, code: r.code };
    const what = r.lines.map((l) => `${l.qty} ${l.description ?? "item"}`).join(", ");
    return { ok: true, orderId, parcel_id: r.parcel_id, shipped: r.shipped, status: r.status, tracking_number: r.tracking_number, summary: `Recorded a parcel of ${what}${r.shipped ? "; the order is shipped." : "; the order is still open."}` };
  });
}
