// A typed measure (a speed, a thickness in mm, a quantity): the one control for a
// number the person TYPES, as opposed to NumberStepper's counts (#5069).
//
// `<input type="number">` with `onChange={e => set(Number(e.target.value))}` has a
// trap: an empty field is "" and Number("") is 0, so clearing the box writes a 0
// into state, the box shows "0", and the person cannot empty it to type a new
// value (a quantity of 0, a blade depth of 0, and a refused plan that follows).
// Here the text lives in the field while it is being edited, the parent is only
// told a number that parses, and an empty or half-typed field ("", "-", "1.") is
// left alone until blur, where it goes back to the last good value (or to null,
// for a field that may be empty).
//
// It opens the phone's decimal keypad (inputmode="decimal", or "numeric" for whole
// numbers), accepts "," as the decimal mark, clamps to min and max on blur, and
// selects its text on focus.

import { useEffect, useRef, useState } from "react";

/** The number a typed string means, or null while it is not one (empty, a lone
 *  sign, a trailing point). "," is read as ".". */
export function readNumber(text: string, integer = false): number | null {
  const t = text.trim().replace(",", ".").replace("−", "-");
  if (!/^-?\d+(\.\d+)?$/.test(t) || (integer && t.includes("."))) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface NumberFieldProps {
  value: number | null | undefined;
  /** Called with a number that parses (and, when `nullable`, with null on an
   *  emptied field at blur). Never called with NaN or 0-for-empty. */
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  /** An emptied field at blur means "unset": reported through onClear. */
  onClear?: () => void;
  label?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  testId?: string;
}

const show = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? "" : String(v));

export function NumberField({ value, onChange, min, max, integer = false, onClear, label, id, className, disabled, required, placeholder, testId }: NumberFieldProps) {
  const [text, setText] = useState(show(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(show(value));
  }, [value]);

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const edit = (raw: string) => {
    const cleaned = raw.replace(/[^\d.,\-−]/g, "");
    setText(cleaned);
    const n = readNumber(cleaned, integer);
    if (n !== null && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n);
  };
  const settle = () => {
    editing.current = false;
    const n = readNumber(text, integer);
    if (n === null) {
      if (text.trim() === "" && onClear) onClear();
      else setText(show(value));
      return;
    }
    const next = clamp(n);
    setText(String(next));
    if (next !== value) onChange(next);
  };
  return (
    <input
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      autoComplete="off"
      id={id}
      aria-label={label}
      data-testid={testId}
      className={className}
      disabled={disabled}
      required={required}
      placeholder={placeholder}
      value={text}
      onFocus={(e) => {
        editing.current = true;
        e.currentTarget.select();
      }}
      onChange={(e) => edit(e.target.value)}
      onBlur={settle}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
