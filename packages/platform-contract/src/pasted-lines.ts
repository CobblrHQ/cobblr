// A list pasted into an add box, read as the things it lists (#4115).
//
// A shopping list copied from Notes arrives as "- [ ] 2 oat milk\n• eggs\n3. bread".
// A one-line box folds that into one line, so it was added as one item called
// "- [ ] 2 oat milk • eggs 3. bread". Read here, each line is its own thing: the
// bullet, the checkbox and the numbering a list app writes are dropped, and a
// count written in front of it ("2 oat milk", "2x oat milk") or after it
// ("oat milk x2") becomes its quantity.

export interface PastedLine {
  title: string;
  /** The count written with it, as typed ("2", "1.5"), or null. */
  qty: string | null;
}

const MARKS = /^(?:[-*+•◦▪▫‣⁃·●○■□–—]\s*)?(?:\[[ xX✓✔]?\]\s*|[☐☑☒✓✔✗]\s*)?(?:(?:\d{1,3}|[a-zA-Z])[.)]\s+)?/;
const COUNT_FIRST = /^(\d+(?:[.,]\d+)?)\s*(?:[x×]\s*)?\s+(\S.*)$/;
const COUNT_FIRST_X = /^(\d+(?:[.,]\d+)?)\s*[x×]\s*(\S.*)$/;
const COUNT_LAST = /^(.*\S)\s+[x×]\s*(\d+(?:[.,]\d+)?)$/;

/** One pasted line, its marks gone and its count apart. Null for a line with nothing left. */
export function readPastedLine(raw: string): PastedLine | null {
  let t = raw.replace(/\s+/g, " ").trim();
  // A mark can follow another ("- [ ] 1. eggs"): drop them until none is left.
  for (let i = 0; i < 3; i++) {
    const next = t.replace(MARKS, "").trim();
    if (next === t) break;
    t = next;
  }
  if (!t) return null;
  const first = COUNT_FIRST_X.exec(t) ?? COUNT_FIRST.exec(t);
  if (first) return { title: first[2]!.trim(), qty: first[1]! };
  const last = COUNT_LAST.exec(t);
  if (last) return { title: last[1]!.trim(), qty: last[2]! };
  return { title: t, qty: null };
}

/** The things a pasted text lists, or null when it is one line (a paste the box takes as it is). */
export function readPastedList(text: string): PastedLine[] | null {
  const lines = text.split(/\r\n|\r|\n|\u2028/).map(readPastedLine).filter((l): l is PastedLine => l !== null);
  return lines.length >= 2 ? lines : null;
}
