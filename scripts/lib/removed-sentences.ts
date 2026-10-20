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

/** Every spec text a removed line held and the tree no longer holds anywhere. */
export function check(removed: RemovedLine[], specs: SpecText[], inTree: (text: string) => boolean): Violation[] {
  const out: Violation[] = [];
  const gone = new Map<string, boolean>();
  for (const s of specs) {
    if (s.text.length < MIN_SENTENCE) continue;
    const from = removed.find((r) => r.text.includes(s.text));
    if (!from) continue;
    if (!gone.has(s.text)) gone.set(s.text, !inTree(s.text));
    if (gone.get(s.text)) out.push({ spec: s.spec, text: s.text, file: from.file });
  }
  return out;
}
