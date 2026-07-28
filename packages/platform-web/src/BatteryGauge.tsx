// A battery drawn as a battery, filled by how much charge is actually left.
//
// The first version used lucide's Battery/BatteryMedium/BatteryLow glyphs, which
// quantise to three buckets: 76% and 40% drew the same icon, so the picture
// disagreed with the number printed next to it. Here the fill is proportional,
// so the glyph and the percent are the same fact told twice rather than two
// facts that can differ.
//
// The colour carries the only judgement: green while there is plenty, amber when
// it is worth noticing, red when a long run is at risk. Charging says so with a
// bolt instead of a level, because a level that is climbing is not a warning.

import type { BatteryReading } from "@cobblr/thermal-print";

/** Colour band for a charge level. One place, so the gauge and any text beside
 *  it cannot disagree about whether 20% is "fine". */
export function batteryTone(fraction: number, charging = false): "charging" | "good" | "low" | "critical" {
  if (charging) return "charging";
  if (fraction <= 0.15) return "critical";
  if (fraction <= 0.35) return "low";
  return "good";
}

// Light/dark pairs: moss-400 disappears on the dark canvas and moss-300 is too
// pale on the light one, so each tone names both.
const TONE_CLASS: Record<ReturnType<typeof batteryTone>, string> = {
  charging: "text-moss-600 dark:text-moss-300",
  good: "text-moss-600 dark:text-moss-300",
  low: "text-amber-600 dark:text-amber-400",
  critical: "text-ember-500 dark:text-ember-300",
};

export function BatteryGauge({
  battery,
  className = "",
  showPercent = true,
}: {
  battery: BatteryReading;
  className?: string;
  /** Off for a tight space where the gauge alone carries it. */
  showPercent?: boolean;
}) {
  const pct = Math.round(battery.fraction * 100);
  const tone = batteryTone(battery.fraction, battery.charging);
  // Clamp the drawn fill, never the reported number: a printer that reports
  // slightly over its own reference should still read 100% rather than draw a
  // bar wider than the battery.
  const fill = Math.max(0, Math.min(1, battery.fraction));
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${TONE_CLASS[tone]} ${className}`}
      title={
        battery.charging
          ? `Charging — ${pct}% (${battery.bars}/5 on the printer's own display)`
          : `Battery ${pct}% (${battery.bars}/5 on the printer's own display)`
      }
    >
      <svg viewBox="0 0 26 13" className="h-3 w-[26px] shrink-0" aria-hidden="true">
        <rect x="0.75" y="0.75" width="21.5" height="11.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="23.4" y="4" width="2.1" height="5" rx="1" fill="currentColor" />
        {fill > 0 && <rect x="2.5" y="2.5" width={18 * fill} height="8" rx="1" fill="currentColor" />}
        {battery.charging && (
          <path d="M13.2 2.6 L9.4 7.2 h2.6 l-1.2 3.2 3.8 -4.6 h-2.6 z" fill="currentColor" stroke="none" />
        )}
      </svg>
      {showPercent && <span className="tabular-nums font-medium">{pct}%</span>}
    </span>
  );
}

/** Everything a printer just told us about itself, as one inline readout: the
 *  loaded roll, then the battery as a gauge.
 *
 *  The counterpart to describePrinterStatus, which is the same reading as plain
 *  text for places that cannot render an element (a title attribute, a toast).
 *  Both exist so no surface has to assemble the pieces itself and drift. */
export function PrinterReadout({
  reading,
  className = "",
}: {
  reading: { widthMm?: number; heightMm?: number; battery?: BatteryReading; responded: boolean } | null;
  className?: string;
}) {
  if (!reading?.responded) return null;
  const roll = reading.widthMm && reading.heightMm ? `${reading.widthMm} × ${reading.heightMm} mm` : null;
  if (!roll && !reading.battery) return null;
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {roll && <span>{roll}</span>}
      {reading.battery && <BatteryGauge battery={reading.battery} />}
    </span>
  );
}
