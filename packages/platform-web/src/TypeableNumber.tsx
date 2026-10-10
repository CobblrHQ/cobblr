// The ONE typeable number every stepper shares (#4875): tap it and the phone
// opens its digit keypad (inputmode="numeric", enterkeyhint="done"), the whole
// value is selected, it commits on blur or Enter and Escape puts the old value
// back. What a commit MEANS (an absolute count, a change that skips zero) is
// the caller's: this only reads a whole number and hands it over.

import { useRef, useState, type KeyboardEvent } from "react";

/** A whole number from what was typed, or null. A leading minus (hyphen, minus
 *  sign or en dash) is the sign only when negatives are allowed. */
export function readWhole(text: string, allowNegative: boolean): number | null {
  const neg = allowNegative && /^\s*[-−–]/.test(text);
  const d = text.replace(/\D/g, "");
  if (!d) return null;
  return (neg ? -1 : 1) * Number(d);
}

/** What the field shows for a value: a signed one shows its plus. */
export function wholeText(n: number, signed: boolean): string {
  return signed && n > 0 ? `+${n}` : String(n).replace("-", "−");
}

export function TypeableNumber({
  value,
  onCommit,
  label,
  allowNegative = false,
  signedText = false,
  className,
  testId,
  text: controlledText,
  onTextChange,
  onRevert,
}: {
  value: number;
  /** A whole number the person committed. May equal the value; the caller decides. */
  onCommit: (n: number) => void;
  label: string;
  allowNegative?: boolean;
  /** Show a "+" before a positive value (a change, not a count). */
  signedText?: boolean;
  className?: string;
  testId?: string;
  /** For a caller that tracks the typed text itself (a live preview of what
   *  the number would do): the text shown, and every edit of it. Escape and an
   *  unreadable entry hand back through these too. */
  text?: string;
  onTextChange?: (text: string) => void;
  /** Escape: the number it had when it was focused. */
  onRevert?: (before: number) => void;
}) {
  const [ownText, setOwnText] = useState(wholeText(value, signedText));
  const controlled = controlledText !== undefined && !!onTextChange;
  const text = controlled ? controlledText! : ownText;
  const setText = (t: string) => (controlled ? onTextChange!(t) : setOwnText(t));
  const typing = useRef(false);
  const edited = useRef(false);
  const skip = useRef(false);
  const before = useRef(value);

  const commit = () => {
    typing.current = false;
    const wasEdited = edited.current;
    edited.current = false;
    if (skip.current) {
      skip.current = false;
      if (controlled) onRevert?.(before.current);
      else setText(wholeText(value, signedText));
      return;
    }
    // An untouched count may be fractional or have refreshed while focused.
    const n = !controlled && !wasEdited ? value : readWhole(text, allowNegative);
    if (n === null) {
      setText(wholeText(value, signedText));
      return;
    }
    onCommit(n);
    // Until the caller confirms its answer, keep the last confirmed number.
    setText(wholeText(value, signedText));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      skip.current = true;
      e.currentTarget.blur();
    }
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern={allowNegative ? "[-−+0-9]*" : "[0-9]*"}
      enterKeyHint="done"
      autoComplete="off"
      aria-label={label}
      data-testid={testId}
      value={controlled || typing.current ? text : wholeText(value, signedText)}
      onFocus={(e) => {
        typing.current = true;
        edited.current = false;
        before.current = value;
        if (!controlled) setOwnText(wholeText(value, signedText));
        e.currentTarget.select();
      }}
      onChange={(e) => {
        if (!typing.current) before.current = value;
        typing.current = true;
        edited.current = true;
        setText(e.target.value.replace(allowNegative ? /[^\d+\-−–]/g : /\D/g, ""));
      }}
      onBlur={commit}
      onKeyDown={onKey}
      className={className}
    />
  );
}
