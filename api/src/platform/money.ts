import { sql } from "kysely";
import { platform, type DatedMoney, type PlatformMoney } from "@cobblr/platform-contract";
import { totalMoney, type ExchangeRates } from "@cobblr/platform-contract/money";

export function readEcbRates(xml: string): ExchangeRates {
  const out: ExchangeRates = {};
  for (const match of xml.matchAll(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]>([\s\S]*?)<\/Cube>/g)) {
    const rates: Record<string, number> = { EUR: 1 };
    for (const r of match[2]!.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]\s*\/>/g)) {
      const n = Number(r[2]);
      if (Number.isFinite(n) && n > 0) rates[r[1]!] = n;
    }
    if (Object.keys(rates).length > 1) out[match[1]!] = rates;
  }
  if (!Object.keys(out).length) throw new Error("The exchange-rate feed contained no rates");
  return out;
}

export async function refreshExchangeRates(): Promise<void> {
  const { meta } = await import("../db/meta.js");
  // Locked across processes even when called by an operator instead of a sweep.
  const result = await platform().exclusive.run("platform.ecb-fetch", async () => {
    const recent = await sql<{ fresh: boolean }>`select exists(select 1 from exchange_rate_fetches
      where id = 'ecb' and fetched_at > now() - interval '23 hours') as fresh`.execute(meta);
    if (recent.rows[0]?.fresh) return;
    const covered = await sql<{ recent: boolean }>`select exists(select 1 from exchange_rate_fetches where id = 'ecb' and fetched_at > now() - interval '80 days') as recent`.execute(meta);
    const url = covered.rows[0]?.recent ? "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml" : "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Exchange-rate feed refused (${response.status})`);
    const dates = Object.entries(readEcbRates(await response.text()));
    await meta.transaction().execute(async (db) => {
      for (let start = 0; start < dates.length; start += 250) {
        const batch = dates.slice(start, start + 250);
        await sql`insert into exchange_rates (rate_date, rates) values ${sql.join(batch.map(([day, rates]) => sql`(${day}::date, ${JSON.stringify(rates)}::jsonb)`))}
          on conflict (rate_date) do update set rates = excluded.rates, fetched_at = now()`.execute(db);
      }
      await sql`insert into exchange_rate_fetches (id, fetched_at) values ('ecb', now())
        on conflict (id) do update set fetched_at = excluded.fetched_at`.execute(db);
    });
    invalidateRateCache();
  });
  if (!result.ran) console.info("[exchange-rates] another process is fetching the shared feed");
}

export function registerExchangeRates(): void {
  platform().sweeps.register({
    name: "platform.exchange-rates", everyMs: 24 * 60 * 60 * 1000, firstAfterMs: 1000,
    // The shared feed needs no tenant pool. The gate does the work once.
    candidates: async () => { await refreshExchangeRates(); return []; },
    visit: async () => {},
  });
}

export async function currency(orgId: string): Promise<string> {
  const { meta } = await import("../db/meta.js");
  return (await meta.selectFrom("orgs").select("main_currency").where("id", "=", orgId).executeTakeFirstOrThrow()).main_currency;
}

export async function total(orgId: string, values: readonly DatedMoney[], target?: string) {
  const main = target || await currency(orgId);
  if (!values.some((v) => v.value.currency !== main)) return totalMoney(values, main, {});
  return totalMoney(values, main, await cachedRates());
}
let rateCache: { until: number; value: Promise<ExchangeRates> } | null = null;
export function invalidateRateCache(): void { rateCache = null; }
async function cachedRates(): Promise<ExchangeRates> {
  if (rateCache && rateCache.until > Date.now()) return rateCache.value;
  const value = (async () => {
    const { meta } = await import("../db/meta.js");
    const rows = await sql<{ day: string; rates: Record<string, number> }>`select to_char(rate_date, 'YYYY-MM-DD') as day, rates from exchange_rates`.execute(meta);
    return Object.fromEntries(rows.rows.map((r) => [r.day, r.rates]));
  })();
  rateCache = { until: Date.now() + 60_000, value };
  try { return await value; } catch (err) { invalidateRateCache(); throw err; }
}

export const money: PlatformMoney = { currency, total };
