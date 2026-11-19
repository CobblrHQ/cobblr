// A figure no tool gave.
//
//   "How many parts do I have?"  ->  "You have 42 parts."   (nothing read)
//   list_records: M3 bolt qty 4, M4 bolt qty 7  ->  "13 bolts in all"
//
// A count, a total or an amount reads the same whether it was counted or
// guessed, so a person cannot tell the two apart and acts on both. The
// grounding guard (groundless-answer.ts) only wakes for a question that names
// something in particular, and "how many parts" names nothing; after a read,
// nothing compared the numbers in the answer with the numbers that were read.
//
// The loop holds everything the model was given this turn: the person's words,
// the conversation, every tool result and the prompt. A figure in the answer
// that appears in none of them came from the model: memory, a guess, or its own
// arithmetic. It is handed back once, naming the figure and the read that
// gives one exactly (count_records counts and sums in code), and the model
// either reads it or leaves it out.
//
// Not figures, deliberately:
//   - names and model codes (X1, MK4, M3 bolt, Shelf 3D): digits inside a word;
//   - a numbered list's own numbers;
//   - dates, times and durations ("Friday, 21 November", "in 5 days"). The
//     model works those out from the TODAY line on purpose (#9507), and a date
//     that becomes a write is shown on the card the person confirms;
//   - "one", which is in "which one" far more often than in a count.

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORD = "(?:st|nd|rd|th)?";
const UNIT_OF_TIME = "(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|nights?|weeks?|months?|years?|yrs?)";

/** Spans that are a date, a time or a span of time: their digits are not figures. */
const NOT_A_FIGURE: RegExp[] = [
  /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  new RegExp(String.raw`\b\d{1,2}${ORD}(?:\s+of)?\s+${MONTH}\b\.?(?:,?\s+\d{4})?`, "gi"),
  new RegExp(String.raw`\b${MONTH}\.?\s+\d{1,2}${ORD}\b(?:,?\s+\d{4})?`, "gi"),
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)/gi,
  /\b\d{1,2}:\d{2}\b/g,
  new RegExp(String.raw`\b\d+(?:\.\d+)?\s*${UNIT_OF_TIME}\b`, "gi"),
  /\b(?:19|20)\d{2}\b/g,
  /^\s*\d+[.)]\s/gm,
];

const WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, hundred: 100, dozen: 12,
};

// A number standing as a word of its own: not inside a name like X1, MK4,
// 3D or CR-10.
const NUMBER = /(?<![\p{L}\p{N}_.,#№])(?<![\p{L}\p{N}][-/])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_.,#№])(?<![\p{L}\p{N}][-/])\d+(?:\.\d+)?(?![\p{L}\p{N}_]|[.,]\d)/gu;
const NUMBER_WORD = new RegExp(String.raw`\b(?:${Object.keys(WORDS).join("|")})\b`, "gi");

const valueOf = (written: string): number => WORDS[written.toLowerCase()] ?? Number(written.replace(/,/g, ""));

function blankDates(text: string): string {
  let t = text;
  for (const re of NOT_A_FIGURE) t = t.replace(re, (m) => " ".repeat(m.length));
  return t;
}

/** Every number written in some text, digits or words, as values. */
/** Ids are not figures: a uuid or a hex key carries digit runs of every size,
 *  and a made-up 13 would find itself in one. */
const AN_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b(?=[0-9a-z_-]*\d)(?=[0-9a-z_-]*[a-z])[0-9a-z_-]{16,}\b/gi;

function valuesIn(raw: string): Set<number> {
  const out = new Set<number>();
  const text = raw.replace(AN_ID, (m) => " ".repeat(m.length));
  // Plain digits (JSON writes 1204 and [4,7]), and thousands as people write them (1,204).
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  for (const m of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g)) out.add(Number(m[0].replace(/,/g, "")));
  for (const m of text.matchAll(NUMBER_WORD)) out.add(WORDS[m[0].toLowerCase()]!);
  // How many rows a result holds is a figure the tool gave: "two machines
  // called CubePro" read off a list of two is counted in code here, not by
  // the model.
  try {
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        out.add(v.length);
        v.forEach(walk);
      } else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(JSON.parse(raw));
  } catch {
    /* prose, or a clamped result: its digits above are what it gave */
  }
  return out;
}

/** A question about the person's own things, where a figure is a claim about
 *  their workspace rather than about the world ("a board foot is 144 cubic
 *  inches" is answered from knowledge, and rightly). */
export function asksAboutTheirOwn(question: string): boolean {
  return /\b(?:i|i'm|i've|im|ive|my|mine|me|we|our|ours|us)\b|\bhow (?:many|much)\b/i.test(question);
}

/** The figures in an answer that appear in nothing that was read or said, as written. */
export function unreadFigures(answer: string, grounded: readonly string[]): string[] {
  const said = blankDates(answer);
  const found: Array<{ at: number; written: string }> = [];
  for (const m of said.matchAll(NUMBER)) found.push({ at: m.index, written: m[0] });
  for (const m of said.matchAll(NUMBER_WORD)) found.push({ at: m.index, written: m[0] });
  if (found.length === 0) return [];
  const known = new Set<number>();
  for (const g of grounded) for (const v of valuesIn(g)) known.add(v);
  return found
    .sort((a, b) => a.at - b.at)
    .filter((f) => !known.has(valueOf(f.written)))
    .map((f) => f.written);
}

/** What the model is told when its answer carries a figure nothing gave it. */
export function figureNudge(figures: readonly string[], canRead: boolean): string {
  const named = figures.map((f) => `"${f}"`).join(", ");
  const said = `(Your answer says ${named}, and no tool result, nothing the person said and nothing in your instructions has that figure. A count, total or amount you worked out or remembered reads exactly like one you read, and the person will act on it.`;
  return canRead
    ? `${said} Read it now: count_records counts every record exactly and sums quantities (units); search_records or get_record has a record's own numbers. Then answer with the figure the tool returns. If no tool has it, leave the figure out and say what you could not find. A figure that is general knowledge rather than about their things (a unit, a standard size) may stay, said as general knowledge.)`
    : `${said} You cannot look in the workspace from this chat, so leave the figure out and say you could not count it here.)`;
}

export interface FigureTurn {
  content?: unknown;
  tool_calls?: unknown;
}

/**
 * The hand-back for an answer that gives a figure the turn was never given,
 * or null to let it stand. One function for the app's loop and the bench, so
 * both judge the same reply the same way.
 */
export function figureHandBack(o: {
  answer: string;
  question: string;
  turns: readonly FigureTurn[];
  reads: number;
  applied: number;
  /** The system prompt: today's date and a page's own figures are given there. */
  known?: string;
  canRead?: boolean;
}): string | null {
  if (o.reads === 0 && o.applied === 0 && !asksAboutTheirOwn(o.question)) return null;
  const given = [
    o.known ?? "",
    // How many reads and writes it made is the loop's own count.
    `${o.reads} ${o.applied}`,
    ...o.turns.flatMap((t) => [typeof t.content === "string" ? t.content : "", t.tool_calls ? JSON.stringify(t.tool_calls) : ""]),
  ];
  const unread = unreadFigures(o.answer, given);
  return unread.length > 0 ? figureNudge(unread, o.canRead ?? true) : null;
}
