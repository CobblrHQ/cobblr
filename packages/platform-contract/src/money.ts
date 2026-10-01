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

/** The workspace currency until a workspace can choose one. */
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

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(currency: string, locale: string | undefined, whole: boolean): Intl.NumberFormat {
  const key = `${currency}|${locale ?? ""}|${whole}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
    } catch {
      f = new Intl.NumberFormat(locale, { style: "currency", currency: DEFAULT_CURRENCY, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
    }
    formatters.set(key, f);
  }
  return f;
}

/** Money as a person reads it: "$4,300", "$12.50", "-$3". Grouped by the
 *  locale, two decimals only when there are cents. */
export function formatMoney(c: Cents, opts: { currency?: string | null; locale?: string } = {}): string {
  const currency = (opts.currency || DEFAULT_CURRENCY).toUpperCase();
  return formatter(currency, opts.locale, c % 100 === 0).format(c / 100);
}

/** Money as it is typed: "4300", "4,300", "$4,300.00", "12.5", "€ 12,50".
 *  Null for text that is not an amount. A comma followed by exactly three
 *  digits groups thousands; followed by one or two, it is the decimal point. */
export function parseMoney(input: unknown): Cents | null {
  if (typeof input === "number") return Number.isFinite(input) ? centsFromAmount(input) : null;
  if (typeof input !== "string") return null;
  let s = input.trim().replace(/^[A-Z]{3}\s*/i, "").replace(/\s*[A-Z]{3}$/i, "").replace(/[$€£¥\s]/g, "");
  if (!s) return null;
  const negative = /^-|^\(.*\)$/.test(s);
  s = s.replace(/^-|[()]/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const c = centsFromAmount(Number(s));
  return (negative ? -c : c) as Cents;
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
  return !!u && (CURRENCY_UNITS.has(u) || CURRENCY_UNITS.has(u.toUpperCase()));
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
export function moneyInputText(value: unknown, storage: MoneyStorage, locale?: string): string {
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
