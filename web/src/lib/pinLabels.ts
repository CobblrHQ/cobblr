// What each pin on a plan says, so neighbours never write over each other
// (#4560, #4564).
//
// Three sockets pinned a few centimetres apart in a drawer, on a phone: each
// label ran into the next, and the sizes that tell them apart (10 mm, 13 mm,
// 17 mm) were what got covered. A name is never dropped for nothing: each pin
// gets its full name where it fits, else its size alone ("10 mm", "5/8 in",
// the single most useful thing on a tightly packed drawer), else no label,
// and its full name always stays on hover, on focus and in its accessible
// name. A label that would run past the drawing's right edge sits on the
// pin's left instead.
//
// Pure, so the layout is asserted without a browser. Widths are an estimate of
// the 10 px label font (about 5.6 px a character plus padding), which is
// close enough to keep labels apart without measuring each one.

export interface PinAt {
  id: string;
  /** Where the pin points, in px from the drawing's top left. */
  x: number;
  y: number;
  name: string;
  /** What to say when the name does not fit, from the thing's own fields
   *  ("10 mm" from its Size); else the size is read off the name. */
  short?: string | null;
}

export interface PinLabel {
  text: string;
  /** Which side of the pin the label sits. */
  side: "right" | "left";
}

const CHAR_PX = 5.6;
const PAD_PX = 8;
/** The pin icon and the gap before its label. */
const PIN_PX = 10;
const ROW_PX = 16;
const MAX_LABEL_PX = 144;

// A fraction first ("3/8 inch" is three eighths, never "8 inch"), then a
// plain number that does not follow a slash.
const SIZE_RE = [
  /\b(\d+-\d+\/\d+|\d+\s?\/\s?\d+)\s?(?:in(?:ch(?:es)?)?\b|"|″)/gi,
  /(?<![\d/.])(\d+(?:\.\d+)?)\s?(mm|cm|in|inch|inches)\b/gi,
  /\b(\d+\s?\/\s?\d+)\b/g,
];
// "3/8 in drive" names the ratchet it fits, not the size of the socket.
const DRIVE_AFTER = /^\s*(?:-\s*)?(?:sq(?:uare)?\.?\s*)?drive\b/i;

/** The size a name carries ("10 mm socket" → "10 mm", "5/8\" socket" →
 *  "5/8 in"), or null when it names none. A size followed by "drive" is the
 *  drive ("10 mm socket, 3/8 in drive" → "10 mm"), used only when it is the
 *  only size there is ("3/8 in drive ratchet"). */
export function sizeOf(name: string): string | null {
  let drive: string | null = null;
  for (const re of SIZE_RE) {
    re.lastIndex = 0;
    for (let m = re.exec(name); m; m = re.exec(name)) {
      const n = m[1]!.replace(/\s+/g, "");
      const unit = (m[2] ?? "in").toLowerCase().replace(/inch(es)?/, "in");
      const text = `${n} ${unit === '"' || unit === "″" ? "in" : unit}`;
      if (DRIVE_AFTER.test(name.slice(m.index + m[0].length))) drive ??= text;
      else return text;
    }
  }
  return drive;
}

export function labelWidth(text: string): number {
  return Math.min(MAX_LABEL_PX, Math.ceil(text.length * CHAR_PX) + PAD_PX);
}

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}
const overlaps = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

/** The label each pin shows, keyed by pin id; a pin left out shows none. */
export function layoutPinLabels(pins: readonly PinAt[], widthPx: number): Map<string, PinLabel> {
  const out = new Map<string, PinLabel>();
  // Nothing measured yet (a first render, a test without layout): every pin
  // its full name, as before.
  if (!(widthPx > 0)) {
    for (const p of pins) out.set(p.id, { text: p.name, side: "right" });
    return out;
  }
  const taken: Box[] = pins.map((p) => ({ l: p.x - 8, r: p.x + 8, t: p.y - ROW_PX, b: p.y }));
  const order = [...pins].sort((a, b) => a.x - b.x || a.y - b.y);
  for (const p of order) {
    const short = p.short || sizeOf(p.name);
    const tries: Array<[string, PinLabel["side"]]> = [
      [p.name, "right"],
      [p.name, "left"],
      ...(short && short !== p.name ? ([[short, "right"], [short, "left"]] as Array<[string, PinLabel["side"]]>) : []),
    ];
    for (const [text, side] of tries) {
      const w = labelWidth(text);
      const box: Box = side === "right" ? { l: p.x + PIN_PX, r: p.x + PIN_PX + w, t: p.y - ROW_PX, b: p.y } : { l: p.x - PIN_PX - w, r: p.x - PIN_PX, t: p.y - ROW_PX, b: p.y };
      if (box.l < 0 || box.r > widthPx) continue;
      // A label may sit over its own pin's icon box, never over another's.
      const self = pins.indexOf(p);
      if (taken.some((t, i) => i !== self && overlaps(t, box))) continue;
      taken.push(box);
      out.set(p.id, { text, side });
      break;
    }
  }
  return out;
}
