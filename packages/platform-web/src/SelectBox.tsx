// The checkbox that picks a row for a bulk action (#6782). A bare checkbox is
// a 12 px box, and a box cannot carry the invisible room a finger needs
// (touch-targets.css reaches out from a label, never from an input), so on a
// phone the row's select was a 12 px tap beside a row that opens the record.
// In its own label it takes a finger's 44 px and keeps the row's tap its own.
// lint:select-box holds every row's select to this.
import type { MouseEvent, ReactNode } from "react";

export function SelectBox({
  checked,
  onChange,
  label,
  className = "",
  boxClassName = "accent-cobble-600",
  title,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Read aloud: "Select <the row's name>", or "Select all". */
  label: string;
  /** The label's own placement in the row (a margin, shrink-0). */
  className?: string;
  boxClassName?: string;
  title?: string;
  /** Words shown beside the box, pressed with it ("Select all"). */
  children?: ReactNode;
}) {
  return (
    <label title={title} className={`inline-flex shrink-0 items-center justify-center cursor-pointer ${className}`} onClick={(e: MouseEvent) => e.stopPropagation()}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className={boxClassName} aria-label={label} />
      {children}
    </label>
  );
}
