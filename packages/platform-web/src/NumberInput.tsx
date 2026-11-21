// The one box a number is typed into (#4115), used wherever an <input
// type="number"> stood: same props, same onChange(e => e.target.value).
//
// An <input type="number"> reads typed text the browser's own way and drops
// what it does not understand: a part's Minimum typed "1,5" on a phone whose
// language is English was kept as 15, and "1.500" on a German phone, fifteen
// hundred there, as 1.5. This box is text on the phone's decimal keypad. It
// shows a number the way the person writes one ("1,5" in German), reads what
// they type by their locale (locale-number.ts), and hands the page a plain
// number string ("1.5", or "" for an emptied box) in e.target.value, so a
// page's own Number(e.target.value) keeps working. While the text is not a
// number yet ("1,", "-") the page is told nothing; a text the other
// convention reads differently says what it will store before it is kept.
// min, max and "not a number" stay the form's to refuse, as the number box's
// own validity did. lint:numbers-are-typed-into-number-input keeps a bare one
// from coming back.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type InputHTMLAttributes } from "react";
import { readLocaleNumber, writeLocaleNumber } from "@cobblr/platform-contract/locale-number";
import { typingLocale } from "./NumberField";

/** What onChange and onBlur are handed: the number as plain text, the way the
 *  native box's e.target.value gave it. */
export interface NumberInputEvent {
  target: { value: string; valueAsNumber: number };
  currentTarget: { value: string; valueAsNumber: number };
}

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange" | "onBlur" | "step"> {
  /** A number, its plain text ("1.5"), or "" / null for none. */
  value?: number | string | null;
  defaultValue?: number | string | null;
  onChange?: (e: NumberInputEvent) => void;
  onBlur?: (e: NumberInputEvent) => void;
  /** Kept for the call sites that set it; a typed number has no spinner. */
  step?: number | string;
  /** Anything but "number" draws a plain input of that type, for a field
   *  whose type is chosen at run time. */
  type?: string;
}

function plain(v: number | string | null | undefined): string {
  if (v == null || v === "") return "";
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? String(n) : "";
}

const event = (value: string): NumberInputEvent => {
  const t = { value, valueAsNumber: value === "" ? NaN : Number(value) };
  return { target: t, currentTarget: t };
};

export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, defaultValue, onChange, onBlur, onFocus, step: _step, type = "number", min, max, inputMode, className, ...rest },
  ref,
) {
  const box = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => box.current as HTMLInputElement);
  const locale = typingLocale();
  const shown = (p: string) => (p === "" ? "" : writeLocaleNumber(Number(p), locale));
  const controlled = value !== undefined;
  const [text, setText] = useState(() => shown(plain(controlled ? value : defaultValue)));
  // An uncontrolled box (defaultValue) holds its own number; a controlled one, the page's.
  const own = useRef(plain(defaultValue));
  const outside = controlled ? plain(value) : own.current;
  const [editing, setEditing] = useState(false);
  // Out of the box, it shows what the page holds: the record moved, or the page
  // clamped or refused what was typed. Text that reads as that number is kept.
  useEffect(() => {
    if (editing) return;
    setText((t) => {
      const read = readLocaleNumber(t, locale).value;
      return read !== null && plain(read) === outside ? t : shown(outside);
    });
    // `shown` and `locale` follow from the props of this render.
  }, [outside, editing]);

  const said = readLocaleNumber(text, locale);
  const lo = min === undefined || min === "" ? undefined : Number(min);
  const hi = max === undefined || max === "" ? undefined : Number(max);
  useEffect(() => {
    const el = box.current;
    if (!el || type !== "number") return;
    const bad = text.trim() !== "" && said.value === null ? "Type a number" : said.value !== null && lo !== undefined && said.value < lo ? `At least ${writeLocaleNumber(lo, locale)}` : said.value !== null && hi !== undefined && said.value > hi ? `At most ${writeLocaleNumber(hi, locale)}` : "";
    el.setCustomValidity(bad);
  });

  if (type !== "number") {
    return (
      <input
        ref={box}
        type={type}
        className={className}
        min={min}
        max={max}
        inputMode={inputMode}
        {...(controlled ? { value: value == null ? "" : String(value) } : { defaultValue: defaultValue == null ? undefined : String(defaultValue) })}
        onChange={(e) => onChange?.(event(e.target.value))}
        onBlur={(e) => onBlur?.(event(e.target.value))}
        onFocus={onFocus}
        {...rest}
      />
    );
  }
  return (
    <>
      <input
        ref={box}
        type="text"
        data-number-input=""
        inputMode={inputMode ?? (Number.isInteger(Number(_step)) && Number(_step) >= 1 ? "numeric" : "decimal")}
        autoComplete="off"
        className={className}
        value={text}
        onFocus={(e) => {
          setEditing(true);
          onFocus?.(e);
        }}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const read = readLocaleNumber(t, locale).value;
          const next = t.trim() === "" ? "" : read === null ? null : String(read);
          if (next === null) return;
          if (!controlled) own.current = next;
          onChange?.(event(next));
        }}
        onBlur={() => {
          setEditing(false);
          const read = readLocaleNumber(text, locale).value;
          // Not a number: what the box held before comes back, and that is what the page hears.
          onBlur?.(event(text.trim() === "" ? "" : read === null ? outside : String(read)));
        }}
        {...rest}
      />
      {said.ambiguous && said.value !== null && (
        <span className="block text-[11px] text-muted" role="status">
          Saves as {said.value.toLocaleString(locale)}
        </span>
      )}
    </>
  );
});
