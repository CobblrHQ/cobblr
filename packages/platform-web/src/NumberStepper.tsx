// ONE stepper for every count you can nudge with − and + (#4875): the number in
// the middle is a real, typeable field, so a person with 40 of something types
// 40 on the numeric keypad instead of tapping + forty times.
//
// The number is an <input inputmode="numeric" pattern="[0-9]*" enterkeyhint=
// "done">: the phone opens its digit keypad; the whole value is selected on
// focus; it commits on blur or Enter and Escape puts the old value back.
//
// A tap counts at once and is never lost (#6014, #6525). It moves the number
// this stepper shows straight away and writes it, and the stepper keeps that
// number until the caller's value reaches it. Taps that come before then move
// the number on, and one more write takes it there. The stepper knows its own
// write is out: it never waits on `busy` to say so. A query library reports a
// write busy only after the render that follows the tap, and done before the
// refetch that brings the new count back, and in both gaps the stepper used to
// fall back to the old count, so the next tap counted from it and sent the
// same number again ("I still can't consistently press the + or −"). The − and
// + are each at least 44 by 44 on a phone or any touch screen, whatever size a
// caller draws them.
//
// `signed` is for a change-by count ("+3", "−2"): the field holds the size of
// the change, its sign follows the value, and − / + cross zero past it.
// Every stepper in the app is this component (a-stepper-is-always-the-numeric-
// stepper.test.ts discovers any that is not).

