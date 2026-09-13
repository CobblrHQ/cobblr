// Which of these records does this text name?
//
// Asked which books it had, a workspace answered "The Hobbit by J.R.R. Tolkien
// (quantity: 2)." Right, and nothing on the screen opened the book: the server
// had read the record moments before, handed the model its title, and dropped
// it. The write rail names what it touched and the panel draws each name as a
// chip; the read rail had no such seam, so a correct answer was a dead end.
//
// The server decides which records an answer names (only records THIS turn
// read; only where the text carries the exact title) and the widget draws each
// as the chip the applied cards use. Both sides read this rule, so a name the
// server vouches for is exactly the name the widget links: one definition,
// nothing invented on either side.
//
// The rule: whole words, case-insensitive, longest name first so "Tea"
// cannot cut "Tazo Tea Wild Sweet Orange" in two, an existing markdown link
// stepped over whole, and a name two records share left as text rather than
// guessed at (the ambiguity is reported, not resolved). A title under two
// characters names nothing.
//
// A record is also named by a PREFIX of its title: "the blue cotton yarn" is
// how a person and a model both say "Blue cotton yarn 100g 200m" (the
// 2026-09-13 continuation review found it as text). A prefix is word-bounded
// and at least two words, or one word that is distinctive: four letters or
// more, not a stopword, and in no other read record's title. Prefixes are
// only ever of the records THIS TURN read, never a fuzzy search of the
// workspace, and a prefix two read records share names neither.
//
// Buildless subpath: node resolves this file as-is, so no runtime import of a
// sibling (the exports map is the only door).

export interface RecordRef {
  kind: string;
  id: string;
  label: string;
}

/** One place in the text where a record is named. */
export interface RecordNameSpan {
  start: number;
  end: number;
  ref: RecordRef;
  /** The text names the record by a prefix of its title, not the whole. */
  prefix: boolean;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A letter or a digit in any script: the characters a name cannot border.
const WORD = "\\p{L}\\p{N}";

/** Words a one-word prefix cannot be: they name nothing on their own. */
const STOPWORDS = new Set([
  "the", "a", "an", "my", "our", "your", "his", "her", "its", "their", "this", "that", "these", "those",
  "new", "old", "big", "small", "large", "little", "blue", "red", "green", "black", "white", "grey", "gray",
  "brown", "yellow", "pink", "orange", "purple", "with", "from", "for", "and", "set", "pack", "box", "bag",
  "item", "items", "part", "parts", "thing", "things", "stuff", "misc", "other", "spare", "used", "left",
]);

const words = (label: string): string[] => label.split(/\s+/).filter(Boolean);

/** The names each record can be called by (its title and its prefixes),
 *  lowercased, each mapped to the records it could mean. A name more than one
 *  record can be called by is ambiguous and matches nothing. */
function byTitle(records: readonly RecordRef[]): {
  single: Map<string, { ref: RecordRef; prefix: boolean }>;
  ambiguous: Array<{ label: string; records: RecordRef[] }>;
} {
  const usable: RecordRef[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const label = (r?.label ?? "").trim();
    if (label.length < 2 || !r.kind || !r.id) continue;
    const key = `${r.kind} ${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push({ kind: r.kind, id: r.id, label });
  }
  // A one-word prefix must be distinctive AMONG WHAT WAS READ: a word in two
  // read titles could mean either.
  const wordCount = new Map<string, number>();
  for (const r of usable) for (const w of new Set(words(r.label).map((w) => w.toLowerCase()))) wordCount.set(w, (wordCount.get(w) ?? 0) + 1);
  const groups = new Map<string, Array<{ ref: RecordRef; prefix: boolean }>>();
  const add = (name: string, ref: RecordRef, prefix: boolean): void => {
    const key = name.toLowerCase();
    const list = groups.get(key) ?? [];
    if (!list.some((x) => x.ref.kind === ref.kind && x.ref.id === ref.id)) list.push({ ref, prefix });
    groups.set(key, list);
  };
  for (const r of usable) {
    add(r.label, r, false);
    const ws = words(r.label);
    for (let k = ws.length - 1; k >= 1; k--) {
      const name = ws.slice(0, k).join(" ");
      if (k === 1) {
        const w = name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
        if (w.length < 4 || STOPWORDS.has(w) || (wordCount.get(w) ?? 0) > 1) continue;
      }
      add(name, r, true);
    }
  }
  const single = new Map<string, { ref: RecordRef; prefix: boolean }>();
  const ambiguous: Array<{ label: string; records: RecordRef[] }> = [];
  for (const [key, list] of groups) {
    if (list.length === 1) single.set(key, list[0]!);
    else if (list.every((x) => !x.prefix)) ambiguous.push({ label: list[0]!.ref.label, records: list.map((x) => x.ref) });
  }
  return { single, ambiguous };
}

/** Every place the text names one of the records, in order, non-overlapping. */
export function findRecordNames(text: string, records: readonly RecordRef[]): RecordNameSpan[] {
  if (!text) return [];
  const { single } = byTitle(records);
  if (single.size === 0) return [];
  const names = [...single.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => escapeRe(name))
    .join("|");
  // A link already written is one alternative, matched first and kept whole;
  // a name is the other, bordered by a non-word character (or the start) on
  // the left and a non-word (or the end) on the right.
  const re = new RegExp(`\\[[^\\]]*\\]\\([^)]*\\)|(^|[^${WORD}])(${names})(?![${WORD}])`, "giu");
  const out: RecordNameSpan[] = [];
  for (const m of text.matchAll(re)) {
    const name = m[2];
    if (name === undefined) continue;
    const hit = single.get(name.toLowerCase());
    if (!hit) continue;
    const start = (m.index ?? 0) + (m[1] ?? "").length;
    out.push({ start, end: start + name.length, ref: hit.ref, prefix: hit.prefix });
  }
  return out;
}

/** The records the text names, once each, and the titles it could not point
 *  at because more than one record carries them. */
export function namedRecords(
  text: string,
  records: readonly RecordRef[],
): { named: RecordRef[]; ambiguous: Array<{ label: string; records: RecordRef[] }> } {
  const { ambiguous } = byTitle(records);
  const named: RecordRef[] = [];
  const seen = new Set<string>();
  for (const s of findRecordNames(text, records)) {
    const key = `${s.ref.kind} ${s.ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    named.push(s.ref);
  }
  return { named, ambiguous };
}
