// Turn a picked media + label layout (the toolbar's sheet/label dropdowns) into the
// Bluetooth print settings, so what you choose in the toolbar drives the print —
// not a size buried in the printer modal. It keeps the printer's own PROTOCOL and
// CALIBRATION (dialect, orientation, top margin, write characteristic, density,
// speed, and the die-cut gap of the loaded stock) and overrides only the MEDIA
// geometry (width, face size, n-up) from the chosen size. Pure + unit-tested; the
// BLE fire itself is the browser's job.

import type { BluetoothPrinterSettings } from "@cobblr/platform-web";

const MM_PER_IN = 25.4;
const DPI = 203;
const round1 = (n: number) => Math.round(n * 10) / 10;
const mmToDots = (mm: number) => Math.round((mm / MM_PER_IN) * DPI);

/** Build BLE settings for a chosen media (inches) + label layout (inches). The face
 *  width divides the media by the columns, so mediaTiles recovers the n-up. */
export function bleSettingsForSize(
  printer: BluetoothPrinterSettings,
  media: { width_in: number; height_in: number },
  label: { label_w: number; label_h: number },
): BluetoothPrinterSettings {
  const mediaWmm = round1(media.width_in * MM_PER_IN);
  const faceWmm = round1(label.label_w * MM_PER_IN);
  const faceHmm = round1(label.label_h * MM_PER_IN);
  // Feed + die-cut gap are physical properties of the loaded stock — keep them from
  // the printer's calibration. Continuous media has no gap.
  const feed = printer.media?.feed ?? "die-cut";
  const gapMm = feed === "die-cut" ? (printer.media?.gapMm ?? 0) : 0;
  return {
    ...printer, // protocol, direction, topMarginDots, writeCharUuid, density, speed, profileId, maxWidthMm
    widthDots: mmToDots(mediaWmm),
    labelHeightMm: faceHmm,
    gapMm,
    media: { widthMm: mediaWmm, heightMm: faceHmm, feed, gapMm },
    label: { widthMm: faceWmm, heightMm: faceHmm },
  };
}