import { useLayoutEffect, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { TypeableNumber } from "./TypeableNumber";

/** A finger's target on a phone or a touch screen, whatever the caller's own
 *  size: min sizes win over a caller's w-7 / min-h-9 (#5903, #6014). In px,
 *  not rem: a finger is the same size at any text size, and at 125% text a
 *  rem target made a scan card's stepper 145px in a 117px column (#7766). */
const TOUCH_TARGET = "touch-manipulation max-sm:min-h-[44px] max-sm:min-w-[44px] [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]";
/** How long a written number waits for the caller's value to reach it before
 *  it is taken as refused: a phone's write and the read after it, with room. */
const CATCH_UP_MS = 6000;
/** No strip between − / + and the number for a finger to fall into: a
 *  caller's gap-1.5 left 6 px there (#6014). The buttons are big enough not
 *  to need the space. */
const NO_DEAD_ZONE = "max-sm:!gap-0 [@media(pointer:coarse)]:!gap-0";

export interface NumberStepperProps {
  value: number;
  /** A new value, from a tap or a typed commit. Never called with the value it already has. */
  onChange: (next: number) => void;
  /** Stock corrections keep changes made by others while the count was typed. */
  preserveConcurrentChanges?: boolean;
  min?: number;
  max?: number;
  /** A write is in flight: taps still count, and the next write waits for it. */
  busy?: boolean;
  /** For a caller that tracks the typed text itself (a live preview of what
   *  the number would do as it is typed): passed to the typeable number. */
  typed?: { text: string; onTextChange: (text: string) => void; onRevert?: (before: number) => void; onCommit?: () => void };
  /** What is counted, for the field's and buttons' names ("Toilet paper"). */
  label: string;
  /** Shown before the number, outside the field ("+" for an amount added).
   *  Never "×": the number alone says how many (#6525). */
  prefix?: string;
  suffix?: string;
  /** A change to stock you have, not a count: it may be negative, ± hop over
   *  zero (+1 → −1), and a typed zero is refused. */
  /** A measured amount: the typed number may carry a decimal point (#6142). */
  decimal?: boolean;
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
  preserveConcurrentChanges = false,
  max,
  busy = false,
  typed,
  label,
  prefix = "",
  suffix = "",
  signed = false,
  decimal = false,
  stopClicks = false,
  decreaseLabel,
  increaseLabel,
  testId,
  inputTestId,
  className = "inline-flex items-center",
  buttonClassName = "min-h-9 w-[32px] text-muted disabled:opacity-40",
  inputClassName = "w-10 bg-transparent text-center font-semibold tabular-nums text-content dark:text-mortar-100",
  icons = false,
  iconSize = 14,
}: NumberStepperProps) {
  const min = minProp ?? (signed ? -9999 : 0);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min, n));
  // The count the taps have reached, before the caller has it.
  const [pending, setPending] = useState<number | null>(null);
  const shown = pending ?? value;
  // The write that is out: the number sent, and the caller's value then.
  const out = useRef<{ n: number; from: number } | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const send = (n: number, from: number) => {
    out.current = { n, from };
    change.current(n);
  };
  // Before paint, so a caller that does not take the count shows its own
  // value again without a flash of the tapped one.
  useLayoutEffect(() => {
    const w = out.current;
    if (w) {
      if (value === w.n) out.current = null;
      else if (value !== w.from) {
        // The caller settled on a number of its own (clamped, or changed
        // elsewhere): its number wins.
        out.current = null;
        setPending(null);
        return;
      } else if (busy) return;
      else {
        // Written, and the caller's list not back yet. A write that was
        // refused never comes back: the number goes back to the caller's.
        const t = setTimeout(() => {
          out.current = null;
          setPending(null);
        }, CATCH_UP_MS);
        return () => clearTimeout(t);
      }
    }
    if (pending === null) return;
    if (pending === value) return setPending(null);
    // Taps that came while a write was out: one more write, of where they reached.
    if (!busy) send(pending, value);
  }, [busy, value, pending]);
  const apply = (n: number) => {
    const next = clamp(n);
    if (next === shown) return;
    setPending(next);
    if (!out.current && !busy) send(next, value);
  };
  /** Where a tap takes the number; the number itself when it goes nowhere. */
  const target = (delta: 1 | -1) => {
    // A change of zero is no change: hop over it (+1 → −1).
    let next = shown + delta;
    if (signed && next === 0) next = delta;
    next = clamp(next);
    return signed && next === 0 ? shown : next;
  };
  const stop = stopClicks ? (e: { stopPropagation(): void }) => e.stopPropagation() : undefined;
  const glyph = (g: string, I: typeof Minus) => (icons ? <I size={iconSize} /> : g);

  return (
    <span className={`${className} ${NO_DEAD_ZONE}`} data-testid={testId} data-stepper="" onClick={stop}>
      <button
        type="button"
        aria-label={decreaseLabel ?? `One fewer ${label}`}
        title={decreaseLabel ?? `One fewer ${label}`}
        disabled={target(-1) === shown}
        data-stepper-step="-"
        onClick={() => apply(target(-1))}
        className={`${buttonClassName} ${TOUCH_TARGET}`}
      >
        {glyph("−", Minus)}
      </button>
      {/* The number and its unit wrap, the unit under the number, before the
          stepper runs past its row: "1 ingredient" at 200% text (#8432). */}
      <span className="inline-flex min-w-0 flex-wrap items-baseline justify-center" data-stepper-number="">
        {prefix && !signed && <span aria-hidden="true" className="pointer-events-none font-semibold tabular-nums">{prefix}</span>}
        <TypeableNumber
          value={shown}
          label={label}
          allowNegative={signed}
          signedText={signed}
          decimal={decimal}
          testId={inputTestId}
          className={inputClassName}
          text={typed?.text}
          onTextChange={typed?.onTextChange}
          onRevert={typed?.onRevert}
          onCommit={(n, before) => {
            typed?.onCommit?.();
            // A typed zero is no change either: refused, the field goes back.
            if (signed && n === 0) return;
            apply(preserveConcurrentChanges ? shown + n - before : n);
          }}
        />
        {suffix && <span className="pointer-events-none whitespace-pre font-mono tabular-nums">{suffix}</span>}
      </span>
      <button
        type="button"
        aria-label={increaseLabel ?? `One more ${label}`}
        title={increaseLabel ?? `One more ${label}`}
        disabled={target(1) === shown}
        data-stepper-step="+"
        onClick={() => apply(target(1))}
        className={`${buttonClassName} ${TOUCH_TARGET}`}
      >
        {glyph("+", Plus)}
      </button>
    </span>
  );
}
