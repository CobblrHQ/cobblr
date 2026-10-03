// Money: ONE way from what is stored to what a person reads, and back.
//
// Amounts are stored two ways and always have been: most columns and every
// custom field hold the amount in the currency's main unit (a part's cost,
// 12.5), a few integer columns hold cents (an asset's purchase_price_cents,
// 430000). Each surface used to turn its own column into text, so a form showed
// a bare 4300 and History showed "purchase price cents → 430000". Now a value
// becomes `Cents` at the edge (toCents for a cents column, centsFromAmount for
// an amount) and the only way to show `Cents` is formatMoney. Nothing stored
// changes.

declare const centsBrand: unique symbol;

/** An amount of money in integer cents (minor units). Made only by `toCents`
 *  or `centsFromAmount`, shown only by `formatMoney`: a bare number cannot be
 *  passed where money is expected, and money cannot be rendered as a number. */
export type Cents = number & { readonly [centsBrand]: "Cents" };

/** The fallback when a client supplies no locale. */
export const DEFAULT_CURRENCY = "USD";

/** A value already in cents (a `*_cents` column), as `Cents`. */
export function toCents(n: number): Cents {
  return Math.round(n) as Cents;
}

/** An amount in the currency's main unit (12.5 dollars), as `Cents` (1250). */
export function centsFromAmount(amount: number): Cents {
  return Math.round(amount * 100) as Cents;
}

/** The amount in the currency's main unit, for a column that stores one. */
export function amountOf(c: Cents): number {
  return c / 100;
}

