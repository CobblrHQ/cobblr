// The one input for money. It shows the currency symbol, takes the amount the
// way people type it ("4300", "4,300", "$4,300.00"), shows it grouped once the
// field is left ("4,300"), and hands back the value in the shape its column
// stores: cents for a cents column, the amount for everything else. A form
// never shows 430000 for a $4,300 price, and never stores 4.3 for "4,300".

import { useEffect, useState } from "react";
import {
  currencySymbol,
  DEFAULT_CURRENCY,
  moneyForStorage,
  moneyInputText,
  type MoneyStorage,
} from "@cobblr/platform-contract/money";

export interface MoneyInputProps {
  /** The stored value (cents for a cents column, else the amount). */
  value: unknown;
  storage: MoneyStorage;
  /** Called with the value to store, or null when emptied. Text that is not
   *  an amount is not committed: the box says so and keeps what was typed. */
  onCommit: (stored: number | null) => void;
  currency?: string | null;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  /** Commit on every keystroke that reads as an amount, not only on blur
   *  (for a form that saves as a whole). */
  live?: boolean;
  onCancel?: () => void;
}

export function MoneyInput({
  value,
  storage,
  onCommit,
  currency,
  placeholder,
  className,
  autoFocus,
  ariaLabel,
  live,
  onCancel,
}: MoneyInputProps) {
  const shown = moneyInputText(value, storage);
  const [draft, setDraft] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => setDraft(shown), [shown]);

  const read = (text: string): { ok: true; stored: number | null } | { ok: false } => {
    if (!text.trim()) return { ok: true, stored: null };
    const stored = moneyForStorage(text, storage);
    return stored === null ? { ok: false } : { ok: true, stored };
  };
  const commit = () => {
    const r = read(draft);
    if (!r.ok) {
      setBad(true);
      return;
    }
    setBad(false);
    setDraft(moneyInputText(r.stored, storage));
    const before = shown.trim() ? moneyForStorage(shown, storage) : null;
    if (r.stored === before) return;
    onCommit(r.stored);
  };

  return (
    <div className={"flex items-center gap-1 " + (className ?? "")}>
      <span className="text-muted dark:text-slate-400 select-none" aria-hidden>
        {currencySymbol(currency || DEFAULT_CURRENCY)}
      </span>
      <input
        type="text"
        inputMode="decimal"
        autoFocus={autoFocus}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={bad || undefined}
        data-money-input=""
        onChange={(e) => {
          setDraft(e.target.value);
          setBad(false);
          if (live) {
            const r = read(e.target.value);
            if (r.ok) onCommit(r.stored);
          }
        }}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(shown);
            setBad(false);
            onCancel?.();
          }
        }}
        className={"input w-full tabular-nums " + (bad ? "border-ember-500 dark:border-ember-400" : "")}
      />
      {bad && <span className="shrink-0 text-xs text-ember-600 dark:text-ember-400">not an amount</span>}
    </div>
  );
}
