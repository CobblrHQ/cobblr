// EGRESS-FILE: vendor-fixed - the European Central Bank's published rates, written in the code
import { readFile } from "node:fs/promises";
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

/** An ECB-format file the rates are read from instead of the ECB, for an
 *  install that cannot reach the internet, and for a test stack whose totals
 *  must not wait on a download or on a runner's way out (#7623). */
function ratesFile(): string {
  return process.env.COBBLR_EXCHANGE_RATES_FILE || "";
}

export async function feedXml(fullHistory: boolean): Promise<string> {
  const file = ratesFile();
  if (file) return readFile(file, "utf8");
  const url = fullHistory ? "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml" : "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Exchange-rate feed refused (${response.status})`);
  return response.text();
}

export async function refreshExchangeRates(): Promise<void> {
  const { meta } = await import("../db/meta.js");
  // Locked across processes even when called by an operator instead of a sweep.
  const result = await platform().exclusive.run("platform.ecb-fetch", async () => {
    // A local file is read every time: it costs nothing, and it is what the
    // operator says the rates are.
    if (!ratesFile()) {
      const recent = await sql<{ fresh: boolean }>`select exists(select 1 from exchange_rate_fetches
        where id = 'ecb' and fetched_at > now() - interval '23 hours') as fresh`.execute(meta);
      if (recent.rows[0]?.fresh) return;
    }
    const covered = await sql<{ recent: boolean }>`select exists(select 1 from exchange_rate_fetches where id = 'ecb' and fetched_at > now() - interval '80 days') as recent`.execute(meta);
    const dates = Object.entries(readEcbRates(await feedXml(!covered.rows[0]?.recent)));
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

export const EXCHANGE_RATES_EVERY_MS = 60 * 60 * 1000;
export const EXCHANGE_RATES_FIRST_MS = 1000;
let ratesTimer: ReturnType<typeof setInterval> | null = null;

/** The shared rates, refreshed a second after boot and then hourly, on their
 *  own timer. They were a workspace sweep whose visit did nothing: a sweep
 *  round with no workspace in it (a fresh install, a test stack before its
 *  first signup) never reached the refresh and set it an hour on, so every
 *  foreign price was left out of every total for that hour (#6881). Hourly,
 *  though the feed is read once a day: refreshExchangeRates asks the ECB only
 *  when its last fetch is 23 hours old, so a fetch that failed is tried again
 *  within the hour, not a day later (#7623). Two api processes each tick; the
 *  refresh's exclusive lock lets one of them fetch. */
export function startExchangeRates(refresh: () => Promise<void> = refreshExchangeRates): void {
  if (ratesTimer) clearInterval(ratesTimer);
  const tick = () => void refresh().catch((err) => console.warn("[exchange-rates] refresh failed, the last known rates stay:", (err as Error).message));
  ratesTimer = setInterval(tick, EXCHANGE_RATES_EVERY_MS);
  ratesTimer.unref?.();
  setTimeout(tick, EXCHANGE_RATES_FIRST_MS).unref?.();
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
