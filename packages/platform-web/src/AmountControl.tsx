// How much of something is left, and the one control that changes it, chosen
// by the unit it is kept in. A COUNTED unit (each, packs, rolls) steps by one
// with − and +. A MEASURED unit (kg, m, L) is never stepped: one tap of a
// fixed step empties a spool kept in kg, or moves a litre of paint by a
// thousandth, so the person types what they used ("Used 40 g"), in the small
// unit people think in, and it is converted to the record's own unit. Every
// surface that changes a count in hand renders this, so none can drift back
// into a fixed step (usedInUnit decides).

import { useEffect, useState, type FormEvent } from "react";
import { NumberStepper } from "./NumberStepper";
import { readTypedNumber } from "./TypeableNumber";
import { useUnits } from "./useUnits";
import { usedInUnit } from "./units";
import { countWordsFor, wordForCount, type CountWords } from "@cobblr/platform-contract/plural";

function fmt(n: number, fractionDigits: number): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(fractionDigits)));
}

export function AmountControl({
  qty,
  unit,
  countWords,
  onChange,
  label,
  size = "md",
  fractionDigits = 3,
}: {
  qty: number;
  fractionDigits?: number;
  /** The unit the record keeps its count in ("kg", "each", null). */
  unit: string | null;
  /** The table's own words for what it counts in ("ball"/"balls"), so a
   *  stored "skeins" still reads "1 skein". */
  countWords?: readonly CountWords[];
  /** Apply a change to the count in the record's own unit; resolves with the
   *  count the ledger now holds. */
  onChange: (delta: number) => Promise<number>;
  /** What is being counted, for the controls' names ("Galaxy Black PLA"). */
  label: string;
  size?: "md" | "sm";
}) {
  const units = useUnits();
  // Until the vocabulary is known (loading, or a host without it), a unit
  // other than "each" is never stepped by one: it is used by typing, in its
  // own unit. A wrong guess costs a typed number; the other wrong guess
  // costs a spool.
  const unknown = !units.all.length && !!unit && unit.trim().toLowerCase() !== "each";
  const used = unknown
    ? { code: unit!, symbol: unit!, name: unit!, plural: unit!, category: "unknown" }
    : usedInUnit(unit, units.all);
  const [shown, setShown] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [amount, setAmount] = useState("");
  useEffect(() => setShown(null), [qty]);
  const value = shown ?? qty;

  const apply = async (delta: number) => {
    if (busy || delta === 0) return;
    setBusy(true);
    setError(null);
    try {
      setShown(await onChange(delta));
      setTyping(false);
      setAmount("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // Sized in px, as its icons are: in rem the buttons doubled at 200% text and
  // a pantry or yarn row's stepper ran past the phone (#8432).
  const btn =
    (size === "sm" ? "w-[32px] h-[32px]" : "w-[44px] h-[44px]") +
    " grid place-items-center rounded-lg border border-line dark:border-slate-700 text-content dark:text-mortar-100 active:bg-subtle dark:active:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition";
  // A counted unit agrees with the number ("2 balls", "1 skein"); a measured
  // one reads as its symbol (#5079: the stepper said "2 ball").
  const shownUnit = !unit || unit === "each" ? "" : used ? ` ${units.suffix(unit) || unit}` : ` ${wordForCount(value, countWordsFor(unit, countWords))}`;
  const number = (
    <span
      className={(size === "sm" ? "min-w-[2rem] text-sm" : "min-w-[2.5rem] text-base") + " text-center font-mono tabular-nums text-content dark:text-mortar-100"}
      data-testid="amount-qty"
    >
      {fmt(value, fractionDigits)}
      {shownUnit}
    </span>
  );

  if (!used) {
    return (
      <span className="inline-flex max-w-full flex-col items-end" data-testid="amount-control" data-mode="count">
        <NumberStepper
          className={(size === "sm" ? "text-sm" : "text-base") + " inline-flex max-w-full items-center gap-1.5 text-content dark:text-mortar-100"}
          preserveConcurrentChanges
          value={value}
          suffix={shownUnit}
          min={0}
          busy={busy}
          label={label}
          icons
          iconSize={16}
          inputTestId="amount-qty"
          buttonClassName={btn}
          inputClassName={(size === "sm" ? "w-12 text-sm" : "w-14 text-base") + " bg-transparent text-center font-mono tabular-nums text-content dark:text-mortar-100"}
          onChange={(n) => void apply(n - value)}
        />
        {error && <span className="mt-1 max-w-[14rem] text-right text-[11px] text-ember-600 dark:text-ember-400">{error}</span>}
      </span>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = readTypedNumber(amount, { allowNegative: false, decimal: true });
    if (n === null || n <= 0) {
      setError(`Say how much, in ${used.symbol}.`);
      return;
    }
    const inOwn = units.convert(n, used.code, unit) ?? n;
    void apply(-Math.min(inOwn, value));
  };
  return (
    <span className="inline-flex max-w-full flex-col items-end" data-testid="amount-control" data-mode="measured">
      {/* The amount and Use some wrap, Use some under the amount, before they run past a phone at 200% text (#8613). */}
      <span className="inline-flex max-w-full flex-wrap items-center justify-end gap-2">
        {number}
        {!typing && (
          <button
            type="button"
            onClick={() => setTyping(true)}
            disabled={busy || value <= 0}
            className="h-11 px-3 rounded-lg border border-line dark:border-slate-700 text-sm text-content dark:text-mortar-100 disabled:opacity-30"
          >
            Use some
          </button>
        )}
      </span>
      {typing && (
        <form onSubmit={submit} className="mt-1.5 inline-flex max-w-full flex-wrap items-center justify-end gap-1.5">
          <label className="text-xs text-muted dark:text-slate-400" htmlFor={`used-${label}`}>
            Used
          </label>
          <input
            id={`used-${label}`}
            autoFocus
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-label={`How much ${label} was used, in ${used.plural}`}
            className="w-20 h-10 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 text-right font-mono tabular-nums"
          />
          <span className="text-xs text-muted dark:text-slate-400">{used.symbol}</span>
          <button type="submit" disabled={busy} className="h-10 px-3 rounded-lg bg-cobble-600 text-white text-sm disabled:opacity-50">
            Save
          </button>
          <button type="button" onClick={() => { setTyping(false); setAmount(""); setError(null); }} className="h-10 px-2 text-sm text-muted">
            Cancel
          </button>
        </form>
      )}
      {error && <span className="mt-1 max-w-[16rem] text-right text-[11px] text-ember-600 dark:text-ember-400">{error}</span>}
    </span>
  );
}
