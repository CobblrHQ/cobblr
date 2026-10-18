import { pyRound } from "./pyMath.js";

export type ColorSource = number | EmbThread;

export function colorDistanceRedMean(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const redMean = pyRound((r1 + r2) / 2);
  const r = r1 - r2;
  const g = g1 - g2;
  const b = b1 - b2;
  return (
    (((512 + redMean) * r * r) >> 8) +
    4 * g * g +
    (((767 - redMean) * b * b) >> 8)
  );
}

/** Skips null entries; ties go to the last match. */
export function findNearestColorIndex(
  findColor: ColorSource,
  values: (EmbThread | null)[],
): number {
  const color = findColor instanceof EmbThread ? findColor.color : findColor;
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  let closestIndex = -1;
  let currentIndex = -1;
  let currentClosestValue = Infinity;
  for (const t of values) {
    currentIndex += 1;
    if (!t) continue;
    const dist = colorDistanceRedMean(
      red,
      green,
      blue,
      t.getRed(),
      t.getGreen(),
      t.getBlue(),
    );
    if (dist <= currentClosestValue) {
      currentClosestValue = dist;
      closestIndex = currentIndex;
    }
  }
  return closestIndex;
}

export class EmbThread {
  color: number = 0xff000000 >>> 0;
  description: string | null = null;
  catalog_number: string | null = null;
  details: string | null = null;
  brand: string | null = null;
  chart: string | null = null;
  weight: string | null = null;

  setColor(r: number, g: number, b: number): void {
    this.color =
      (0xff000000 | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;
  }

  getOpaqueColor(): number {
    return (0xff000000 | this.color) >>> 0;
  }

  getRed(): number {
    return (this.color >> 16) & 0xff;
  }

  getGreen(): number {
    return (this.color >> 8) & 0xff;
  }

  getBlue(): number {
    return this.color & 0xff;
  }

  findNearestColorIndex(values: (EmbThread | null)[]): number {
    return findNearestColorIndex(this.color, values);
  }

  hexColor(): string {
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    return `#${hex(this.getRed())}${hex(this.getGreen())}${hex(this.getBlue())}`;
  }

  // pyembroidery reverses 3-digit hex (#abc -> #ccbbaa); this expands it the CSS way.
  setHexColor(hexString: string): void {
    const h = hexString.replace(/^#+/, "");
    const size = h.length;
    if (size === 6 || size === 8) {
      const value = parseInt(h.substring(0, 6), 16);
      if (Number.isNaN(value)) {
        throw new Error(`setHexColor: invalid hex string "${hexString}"`);
      }
      this.color = value;
    } else if (size === 4 || size === 3) {
      const digits = h.substring(0, 3);
      const value = parseInt(
        digits[0]! + digits[0]! + digits[1]! + digits[1]! + digits[2]! + digits[2]!,
        16,
      );
      if (Number.isNaN(value)) {
        throw new Error(`setHexColor: invalid hex string "${hexString}"`);
      }
      this.color = value;
    }
  }
}
