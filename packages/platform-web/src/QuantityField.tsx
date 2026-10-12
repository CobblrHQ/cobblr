// How much of a stocked record a line, a recipe or a count asks for, typed. Its
// precision is the record's unit, never the field's: a counted unit takes whole
// numbers, a measured one (m, kg, L) takes 0.25. A build's component field was
// a whole-number field for every record, so 0.5 m of vinyl became 1 m on blur
// and the saved recipe drew twice the stock (#5962).

import { NumberField } from "./NumberField";
import { useUnits } from "./useUnits";
import { isMeasuredUnit } from "./units";

/** The smallest measured amount a field takes: a thousandth, the precision a
 *  measured quantity is shown in. */
export const MEASURED_MIN = 0.001;

export interface QuantityFieldProps {
  value: number;
  onChange: (next: number) => void;
  /** The unit the record keeps its count in ("each", "m", "kg"), or null. */
  unit: string | null | undefined;
  label: string;
  className?: string;
  testId?: string;
  disabled?: boolean;
}

export function QuantityField({ value, onChange, unit, label, className, testId, disabled }: QuantityFieldProps) {
  const units = useUnits();
  const measured = isMeasuredUnit(unit, units.all);
  const symbol = measured ? units.suffix(unit) || (unit ?? "").trim() : "";
  return (
    <span className="inline-flex items-center gap-1" data-testid={testId ? `${testId}-wrap` : undefined} data-measure={measured ? "measured" : "counted"}>
      <NumberField
        value={value}
        onChange={onChange}
        integer={!measured}
        min={measured ? MEASURED_MIN : 1}
        label={label}
        className={className}
        testId={testId}
        disabled={disabled}
      />
      {symbol && <span className="text-xs text-muted">{symbol}</span>}
    </span>
  );
}
