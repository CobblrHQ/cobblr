// One swatch for every colour value a record can hold: a single colour, a
// gradient that blends along the length, or hard multi-colour segments
// (dual-colour silk, a variegated yarn). Every surface that shows a colour
// draws it with this, so a gradient spool looks the same on its tile, in the
// table, on the Filament page and in the field itself.

import { colourFill, colourLabel, parseColour } from "@cobblr/platform-contract/colour";
import { colorSwatch } from "./swatch";

export function Swatch({
  value,
  className = "w-4 h-4 rounded-sm",
  showEmpty = false,
}: {
  value: unknown;
  /** Size and shape. */
  className?: string;
  /** Draw a dashed ring when the value names no colour (else nothing). */
  showEmpty?: boolean;
}) {
  const spec = parseColour(value);
  // A colour name the browser knows ("Royal Blue") draws too.
  const fill = spec ? colourFill(spec) : colorSwatch(value);
  if (!fill) {
    return showEmpty ? <span className={`inline-block shrink-0 border border-dashed border-line dark:border-slate-600 ${className}`} aria-hidden /> : null;
  }
  return (
    <span
      role="img"
      aria-label={spec ? colourLabel(spec) : `colour ${String(value)}`}
      data-swatch={spec?.style ?? "solid"}
      className={`inline-block shrink-0 border border-line dark:border-slate-600 ${className}`}
      style={{ background: fill }}
    />
  );
}
