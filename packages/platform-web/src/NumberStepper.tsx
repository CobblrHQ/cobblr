// ONE stepper for every count you can nudge with − and + (#4875): the number in
// the middle is a real, typeable field, so a person with 40 of something types
// 40 on the numeric keypad instead of tapping + forty times.
//
// The number is an <input inputmode="numeric" pattern="[0-9]*" enterkeyhint=
// "done">: the phone opens its digit keypad; the whole value is selected on
// focus; it commits on blur or Enter and Escape puts the old value back.
//
// A tap counts at once and is never lost (#6014). It moves the number this
// stepper shows straight away and writes it; taps that come while that write
// is in flight move the number on, and one more write takes it to where they
// reached once the first has landed. It used to
// ignore a tap while a write was in flight, and since every tap was a write,
// a quick run on a phone dropped most of its taps ("the plus is very
// difficult to actually get to recognize"). The − and + are each at least
// 44 by 44 on a phone or any touch screen, whatever size a caller draws them.
//
// `signed` is for a change-by count ("+3", "−2"): the field holds the size of
// the change, its sign follows the value, and − / + cross zero past it.
// Every stepper in the app is this component (a-stepper-is-always-the-numeric-
// stepper.test.ts discovers any that is not).

import { useLayoutEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { TypeableNumber } from "./TypeableNumber";

/** A finger's target on a phone or a touch screen, whatever the caller's own
 *  size: min sizes win over a caller's w-7 / min-h-9 (#5903, #6014). */
const TOUCH_TARGET = "touch-manipulation max-sm:min-h-11 max-sm:min-w-11 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";
/** No strip between − / + and the number for a finger to fall into: a
 *  caller's gap-1.5 left 6 px there (#6014). The buttons are big enough not
 *  to need the space. */
const NO_DEAD_ZONE = "max-sm:!gap-0 [@media(pointer:coarse)]:!gap-0";

export interface NumberStepperProps {
  value: number;
  /** A new value, from a tap or a typed commit. Never called with the value it already has. */
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** A write is in flight: taps still count, and the next write waits for it. */
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
  // The count the taps have reached, before the caller has it.
  const [pending, setPending] = useState<number | null>(null);
  const shown = pending ?? value;
  const sent = useRef<number | null>(null);
  const wasBusy = useRef(busy);
  const change = useRef(onChange);
  change.current = onChange;
  const send = (n: number) => {
    sent.current = n;
    change.current(n);
  };
  // Before paint, so a caller that does not take the count shows its own
  // value again without a flash of the tapped one.
  useLayoutEffect(() => {
    const settled = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (pending === null || busy) return;
    // Taps that came while a write was in flight: one more write, of where
    // they reached.
    if (settled && pending !== sent.current && pending !== value) return send(pending);
    // No write in flight: the number is the caller's again (taken, or refused).
    setPending(null);
  }, [busy, value, pending]);
  const apply = (n: number) => {
    const next = clamp(n);
    if (next === shown) return;
    setPending(next);
    if (!busy) send(next);
  };
  const step = (delta: 1 | -1) => {
    // A change of zero is no change: hop over it (+1 → −1).
    let next = shown + delta;
    if (signed && next === 0) next = delta;
    apply(next);
  };
  const stop = stopClicks ? (e: { stopPropagation(): void }) => e.stopPropagation() : undefined;
  const glyph = (g: string, I: typeof Minus) => (icons ? <I size={iconSize} /> : g);

  return (
    <span className={`${className} ${NO_DEAD_ZONE}`} data-testid={testId} data-stepper="" onClick={stop}>
      <button
        type="button"
        aria-label={decreaseLabel ?? `One fewer ${label}`}
        title={decreaseLabel ?? `One fewer ${label}`}
        disabled={shown <= min}
        data-stepper-step="-"
        onClick={() => step(-1)}
        className={`${buttonClassName} ${TOUCH_TARGET}`}
      >
        {glyph("−", Minus)}
      </button>
      <span className="inline-flex items-baseline" data-stepper-number="">
        {prefix && !signed && <span aria-hidden="true" className="pointer-events-none font-semibold tabular-nums">{prefix}</span>}
        <TypeableNumber
          value={shown}
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
        title={increaseLabel ?? `One more ${label}`}
        disabled={max !== undefined && shown >= max}
        data-stepper-step="+"
        onClick={() => step(1)}
        className={`${buttonClassName} ${TOUCH_TARGET}`}
      >
        {glyph("+", Plus)}
      </button>
    </span>
  );
}
