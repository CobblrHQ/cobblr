// The one blur-to-commit field a record page edits its native columns with.
//
// The 2026-09-16 review started from a survey that found EditField written
// four times (assets, machines, purchases, records), each a copy with its
// own drift: one had lost `numeric`, one `type`, and every one carried
// `col-span-2` for its multiline case, a layout decision the field made for
// the grid around it. That is the shape #3059 was built to end: one field,
// here, and the packer (FieldPack) deciding the span from what the field
// needs (editFieldNeed below) rather than the field reaching into the grid.
//
// Uncontrolled on purpose: the value is the record's, the input holds the
// draft, and blur (or Enter, for one line) commits only when it changed. A
// controlled input here would write on every keystroke.
import type { ReactNode } from "react";
import { fieldNeed, type FieldNeed } from "./field-pack";
import { fieldPackControlClass, type FieldPackItem } from "./FieldPack";

/** The small mono caption every field in a pack wears over its control. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">{children}</span>;
}

/** A caption over any control: for the pickers and selects a page renders
 *  itself (a vendor picker, a state dropdown), so they wear the same label as
 *  an EditField beside them. */
export function LabeledField({ label, children, as = "label" }: { label: ReactNode; children: ReactNode; as?: "label" | "div" }) {
  const Wrap = as;
  return (
    <Wrap className="block min-w-0">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </Wrap>
  );
}

export interface EditFieldProps {
  label: ReactNode;
  /** The record's value. A number reaches a page as Postgres wrote it
   *  ("1.000" for a reorder point of 1); a numeric field shows the number. */
  value: string | number | null;
  onCommit: (v: string) => void;
  numeric?: boolean;
  multiline?: boolean;
  /** The input's type when it is not text or number: "date", "url". */
  type?: string;
  placeholder?: string;
  /** Extra classes on the control (a mono font for a code). */
  className?: string;
}

/** The text an EditField shows for a value: "" for none, and a number
 *  without the zeros Postgres pads it with. */
export function editFieldText(value: string | number | null | undefined, numeric?: boolean): string {
  if (value == null) return "";
  if (numeric && Number.isFinite(Number(value))) return String(parseFloat(Number(value).toFixed(3)));
  return String(value);
}

export function EditField({ label, value, onCommit, numeric, multiline, type, placeholder, className }: EditFieldProps) {
  const Cmp = multiline ? "textarea" : "input";
  const initial = editFieldText(value, numeric);
  return (
    <label className="block min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <Cmp
        type={multiline ? undefined : type ?? (numeric ? "number" : "text")}
        step={numeric && !multiline ? "any" : undefined}
        defaultValue={initial}
        placeholder={placeholder}
        onBlur={(e) => {
          if (e.target.value !== initial) onCommit(e.target.value);
        }}
        onKeyDown={(e) => {
          // Enter commits a line (blur does the write); Escape puts the
          // record's value back and leaves without writing.
          if (!multiline && e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            (e.target as HTMLInputElement).value = initial;
            (e.target as HTMLInputElement).blur();
          }
        }}
        rows={multiline ? 3 : undefined}
        className={"input " + fieldPackControlClass + (className ? " " + className : "")}
      />
    </label>
  );
}

/** What an EditField needs of the row, from its props and never from what
 *  its label means: a paragraph wants the row, a date more than a number. */
export function editFieldNeed(key: string, p: { label: string; numeric?: boolean; multiline?: boolean; type?: string; valueLength?: number }): FieldNeed {
  const control = p.multiline ? "markdown" : p.type === "date" ? "date" : p.type === "url" ? "url" : p.numeric ? "number" : "text";
  return fieldNeed(key, { control, label: p.label, valueLength: p.multiline ? undefined : p.valueLength });
}

/** An EditField as a pack item: the need from its props (a long value wants
 *  the row, as on the scan form), the node the field itself. */
export function editFieldItem(key: string, p: EditFieldProps & { label: string }): FieldPackItem {
  return { need: editFieldNeed(key, { ...p, valueLength: editFieldText(p.value, p.numeric).length }), node: <EditField {...p} /> };
}

export function EditSelect({ label, value, options, onCommit }: { label: ReactNode; value: string; options: readonly string[]; onCommit: (v: string) => void }) {
  return (
    <label className="block min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <select defaultValue={value} onChange={(e) => onCommit(e.target.value)} className={"input " + fieldPackControlClass}>
        {!options.includes(value) && value ? <option value={value}>{value}</option> : null}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
