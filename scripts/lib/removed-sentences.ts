// The pure half of lint:a-sentence-a-walk-asserts-is-never-removed-unseen: which removed lines held a sentence a walk spec asserts.

export interface RemovedLine {
  file: string;
  text: string;
}
export interface SpecText {
  spec: string;
  text: string;
}
export interface Violation {
  spec: string;
  text: string;
  file: string;
}

/** A phrase shorter than this is a word, not a sentence a person would read. */
export const MIN_SENTENCE = 12;

/** The lines a unified diff removes, with the file each came from. */
export function removedLines(diff: string): RemovedLine[] {
  const out: RemovedLine[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    const m = /^--- a\/(.+)$/.exec(line);
    if (m) {
      file = m[1]!;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---") && file) out.push({ file, text: line.slice(1) });
  }
  return out;
}

/** The lines a unified diff adds, with the file each went to. */
export function addedLines(diff: string): RemovedLine[] {
  const out: RemovedLine[] = [];
  let file = "";
  for (const line of diff.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) {
      file = m[1]!;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++") && file) out.push({ file, text: line.slice(1) });
  }
  return out;
}

/** Every spec text this change removes more often than it adds back. A
 *  sentence that moved is added where it went, in the same change; one that
 *  some other file happens to hold is not that (5e373c45b4 dropped the order
 *  page's "Payment date:" while the invoice PDF still said "Payment date",
 *  and the walk of the page went red). */
export function check(removed: RemovedLine[], added: RemovedLine[], specs: SpecText[]): Violation[] {
  const out: Violation[] = [];
  const count = (lines: RemovedLine[], text: string) => lines.filter((l) => l.text.includes(text)).length;
  for (const s of specs) {
    if (s.text.length < MIN_SENTENCE) continue;
    const from = removed.find((r) => r.text.includes(s.text));
    if (!from) continue;
    if (count(removed, s.text) > count(added, s.text)) out.push({ spec: s.spec, text: s.text, file: from.file });
  }
  return out;
}
