// The −/+ beside a count at a place, sized for one thumb at 390px. It only
// presents: the caller says what a step does (the ledgered stock adjust on the
// record at that place), so every surface that counts a place in hand (a
// location's Stock here, a scanned label's action) steps the same way and
// cannot drift into its own write path. A refused step says why under it.
// A thing kept in a MEASURED unit (kg, m, L) is never stepped by one: one tap
// of a kilogram empties a spool, so its line hands over to AmountControl,
// where the person types what they used.

import { useEffect, useState } from "react";
import { NumberStepper } from "./NumberStepper";
import { AmountControl } from "./AmountControl";

export function StockStepper({
  qty,
  unit = null,
  countWords,
  onStep,
  label,
  size = "md",
  fractionDigits = 3,
}: {
  qty: number;
  fractionDigits?: number;
  /** The unit the record is kept in. Anything but a plain count ("each",
   *  none) goes to AmountControl, which steps a counted unit by one and has a
   *  measured one typed. */
  unit?: string | null;
  /** The table's own words for what it counts in, so the word agrees. */
  countWords?: readonly import("@cobblr/platform-contract/plural").CountWords[];
  /** One change: resolves with the count the ledger now holds. */
  onStep: (delta: number) => Promise<number>;
  /** What is being counted, for the buttons' names ("Toilet paper"). */
  label: string;
  /** "md", a thumb's 44px, where the count is the point of the line; "sm" in
   *  a dense row or a tile, where the count sits beside everything else. */
  size?: "md" | "sm";
}) {
  if (unit && unit.trim() && unit.trim().toLowerCase() !== "each") {
    return <AmountControl fractionDigits={fractionDigits} qty={qty} unit={unit} {...(countWords ? { countWords } : {})} onChange={onStep} label={label} size={size} />;
  }
  return <CountStepper qty={qty} onStep={onStep} label={label} size={size} />;
}

function CountStepper({ qty, onStep, label, size }: { qty: number; onStep: (delta: number) => Promise<number>; label: string; size: "md" | "sm" }) {
  const [shown, setShown] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refetch brings the ledger's own number; it replaces the last tap's.
  useEffect(() => setShown(null), [qty]);
  const value = shown ?? qty;
  const step = async (delta: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setShown(await onStep(delta));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const sm = size === "sm";
  return (
    <span className="inline-flex flex-col items-end" data-testid="stock-stepper">
      <NumberStepper
        className="inline-flex items-center gap-1.5"
        preserveConcurrentChanges
        value={value}
        min={0}
        busy={busy}
        label={label}
        icons
        iconSize={16}
        testId="stock-stepper-control"
        inputTestId="stock-stepper-qty"
        buttonClassName={(sm ? "w-8 h-8" : "w-11 h-11") + " grid place-items-center rounded-lg border border-line dark:border-slate-700 text-content dark:text-mortar-100 active:bg-subtle dark:active:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition"}
        inputClassName={(sm ? "w-12 text-sm" : "w-14 text-base") + " bg-transparent text-center font-mono tabular-nums text-content dark:text-mortar-100"}
        // The ledger moves by a change: a typed count is the change that reaches it.
        onChange={(n) => void step(n - value)}
      />
      {error && <span className="mt-1 max-w-[14rem] text-right text-[11px] text-ember-600 dark:text-ember-400">{error}</span>}
    </span>
  );
}
