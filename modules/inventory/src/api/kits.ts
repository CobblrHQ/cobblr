import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { ActionRefusal, KindRefRegex, platform, readJsonArg, type ActionInvokeContext } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";
import { checkKitOutput, checkKitReservation, groupKitLines, kitFingerprint } from "../kit-reservation.js";
import { storageView } from "./storage.js";
import { recordConsumption } from "./stock-ledger.js";
import { stockMoved } from "./stock-moved.js";
const Request = z.object({
  target_kind: z.string().regex(KindRefRegex), target_id: z.string().uuid(), operation: z.enum(["reserve", "check", "release", "consume"]),
  lines: z.array(z.object({ part_id: z.string().uuid(), kind: z.string().min(3), qty: z.number().int().positive().max(1_000_000_000), role: z.enum(["component", "blank"]).optional() })).max(5000).optional(),
  output: z.object({ part_id: z.string().uuid(), kind: z.string().min(3), qty: z.number().int().positive().max(1_000_000) }).optional(),
  confirmed_placed: z.boolean().default(false),
  require_ready: z.boolean().default(false),
});
export function registerKitActions() {
  platform().actions.registerHandler("inventory.assembly-kit", async (ctx: ActionInvokeContext) => {
    const args = ctx.args ?? {};
    const p = Request.parse({ ...args, lines: args.lines === undefined ? undefined : readJsonArg(args, "lines"), output: args.output === undefined ? undefined : readJsonArg(args, "output") });
    const [targetModule, targetType] = p.target_kind.split(":") as [string, string];
    if (p.operation === "consume") {
      if (!p.output) throw new ActionRefusal("Choose the placed-board output before consuming the kit.");
      const output = await platform().entities.lookup(ctx.orgId, p.output.kind, p.output.part_id, { userId: ctx.userId ?? undefined });
      if (!output || output.retired) throw new ActionRefusal("Choose an available placed-board stock record.");
    }
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    if (p.operation === "reserve") {
      if (!p.lines?.length) throw new ActionRefusal("Choose the whole kit before reserving it.");
      for (const line of p.lines) {
        const record = await platform().entities.lookup(ctx.orgId, line.kind, line.part_id, { userId: ctx.userId ?? undefined });
        if (!record || record.retired) throw new ActionRefusal("A kit item is missing or unavailable.");
      }
    }
    const result = await db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`assembly-kit:${p.target_kind}:${p.target_id}`}, 0))`.execute(trx);
      const old = await trx.selectFrom("inventory_allocations").selectAll().where("target_module", "=", targetModule).where("target_entity_type", "=", targetType).where("target_entity_id", "=", p.target_id).where("target_line", "=", "assembly-kit").orderBy("part_id").execute();
      const wanted = p.operation === "reserve" ? groupKitLines(p.lines!) : old.map(r => ({ part_id: r.part_id, qty: Number(r.qty) }));
      if (!wanted.length) {
        if (p.operation === "check") return { changed: false, ready: false, reason: "This order has no reserved kit.", lines: [], stock: [] };
        throw new ActionRefusal("This order has no reserved kit.");
      }
      if (p.operation === "reserve" && old.length && kitFingerprint(wanted) !== kitFingerprint(old.map(r => ({ part_id: r.part_id, qty: Number(r.qty) })))) throw new ActionRefusal("This kit already reserves different stock. Cancel it and make a new work order.");
      const parts = await trx.selectFrom("inventory_parts").selectAll().where("id", "in", [...new Set([...wanted.map(l => l.part_id), ...(p.output ? [p.output.part_id] : [])])]).orderBy("id").forUpdate().execute();
      const totals = await trx.selectFrom("inventory_allocations").select(["part_id", sql<string>`sum(qty)`.as("reserved")]).where("part_id", "in", wanted.map(l => l.part_id)).where("status", "=", "reserved").groupBy("part_id").execute();
      const stock = await Promise.all(parts.filter(part => wanted.some(l => l.part_id === part.id)).map(async part => {
        const storage = await storageView(trx, ctx.orgId, part.id);
        const ours = old.filter(r => r.part_id === part.id && r.status === "reserved").reduce((n, r) => n + Number(r.qty), 0);
        return { id: part.id, name: part.name, qty: Number(part.qty), reserved: Number(totals.find(t => t.part_id === part.id)?.reserved ?? 0) - ours,
          usable: !part.archived && part.state === "active" && part.unit === "each" && (p.operation === "consume" && p.confirmed_placed || (storage?.usable ?? true)), moisture_problem: storage?.usable === false ? storage.reason : null, reason: part.unit !== "each" ? "Assembly kits need count stock measured in each." : storage?.reason, location_id: part.location_id, lot_code: typeof part.metadata.lot_code === "string" ? part.metadata.lot_code : null };
      }));
      const outputSource = `${p.target_kind}:${p.target_id}`;
      if (p.operation === "consume") {
        const output = parts.find(part => part.id === p.output!.part_id);
        const blanks = old.filter(row => row.context.role === "blank" || parts.find(part => part.id === row.part_id)?.metadata.stage === "blank").reduce((qty, row) => qty + Number(row.qty), 0);
        try { checkKitOutput(blanks, { qty: p.output!.qty, unit: output?.unit ?? "", available: !!output && !output.archived && output.state === "active" }); } catch (e) { throw new ActionRefusal((e as Error).message); }
        if (wanted.some(line => line.part_id === output!.id)) throw new ActionRefusal("Placed boards need a separate output record from kit inputs.");
        const recorded = await trx.selectFrom("inventory_consumption").select(["part_id", "delta"]).where("source_kind", "=", "assembly-output").where("source_id", "=", outputSource).executeTakeFirst();
        if (recorded && (recorded.part_id !== p.output!.part_id || Number(recorded.delta) !== p.output!.qty)) throw new ActionRefusal("This kit already produced different placed-board stock.");
        if (old.every(row => row.status === "consumed") && !recorded) throw new ActionRefusal("This kit was consumed without a recorded output. Check its history before continuing.");
      }
      let problem: string | null = null;
      try { checkKitReservation(wanted, stock); } catch (e) { problem = e instanceof Error ? e.message : "Check the kit stock."; }
      const statuses = new Set(old.map(r => r.status));
      if (old.length && (statuses.size !== 1 || !statuses.has("reserved"))) {
        if (p.operation === "check") return { changed: false, ready: false, reason: "This kit has already been consumed or released.", lines: old, stock };
        const done = p.operation === "release" ? "released" : p.operation === "consume" ? "consumed" : null;
        if (done && statuses.size === 1 && statuses.has(done)) return { changed: false, ready: false, reason: `This kit is ${done}.`, lines: old, stock };
        throw new ActionRefusal("This kit has already been consumed or released.");
      }
      if (problem && (p.operation === "reserve" || p.operation === "consume" || p.require_ready)) throw new ActionRefusal(problem);
      if (p.operation === "check") return { changed: false, ready: !problem, reason: problem, lines: old, stock };
      if (p.operation === "reserve") {
        const lines = old.length ? old : await trx.insertInto("inventory_allocations").values(wanted.map(l => ({ part_id: l.part_id, qty: String(l.qty), target_module: targetModule, target_entity_type: targetType, target_entity_id: p.target_id, target_line: "assembly-kit", reason: "Assembly kit", context: { lot_code: stock.find(p => p.id === l.part_id)?.lot_code ?? null, role: p.lines?.find(line => line.part_id === l.part_id)?.role ?? "component" } }))).returningAll().execute();
        return { changed: !old.length, ready: true, reason: null, lines, stock };
      }
      for (const row of old) {
        if (p.operation === "consume") {
          await trx.updateTable("inventory_parts").set({ qty: sql<string>`qty - ${row.qty}::numeric`, updated_at: new Date() }).where("id", "=", row.part_id).execute();
          await recordConsumption(trx, { partId: row.part_id, delta: -Number(row.qty), reason: stock.find(s => s.id === row.part_id)?.moisture_problem ? "Assembly placement, moisture warning after Start" : "Assembly placement", sourceKind: "allocation", sourceId: row.id });
        }
      }
      if (p.operation === "consume") {
        await trx.updateTable("inventory_parts").set({ qty: sql<string>`qty + ${p.output!.qty}::numeric`, updated_at: new Date() }).where("id", "=", p.output!.part_id).execute();
        await recordConsumption(trx, { partId: p.output!.part_id, delta: p.output!.qty, reason: "Placed boards", sourceKind: "assembly-output", sourceId: outputSource });
      }
      const status = p.operation === "consume" ? "consumed" : "released";
      for (const row of old) if (p.operation === "consume" && stock.find(s => s.id === row.part_id)?.moisture_problem) await trx.updateTable("inventory_allocations").set({ context: { ...row.context, moisture_problem: stock.find(s => s.id === row.part_id)!.moisture_problem } }).where("id", "=", row.id).execute();
      const lines = await trx.updateTable("inventory_allocations").set({ status, ...(status === "consumed" ? { consumed_at: new Date() } : { released_at: new Date() }) }).where("id", "in", old.map(r => r.id)).returningAll().execute();
      return { changed: true, ready: false, reason: null, lines, stock };
    });
    if (result.changed) for (const row of result.lines) {
      const verb = p.operation === "reserve" ? "reserved" : p.operation === "consume" ? "consumed" : "released";
      const action = p.operation === "reserve" ? "allocation_reserved" : p.operation === "consume" ? "allocation_consumed" : "allocation_released";
      await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action, ref: { module: "inventory", entityType: "allocation", entityId: row.id }, diff: { part_id: row.part_id, qty: Number(row.qty) } });
      await platform().events.emit(`inventory.allocation.${verb}`, { orgId: ctx.orgId, allocationId: row.id, partId: row.part_id, qty: Number(row.qty) });
      if (p.operation === "consume") {
        const part = await db.selectFrom("inventory_parts").select(["qty", "min_qty"]).where("id", "=", row.part_id).executeTakeFirstOrThrow();
        await stockMoved(db, ctx.orgId, { partId: row.part_id, delta: -Number(row.qty), newQty: Number(part.qty), minQty: part.min_qty == null ? null : Number(part.min_qty), reason: "allocation_consumed", ledger: false });
      }
    }
    if (result.changed && p.operation === "consume" && p.output) {
      const part = await db.selectFrom("inventory_parts").select(["qty", "min_qty"]).where("id", "=", p.output.part_id).executeTakeFirstOrThrow();
      await stockMoved(db, ctx.orgId, { partId: p.output.part_id, delta: p.output.qty, newQty: Number(part.qty), minQty: part.min_qty == null ? null : Number(part.min_qty), reason: "assembly_placed", ledger: false });
    }
    return { ok: true, changed: result.changed, data: result };
  });
}
