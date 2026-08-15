/** Lay a scan item's fields out as chips, in the fewest rows.
 *
 *  The scan form used to be a column of labelled boxes: one per field, each
 *  ~72px tall, including every field the table declares that came back empty. A
 *  3D printer is 14 of those, of which the scan fills two, so the page was about
 *  85% empty inputs and ran past a phone screen and a half.
 *
 *  As chips, a field costs its own width and nothing more, and several sit on a
 *  row. The same item measured 3 rows instead of 14 blocks.
 *
 *  TWO RULES, both learned by measuring rather than by eye:
 *
 *  1. NOTHING IS DECLARED WIDE UP FRONT. A first attempt pinned "Add to" and
 *     "Name" to full width on the assumption their values are long. At 209px and
 *     182px in a 367px row they are not, so two rows sat half empty and a fourth
 *     row appeared for a chip that would have fitted (reported 2026-08-14: "you
 *     trying to tell me you can't fit Brand in line 1 or 2?"). A chip is wide
 *     only when it cannot share a row with the narrowest chip present, which is
 *     a fact about this item's values, not about the field's name.
 *
 *  2. PACK BY WIDTH, DESCENDING. flex-wrap fills in DOM order, which strands a
 *     short chip after a long one and leaves a gap it would have fitted.
 *
 *  Pure so the arithmetic can be tested without a browser; the caller measures
 *  the widths and applies the order. */

export interface ChipMeasure {
  key: string;
  /** Natural rendered width in px, measured with the chip laid out. */
  width: number;
}

export interface PackResult {
  /** Every key, in the order they should appear in the DOM. */
  order: string[];
  /** The rows they land on, for assertions and row counts. */
  rows: string[][];
  /** Keys that must render at full row width. */
  wide: Set<string>;
}

export function packChips(chips: ChipMeasure[], avail: number, gap = 6): PackResult {
  if (chips.length === 0) return { order: [], rows: [], wide: new Set() };
  if (avail <= 0) {
    // No layout to speak of; keep the caller's order rather than inventing one.
    return { order: chips.map((c) => c.key), rows: chips.map((c) => [c.key]), wide: new Set() };
  }

  const smallest = Math.min(...chips.map((c) => c.width));
  const wide = new Set(chips.filter((c) => c.width + gap + smallest > avail).map((c) => c.key));

  // Widest first: a big chip placed late can only start a new row, while a small
  // one placed late can still fill a gap.
  const order = [...chips].sort((a, b) => b.width - a.width);

  const rows: ChipMeasure[][] = [];
  for (const chip of order) {
    if (wide.has(chip.key)) {
      rows.push([chip]);
      continue;
    }
    let placed = false;
    for (const row of rows) {
      // A full-width chip owns its row; nothing joins it.
      if (row.length === 1 && wide.has(row[0]!.key)) continue;
      const used = row.reduce((n, c) => n + c.width, 0) + gap * row.length;
      if (used + chip.width <= avail) {
        row.push(chip);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([chip]);
  }

  return {
    order: rows.flat().map((c) => c.key),
    rows: rows.map((r) => r.map((c) => c.key)),
    wide,
  };
}

/** The fewest rows these chips could possibly occupy, ignoring how they pack.
 *
 *  Exists so a layout can be checked against the arithmetic rather than against
 *  an opinion: if the packer returns this, no arrangement does better and there
 *  is nothing left to tune. */
export function minimumRows(chips: ChipMeasure[], avail: number, gap = 6): number {
  if (chips.length === 0 || avail <= 0) return 0;
  const total = chips.reduce((n, c) => n + c.width, 0) + gap * (chips.length - 1);
  return Math.max(1, Math.ceil(total / avail));
}
