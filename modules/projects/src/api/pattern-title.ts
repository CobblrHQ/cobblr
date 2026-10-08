// A pattern's own title, read from its PDF, for a pattern that was only ever
// named after its file ("RHC0502 032081V" from RHC0502-032081V.pdf, #5106).
//
// The PDF's metadata title wins when it reads as a title. Most pattern PDFs
// carry none (the Red Heart one does not), but they do repeat the pattern's
// name in the running header on every page ("Baby Turtles | EN-053 |
// Copyright …" names it in its first part); that repeated line is the title.
// No AI: nothing here leaves the box.

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/** "CROCHET CORNER-TO-CORNER THROW" → "Crochet Corner-to-Corner Throw".
 *  A line in mixed case is the designer's own spelling and is kept. */
function titleCase(line: string): string {
  if (line !== line.toUpperCase()) return line;
  return line
    .toLowerCase()
    .split(" ")
    .map((w, i) =>
      w
        .split("-")
        .map((p, j) => ((i > 0 || j > 0) && SMALL.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
        .join("-"),
    )
    .join(" ");
}

/** A line that could be a title: words, not a code, a date, an address or a page marker. */
function reads(line: string): boolean {
  if (line.length < 4 || line.length > 70) return false;
  if (/[@|©]|https?:|www\.|\.pdf$|^untitled$|^microsoft word/i.test(line)) return false;
  const words = line.match(/[A-Za-z][A-Za-z'’]+/g) ?? [];
  if (words.length < 2) return false;
  const digits = (line.match(/\d/g) ?? []).length;
  return digits <= 2;
}

const clean = (line: string) =>
  line
    .split(" | ")[0]!
    .replace(/\s+\d+\s+of\s+\d+\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

/** The title a pattern PDF gives itself, or null when it gives none. */
export function patternTitle(text: string, metadataTitle?: string | null): string | null {
  const meta = clean(metadataTitle ?? "");
  if (meta && reads(meta)) return titleCase(meta);
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const count = new Map<string, number>();
  for (const l of lines) if (reads(l)) count.set(l, (count.get(l) ?? 0) + 1);
  // The running header: the line repeated most, among the first ones on the
  // first page (a repeated care or copyright line sits at the foot).
  let best: string | null = null;
  for (const l of lines.slice(0, 12)) {
    const n = count.get(l) ?? 0;
    if (n >= 2 && (!best || n > (count.get(best) ?? 0))) best = l;
  }
  return best ? titleCase(best) : null;
}

/** Whether a record's name is still the one its file gave it: the same
 *  letters and digits as the file's name without its extension. */
export function namedAfterFile(name: string, filename: string): boolean {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const stem = (filename.split("/").pop() ?? filename).replace(/\.[a-z0-9]{1,5}$/i, "");
  return key(name) !== "" && key(name) === key(stem);
}
