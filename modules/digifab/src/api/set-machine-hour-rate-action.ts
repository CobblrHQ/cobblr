// Set a machine-hour rate (digifab:set-machine-hour-rate): the handler its manifest entry names. Wired in ./index.ts.
// A printer's rate lives in its device settings, a pool's in the pool's config;
// a print is priced with its printer's own rate, else its pool's (print-cost.ts).
import { platform } from "@cobblr/platform-contract";
import { isCurrency } from "@cobblr/platform-contract/money";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";

type Args = { printer?: unknown; pool?: unknown; rate?: unknown; currency?: unknown };
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** A printer by what the fleet calls it: `connection/device`, its machine's name, its manager's name for it, or its device id. */
async function findPrinter(db: Kysely<DigifabDB>, orgId: string, said: string): Promise<{ connection_id: string; remote_device_id: string; name: string } | { error: string }> {
  const slash = said.indexOf("/");
  const links = await db.selectFrom("digifab_device_links").select(["connection_id", "remote_device_id", "machine_label", "remote_device_name"]).execute();
  if (slash > 0) {
    const [connection_id, remote_device_id] = [said.slice(0, slash), said.slice(slash + 1)];
    const link = links.find((l) => l.connection_id === connection_id && l.remote_device_id === remote_device_id);
    const known = link ?? (await db.selectFrom("digifab_device_settings").select("connection_id").where("connection_id", "=", connection_id).where("remote_device_id", "=", remote_device_id).executeTakeFirst());
    const conn = known ? null : await platform().devices.connections().getInternal(orgId, connection_id).catch(() => null);
    if (known || conn) return { connection_id, remote_device_id, name: link?.machine_label || link?.remote_device_name || remote_device_id };
  }
  const key = said.toLowerCase();
  const hits = links.filter((l) => [l.machine_label, l.remote_device_name, l.remote_device_id].some((n) => n?.toLowerCase() === key));
  if (hits.length === 1) return { connection_id: hits[0]!.connection_id, remote_device_id: hits[0]!.remote_device_id, name: hits[0]!.machine_label || hits[0]!.remote_device_name || hits[0]!.remote_device_id };
  if (hits.length > 1) return { error: `More than one printer is called ${said}. Name it by its machine instead.` };
  const names = links.map((l) => l.machine_label || l.remote_device_name).filter(Boolean).slice(0, 8);
  return { error: names.length ? `No printer is called ${said}. The printers are: ${names.join(", ")}.` : `No printer is called ${said}. Link a printer to a machine first.` };
}

export async function setMachineHourRate(db: Kysely<DigifabDB>, orgId: string, args: Args): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const raw = text(args.rate);
  const rate = raw === "" ? null : Number(raw.replace(/^[^\d.-]+/, ""));
  if (rate != null && !(Number.isFinite(rate) && rate >= 0)) return { ok: false, error: "Give the cost of an hour as a number, or leave it empty to remove it." };
  const currency = (text(args.currency) || (await platform().money.currency(orgId))).toUpperCase();
  if (!isCurrency(currency)) return { ok: false, error: `${currency} is not a currency code. Use one like USD or EUR.` };
  const hour = rate == null || rate === 0 ? null : rate;
  const said = (v: number) => `${v} ${currency} an hour`;

  const poolName = text(args.pool);
  if (poolName) {
    const pools = await db.selectFrom("digifab_pools").select(["id", "name", "config"]).execute();
    const pool = pools.find((p) => p.id === poolName || p.name.toLowerCase() === poolName.toLowerCase());
    if (!pool) return { ok: false, error: pools.length ? `No pool is called ${poolName}. The pools are: ${pools.map((p) => p.name).join(", ")}.` : `No pool is called ${poolName}.` };
    const { hour_rate: _r, hour_rate_currency: _c, ...rest } = (pool.config ?? {}) as Record<string, unknown>;
    const config = hour == null ? rest : { ...rest, hour_rate: hour, hour_rate_currency: currency };
    await db.updateTable("digifab_pools").set({ config: JSON.stringify(config) as never, updated_at: new Date() }).where("id", "=", pool.id).execute();
    return { ok: true, summary: hour == null ? `${pool.name} no longer has an hour rate.` : `An hour on a printer in ${pool.name} now costs ${said(hour)}.` };
  }

  const printerName = text(args.printer);
  if (!printerName) return { ok: false, error: "Name the printer or the pool whose hour rate to set." };
  const printer = await findPrinter(db, orgId, printerName);
  if ("error" in printer) return { ok: false, error: printer.error };
  await db.insertInto("digifab_device_settings")
    .values({ connection_id: printer.connection_id, remote_device_id: printer.remote_device_id, hour_rate: hour == null ? null : String(hour), hour_rate_currency: hour == null ? null : currency })
    .onConflict((oc) => oc.columns(["connection_id", "remote_device_id"]).doUpdateSet({ hour_rate: hour == null ? null : String(hour), hour_rate_currency: hour == null ? null : currency, updated_at: new Date() }))
    .execute();
  return { ok: true, summary: hour == null ? `${printer.name} no longer has an hour rate.` : `An hour on ${printer.name} now costs ${said(hour)}.` };
}

export function registerSetMachineHourRateAction(): void {
  platform().actions.registerHandler("digifab.set-machine-hour-rate", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    return setMachineHourRate(db, ctx.orgId, (ctx.args ?? {}) as Args);
  });
}
