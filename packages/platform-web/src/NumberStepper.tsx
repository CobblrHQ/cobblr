// ONE stepper for every count you can nudge with − and + (#4875): the number in
// the middle is a real, typeable field, so a person with 40 of something types
// 40 on the numeric keypad instead of tapping + forty times.
//
// The number is an <input inputmode="numeric" pattern="[0-9]*" enterkeyhint=
// "done">: the phone opens its digit keypad; the whole value is selected on
// focus; it commits on blur or Enter and Escape puts the old value back. The −
// and + are never disabled while a write is in flight (that flashed them on
// every tap): a tap during a write is simply ignored.
//
// `signed` is for a change-by count ("+3", "−2"): the field holds the size of
// the change, its sign follows the value, and − / + cross zero past it.
// Every stepper in the app is this component (a-stepper-is-always-the-numeric-
// stepper.test.ts discovers any that is not).

import { Minus, Plus } from "lucide-react";
import { TypeableNumber } from "./TypeableNumber";

export interface NumberStepperProps {
  value: number;
  /** A new value, from a tap or a typed commit. Never called with the value it already has. */
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** A write is in flight: taps are ignored, the buttons stay as they are. */
  busy?: boolean;
  /** What is counted, for the field's and buttons' names ("Toilet paper"). */
  label: string;
  /** Shown before the number, outside the field ("×" for a count). */
  prefix?: string;
  suffix?: string;
  /** A change to stock you have, not a count: it may be negative, ± hop over
   *  zero (+1 → −1), and a typed zero is refused. */
  signed?: boolean;
  /** Stop clicks reaching a card that opens on tap. */
  stopClicks?: boolean;
  decreaseLabel?: string;
  increaseLabel?: string;
  testId?: string;
  /** A test id on the typeable number itself. */
  inputTestId?: string;
  className?: string;
  buttonClassName?: string;
  inputClassName?: string;
  /** Icons instead of the − and + glyphs. */
  icons?: boolean;
  iconSize?: number;
}

export function NumberStepper({
  value,
  onChange,
  min: minProp,
  max,
  busy = false,
  label,
  prefix = "",
  suffix = "",
  signed = false,
  stopClicks = false,
  decreaseLabel,
  increaseLabel,
  testId,
  inputTestId,
  className = "inline-flex items-center",
  buttonClassName = "min-h-9 w-8 text-muted disabled:opacity-40",
  inputClassName = "w-10 bg-transparent text-center font-semibold tabular-nums text-content dark:text-mortar-100",
  icons = false,
  iconSize = 14,
}: NumberStepperProps) {
  const min = minProp ?? (signed ? -9999 : 0);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min, n));
  const apply = (n: number) => {
    if (busy) return;
    const next = clamp(n);
    if (next !== value) onChange(next);
  };
  const step = (delta: 1 | -1) => {
    // A change of zero is no change: hop over it (+1 → −1).
    let next = value + delta;
    if (signed && next === 0) next = delta;
    apply(next);
  };
  const stop = stopClicks ? (e: { stopPropagation(): void }) => e.stopPropagation() : undefined;
  const glyph = (g: string, I: typeof Minus) => (icons ? <I size={iconSize} /> : g);

  return (
    <span className={className} data-testid={testId} onClick={stop}>
      <button
        type="button"
        aria-label={decreaseLabel ?? `One fewer ${label}`}
        disabled={value <= min}
        onClick={() => step(-1)}
        className={buttonClassName}
      >
        {glyph("−", Minus)}
      </button>
      <span className="inline-flex items-baseline">
        {prefix && !signed && <span aria-hidden="true" className="pointer-events-none font-semibold tabular-nums">{prefix}</span>}
        <TypeableNumber
          value={value}
          label={label}
          allowNegative={signed}
          signedText={signed}
          testId={inputTestId}
          className={inputClassName}
          onCommit={(n) => {
            // A typed zero is no change either: refused, the field goes back.
            if (signed && n === 0) return;
            apply(n);
          }}
        />
        {suffix && <span className="pointer-events-none whitespace-pre font-mono tabular-nums">{suffix}</span>}
      </span>
      <button
        type="button"
        aria-label={increaseLabel ?? `One more ${label}`}
        disabled={max !== undefined && value >= max}
        onClick={() => step(1)}
        className={buttonClassName}
      >
        {glyph("+", Plus)}
      </button>
    </span>
  );
}