let displayCurrency = DEFAULT_CURRENCY;
/** Each browser tab has one active workspace. Explicit currencies always win. */
export function setDisplayCurrency(currency: string): void { displayCurrency = isCurrency(currency) ? currency : DEFAULT_CURRENCY; }

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(currency: string, locale: string | undefined, whole: boolean): Intl.NumberFormat {
  const key = `${currency}|${locale ?? ""}|${whole}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: whole ? 0 : undefined, maximumFractionDigits: whole ? 0 : undefined });
    } catch {
      f = new Intl.NumberFormat(locale, { style: "currency", currency: DEFAULT_CURRENCY, minimumFractionDigits: whole ? 0 : undefined, maximumFractionDigits: whole ? 0 : undefined });
    }
    formatters.set(key, f);
  }
  return f;
}

/** Money as a person reads it: "$4,300", "$12.50", "-$3". Grouped by the
 *  locale, two decimals only when there are cents. */
export function formatMoney(c: Cents, opts: { currency?: string | null; locale?: string } = {}): string {
  const currency = (opts.currency || displayCurrency).toUpperCase();
  return formatter(currency, opts.locale, c % 100 === 0).format(c / 100);
}

/** Money as it is typed: "4300", "4,300", "$4,300.00", "12.5", "€ 12,50".
 *  Null for text that is not an amount. A comma followed by exactly three
 *  digits groups thousands; followed by one or two, it is the decimal point. */
export function parseMoney(input: unknown): Cents | null {
  if (input && typeof input === "object") {
    const value = readMoney(input);
    return value ? centsFromAmount(value.amount) : null;
  }
  const amount = parseMoneyAmount(input);
  return amount === null ? null : centsFromAmount(amount);
}

export function parseMoneyAmount(input: unknown): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^[A-Z]{3}\s*/i, "").replace(/\s*[A-Z]{3}$/i, "").replace(/[$€£¥\s]/g, "");
  if (!s) return null;
  const negative = /^-|^\(.*\)$/.test(s);
  s = s.replace(/^-|[()]/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+,\d{1,3}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,3}$/.test(s)) s = s.replace(",", ".");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const amount = Number(s);
  return Number.isFinite(amount) ? (negative ? -amount : amount) : null;
}

/** How a money field holds its value: "cents" (an integer column such as an
 *  asset's purchase_price_cents) or "amount" (the main unit: a part's cost,
 *  every custom field). */
export type MoneyStorage = "cents" | "amount";

/** The record roles whose value is money. */
export const MONEY_ROLES: ReadonlySet<string> = new Set(["acquired-for"]);

const CURRENCY_UNITS = new Set(["$", "€", "£", "¥", "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "JPY", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "MXN", "BRL", "INR", "CNY", "HKD", "SGD", "ZAR"]);

/** Is this unit a currency ("USD", "$"). */
export function isCurrencyUnit(unit: string | null | undefined): boolean {
  const u = unit?.trim();
  return !!u && (CURRENCY_UNITS.has(u) || isCurrency(u.toUpperCase()));
}

/** What `moneyStorageOf` reads off a field: a field-def row, a native field
 *  from a manifest, or a kind summary's field all pass as they are. */
export interface MoneyFieldLike {
  type?: string | null;
  money?: MoneyStorage | null;
  unit?: string | null;
  field_role?: string | null;
  fieldRole?: string | null;
}

const SYMBOL_CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY" };

/** A number beside its unit as a person reads it: money when the unit is a
 *  currency ("$45.50" for 45.5 "$", "€12" for 12 "EUR"), else "12 kg". */
export function valueWithUnit(value: number, unit: string | null | undefined): string {
  const u = unit?.trim();
  if (!u) return String(value);
  if (isCurrencyUnit(u)) return formatMoney(centsFromAmount(value), { currency: SYMBOL_CURRENCY[u] ?? u.toUpperCase() });
  return `${value} ${u}`;
}

/** Is this field money, and how does it hold its value. THE rule every surface
 *  asks: a native field declares `money` in its manifest; a custom field is
 *  money when its type is `money`, when its role is a money role (what it
 *  cost), or when its unit is a currency. Null for anything else. */
export function moneyStorageOf(field: MoneyFieldLike): MoneyStorage | null {
  if (field.money) return field.money;
  if (field.type === "money") return "amount";
  if (field.type !== "number") return null;
  const role = field.field_role ?? field.fieldRole;
  if (role && MONEY_ROLES.has(role)) return "amount";
  if (isCurrencyUnit(field.unit)) return "amount";
  return null;
}

/** A stored value as `Cents`, by how its field holds it; null when it holds
 *  no number. Text that reads as money ("$4,300") counts. */
export function storedCents(value: unknown, storage: MoneyStorage): Cents | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") {
    const m = readMoney(value);
    return m ? centsFromAmount(m.amount) : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? (storage === "cents" ? toCents(value) : centsFromAmount(value)) : null;
  if (typeof value === "string" && storage === "cents" && /^-?\d+$/.test(value.trim())) return toCents(Number(value));
  return parseMoney(value);
}

/** A stored value as a person reads it ("$4,300"), or null when it holds no
 *  number. The one call for a surface that has the raw value and its field. */
export function formatStoredMoney(
  value: unknown,
  storage: MoneyStorage,
  opts: { currency?: string | null; locale?: string } = {},
): string | null {
  const own = value && typeof value === "object" ? readMoney(value) : null;
  if (own) return formatter(own.currency, opts.locale, Number.isInteger(own.amount)).format(own.amount);
  if (storage === "amount") {
    const amount = parseMoneyAmount(value);
    if (amount !== null) return formatter(opts.currency || displayCurrency, opts.locale, Number.isInteger(amount)).format(amount);
  }
  const c = storedCents(value, storage);
  return c === null ? null : formatMoney(c, opts);
}

/** A typed amount as the value its field stores: cents for a cents column,
 *  the amount for everything else. Null for text that is not an amount. */
export function moneyForStorage(input: unknown, storage: MoneyStorage): number | null {
  const c = parseMoney(input);
  if (c === null) return null;
  return storage === "cents" ? c : amountOf(c);
}

/** The text a money input shows for a stored value: "4,300" or "12.50", no
 *  symbol (the input carries its own). Empty for no value. */
export function moneyInputText(value: unknown, storage: MoneyStorage, locale?: string, currency?: string): string {
  const own = value && typeof value === "object" ? readMoney(value) : currency && storage === "amount" && parseMoneyAmount(value) !== null ? { amount: parseMoneyAmount(value)!, currency } : null;
  if (own) {
    const digits = formatter(own.currency, locale, false).resolvedOptions().maximumFractionDigits;
    return new Intl.NumberFormat(locale, { minimumFractionDigits: Number.isInteger(own.amount) ? 0 : digits, maximumFractionDigits: digits }).format(own.amount);
  }
  const c = storedCents(value, storage);
  if (c === null) return typeof value === "string" ? value : "";
  const whole = c % 100 === 0;
  return new Intl.NumberFormat(locale, { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(c / 100);
}

/** Money as a spreadsheet keeps it: a plain decimal in the currency's main
 *  unit ("4300.00"), never cents, no symbol or grouping, so an export reads
 *  back in through any import (and through ours as the same amount). */
export function formatMoneyPlain(c: Cents): string {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** The currency's symbol as an input prefix shows it ("$", "€"). */
export function currencySymbol(currency: string = DEFAULT_CURRENCY, locale?: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0).find((p) => p.type === "currency");
    return part?.value ?? currency;
  } catch {
    return currency;
  }
}


export interface Money { amount: number; currency: string }
export type ExchangeRates = Record<string, Record<string, number>>;
export interface MoneyConversion extends Money { original: Money; rateDate: string | null }
export interface MoneyTotal extends Money {
  excluded: Record<string, number>;
  conversions: MoneyConversion[];
}
// Current legal tender by territory: Unicode CLDR currencyData (2026-10).
// https://github.com/unicode-org/cldr-json/blob/main/cldr-json/cldr-core/supplemental/currencyData.json
const REGION_CURRENCIES: Record<string, string> = {
  AC: "SHP", AD: "EUR", AE: "AED", AF: "AFN", AG: "XCD", AI: "XCD", AL: "ALL", AM: "AMD",
  AO: "AOA", AR: "ARS", AS: "USD", AT: "EUR", AU: "AUD", AW: "AWG", AX: "EUR", AZ: "AZN",
  BA: "BAM", BB: "BBD", BD: "BDT", BE: "EUR", BF: "XOF", BG: "EUR", BH: "BHD", BI: "BIF",
  BJ: "XOF", BL: "EUR", BM: "BMD", BN: "BND", BO: "BOB", BQ: "USD", BR: "BRL", BS: "BSD",
  BT: "BTN", BV: "NOK", BW: "BWP", BY: "BYN", BZ: "BZD", CA: "CAD", CC: "AUD", CD: "CDF",
  CF: "XAF", CG: "XAF", CH: "CHF", CI: "XOF", CK: "NZD", CL: "CLP", CM: "XAF", CN: "CNY",
  CO: "COP", CR: "CRC", CU: "CUP", CV: "CVE", CW: "XCG", CX: "AUD", CY: "EUR", CZ: "CZK",
  DE: "EUR", DG: "USD", DJ: "DJF", DK: "DKK", DM: "XCD", DO: "DOP", DZ: "DZD", EA: "EUR",
  EC: "USD", EE: "EUR", EG: "EGP", EH: "MAD", ER: "ERN", ES: "EUR", ET: "ETB", EU: "EUR",
  FI: "EUR", FJ: "FJD", FK: "FKP", FM: "USD", FO: "DKK", FR: "EUR", GA: "XAF", GB: "GBP",
  GD: "XCD", GE: "GEL", GF: "EUR", GG: "GBP", GH: "GHS", GI: "GIP", GL: "DKK", GM: "GMD",
  GN: "GNF", GP: "EUR", GQ: "XAF", GR: "EUR", GS: "GBP", GT: "GTQ", GU: "USD", GW: "XOF",
  GY: "GYD", HK: "HKD", HM: "AUD", HN: "HNL", HR: "EUR", HT: "USD", HU: "HUF", IC: "EUR",
  ID: "IDR", IE: "EUR", IL: "ILS", IM: "GBP", IN: "INR", IO: "USD", IQ: "IQD", IR: "IRR",
  IS: "ISK", IT: "EUR", JE: "GBP", JM: "JMD", JO: "JOD", JP: "JPY", KE: "KES", KG: "KGS",
  KH: "KHR", KI: "AUD", KM: "KMF", KN: "XCD", KP: "KPW", KR: "KRW", KW: "KWD", KY: "KYD",
  KZ: "KZT", LA: "LAK", LB: "LBP", LC: "XCD", LI: "CHF", LK: "LKR", LR: "LRD", LS: "LSL",
  LT: "EUR", LU: "EUR", LV: "EUR", LY: "LYD", MA: "MAD", MC: "EUR", MD: "MDL", ME: "EUR",
  MF: "EUR", MG: "MGA", MH: "USD", MK: "MKD", ML: "XOF", MM: "MMK", MN: "MNT", MO: "MOP",
  MP: "USD", MQ: "EUR", MR: "MRU", MS: "XCD", MT: "EUR", MU: "MUR", MV: "MVR", MW: "MWK",
  MX: "MXN", MY: "MYR", MZ: "MZN", NA: "NAD", NC: "XPF", NE: "XOF", NF: "AUD", NG: "NGN",
  NI: "NIO", NL: "EUR", NO: "NOK", NP: "NPR", NR: "AUD", NU: "NZD", NZ: "NZD", OM: "OMR",
  PA: "USD", PE: "PEN", PF: "XPF", PG: "PGK", PH: "PHP", PK: "PKR", PL: "PLN", PM: "EUR",
  PN: "NZD", PR: "USD", PS: "JOD", PT: "EUR", PW: "USD", PY: "PYG", QA: "QAR", RE: "EUR",
  RO: "RON", RS: "RSD", RU: "RUB", RW: "RWF", SA: "SAR", SB: "SBD", SC: "SCR", SD: "SDG",
  SE: "SEK", SG: "SGD", SH: "SHP", SI: "EUR", SJ: "NOK", SK: "EUR", SL: "SLE", SM: "EUR",
  SN: "XOF", SO: "SOS", SR: "SRD", SS: "SSP", ST: "STN", SV: "USD", SX: "XCG", SY: "SYP",
  SZ: "SZL", TA: "GBP", TC: "USD", TD: "XAF", TF: "EUR", TG: "XOF", TH: "THB", TJ: "TJS",
  TK: "NZD", TL: "USD", TM: "TMT", TN: "TND", TO: "TOP", TR: "TRY", TT: "TTD", TV: "AUD",
  TW: "TWD", TZ: "TZS", UA: "UAH", UG: "UGX", UM: "USD", US: "USD", UY: "UYU", UZ: "UZS",
  VA: "EUR", VC: "XCD", VE: "VES", VG: "USD", VI: "USD", VN: "VND", VU: "VUV", WF: "XPF",
  WS: "WST", XK: "EUR", YE: "YER", YT: "EUR", ZA: "ZAR", ZM: "ZMW", ZW: "ZWG",
};
export const CURRENCIES: readonly string[] = [...new Set([...Intl.supportedValuesOf("currency"), ...Object.values(REGION_CURRENCIES)])].sort();
export function isCurrency(value: unknown): value is string {
  return typeof value === "string" && CURRENCIES.includes(value);
}

/** Legacy numbers acquire the workspace currency on read, never on disk. */
export function readMoney(value: unknown, storage: MoneyStorage = "amount", currency = DEFAULT_CURRENCY): Money | null {
  if (value && typeof value === "object") {
    const m = value as Partial<Money>;
    return typeof m.amount === "number" && Number.isFinite(m.amount) && isCurrency(m.currency)
      ? { amount: m.amount, currency: m.currency } : null;
  }
  if (storage === "amount") {
    const amount = parseMoneyAmount(value);
    return amount === null ? null : { amount, currency };
  }
  const cents = storedCents(value, storage);
  return cents === null ? null : { amount: amountOf(cents), currency };
}

export function currencyFromLocale(locale: string | undefined): string {
  let region: string | undefined;
  try { region = new Intl.Locale(locale || "en-US").maximize().region; } catch { return DEFAULT_CURRENCY; }

  return REGION_CURRENCIES[region || ""] || DEFAULT_CURRENCY;
}

/** ECB quotes units per euro. Only a preceding published day within a week
 *  may stand in for a holiday; a retired currency's years-old rate may not. */
export function convertMoney(value: Money, currency: string, day: string, rates: ExchangeRates): MoneyConversion | null {
  if (!Number.isFinite(value.amount)) return null;
  if (value.currency === currency) return { ...value, original: value, rateDate: null };
  const date = Object.keys(rates).filter((d) => d <= day).sort().at(-1);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Date.parse(day) - Date.parse(date) > 7 * 86400000) return null;
  const from = rates[date]?.[value.currency];
  const to = rates[date]?.[currency];
  if (!from || !to || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const scale = 10 ** digits;
  const amount = Math.round(value.amount / from * to * scale) / scale;
  return { amount, currency, original: value, rateDate: date };
}

export function roundMoneyAmount(amount: number, currency: string): number {
  const scale = 10 ** (formatter(currency, undefined, false).resolvedOptions().maximumFractionDigits ?? 2);
  return Math.round(amount * scale) / scale;
}

export function totalMoney(values: readonly { value: Money; day: string }[], currency: string, rates: ExchangeRates): MoneyTotal {
  const excluded: Record<string, number> = {};
  const conversions: MoneyConversion[] = [];
  for (const { value, day } of values) {
    const converted = convertMoney(value, currency, day, rates);
    if (converted) conversions.push(converted);
    else excluded[value.currency] = (excluded[value.currency] || 0) + 1;
  }
  return { amount: roundMoneyAmount(conversions.reduce((sum, v) => sum + v.amount, 0), currency), currency, excluded, conversions };
}

export function moneyTotalNote(total: Pick<MoneyTotal, "excluded" | "conversions">): string {
  return [
    ...Object.entries(total.excluded).map(([currency, count]) => `excludes ${count} ${count === 1 ? "item" : "items"} in ${currency}`),
    ...total.conversions.filter((v) => v.rateDate).map((v) => `${formatStoredMoney(v.original, "amount")} ≈ ${formatStoredMoney(v, "amount")} at the ${v.rateDate} rate`),
  ].join("; ");
}

/** Currency on native numeric columns lives beside them in metadata. */
export function fieldCurrency(metadata: unknown, field: string, fallback = DEFAULT_CURRENCY): string {
  const m = metadata as { [key: string]: unknown; money_currencies?: Record<string, string>; receipt?: { currency?: string }; receipt_currency?: string; currency?: string } | null;
  const currency = m?.[`money_currency_${field}`] || m?.money_currencies?.[field] || m?.currency || m?.receipt?.currency || m?.receipt_currency;
  return typeof currency === "string" && /^[A-Z]{3}$/.test(currency.toUpperCase()) ? currency.toUpperCase() : fallback;
}
