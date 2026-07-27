// What the printer says about itself, shown next to it.
//
// Only serial-connected printers can answer. Both models tested speak this over
// Bluetooth CLASSIC, which a browser reaches through Web Serial; over BLE they
// stay silent, so a Bluetooth-connected printer shows nothing here rather than
// a wrong or empty reading.

import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Ruler } from "lucide-react";
import type { BatteryReading } from "@cobblr/thermal-print";

export interface PrinterStatusChipProps {
  widthMm?: number;
  heightMm?: number;
  battery?: BatteryReading;
}

/** Bars, never a percentage. The printers and their own vendor apps display
 *  bars, and the voltage mapping behind the number rests on a single
 *  calibration point — so a "78%" would be precision we have not earned. */
function BatteryBit({ battery }: { battery: BatteryReading }) {
  const { bars, charging } = battery;
  const Icon = charging ? BatteryCharging : bars >= 4 ? BatteryFull : bars >= 2 ? BatteryMedium : BatteryLow;
  const tone = charging
    ? "text-cobble-600 dark:text-cobble-400"
    : bars <= 1
      ? "text-ember-600 dark:text-ember-400"
      : "text-muted dark:text-slate-400";
  return (
    <span
      className={`inline-flex items-center gap-1 ${tone}`}
      // The raw byte is in the tooltip on purpose: the scale is anchored on a
      // single freshly-charged reading, so if it is wrong on other hardware the
      // number needed to fix it is already on screen.
      title={`About ${bars} of 5 bars${charging ? ", charging" : ""} (raw 0x${battery.raw.toString(16)})`}
    >
      <Icon size={13} />
      {bars}/5
    </span>
  );
}

export function PrinterStatusChip({ widthMm, heightMm, battery }: PrinterStatusChipProps) {
  if (!widthMm && !battery) return null;
  return (
    <span className="inline-flex items-center gap-3 text-[11px] font-mono flex-wrap">
      {widthMm && heightMm ? (
        <span
          className="inline-flex items-center gap-1 text-muted dark:text-slate-400"
          title="The roll the printer itself detected, not a configured value"
        >
          <Ruler size={13} /> {widthMm} × {heightMm} mm loaded
        </span>
      ) : (
        // Absence is INFORMATION here, not a blank. These printers read the size
        // from a code in the roll, and report unknown for a roll without one
        // rather than repeating the last size they knew. Saying so explains why
        // the size has to be set by hand, instead of leaving a gap that reads as
        // the check having silently failed.
        <span
          className="inline-flex items-center gap-1 text-muted dark:text-slate-400"
          title="This printer reads the size from a code in the roll. Plain labels have none, so the size has to be set by hand."
        >
          <Ruler size={13} /> no coded roll · set the size by hand
        </span>
      )}
      {battery ? <BatteryBit battery={battery} /> : null}
    </span>
  );
}
