// The place on a card's line is one unit: "📍 Printer Room" never breaks
// between "Printer" and "Room", so the line wraps before the place or after
// it, before its reason ("· where your other 3D Printers are"), never inside
// its name (#6013). The words stay ordinary text (a search for "Printer
// Room" finds it); the place is drawn as an inline-block, which moves to the
// next line whole and only breaks inside when it is wider than the line.

export interface LineRun {
  text: string;
  /** The pin and the place's name, to be drawn as one unit. */
  place: boolean;
}

const PIN = "📍";
const SEP = " · ";

/** A card's line cut into runs: the place (from its pin to the next " · ")
 *  and the text around it. */
export function lineRuns(line: string): LineRun[] {
  const at = line.indexOf(PIN);
  if (at < 0) return line ? [{ text: line, place: false }] : [];
  const end = line.indexOf(SEP, at);
  const stop = end < 0 ? line.length : end;
  return [
    ...(at > 0 ? [{ text: line.slice(0, at), place: false }] : []),
    { text: line.slice(at, stop), place: true },
    ...(stop < line.length ? [{ text: line.slice(stop), place: false }] : []),
  ];
}
