// From "asked, but not answered" to a corpus line.
//
// Basic mode records every question it could not answer, in the words the
// person used (core_ai_basics_misses). That is the only real intake the chat
// corpus has: everything else in chat-corpus.ts was authored, and it shows -
// it is workshop nouns all the way down. This turns a miss into a DRAFT
// corpus line with a guessed bucket and claims, for a person to accept, edit
// or drop. It writes nothing to the repo; the guess is a starting point, and
// a wrong claim that got pasted unread would be enforced as truth.

export interface IntakeMiss {
  sample: string;
  times?: number;
}

/** What the workspace can run, for matching an instruction to an action. */
export interface IntakeAction {
  id: string;
  label?: string;
  examples?: string[];
}

export interface CorpusDraft {
  say: string;
  cat: string;
  /** The no_ai claim as corpus source: answer("x") | none | neverOffer | command */
  no_ai: string;
  /** The ai claim string. */
  ai: string;
  /** Why the guess, in a few words, so the reviewer knows what to check. */
  because: string;
  times: number;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9'\s]+/g, " ").replace(/\s+/g, " ").trim();

const QUESTION_LEAD = /^(how|what|what's|whats|where|where's|which|who|when|why|is|are|do|does|did|can|could|should|any|anything)\b/;
const COUNT_SHAPE = /\b(how many|how much|do i have any|any\b.*\?$|is there|are there|most of|most common)\b/;
const WHERE_SHAPE = /\b(where is|where's|where are|which bin|where did|end up)\b/;
const HOWTO_SHAPE = /\b(how do i|how to|how can i|where do i)\b/;
const GENERAL_SHAPE = /\b(what's a good|difference between|convert|how do i get .* off|recommend|best way to)\b/;
const IMPERATIVE_LEAD = /^(add|create|make|new|set|change|rename|move|put|delete|remove|mark|log|print|tag|untag|turn|enable|disable|group|ungroup|reorder|sort|save|track|record|comment|leave|take|call|track|order|reserve|restock)\b/;

/** Word overlap between the miss and an action's own example phrasings. */
function bestAction(say: string, actions: IntakeAction[]): { id: string; score: number } | null {
  const words = new Set(norm(say).split(" ").filter((w) => w.length > 2));
  let best: { id: string; score: number } | null = null;
  for (const a of actions) {
    const phrases = [...(a.examples ?? []), a.label ?? "", a.id.split(":")[1]?.replace(/-/g, " ") ?? ""];
    let score = 0;
    for (const ph of phrases) {
      const hit = norm(ph).split(" ").filter((w) => w.length > 2 && words.has(w)).length;
      score = Math.max(score, hit);
    }
    if (score > 0 && (!best || score > best.score)) best = { id: a.id, score };
  }
  return best && best.score >= 2 ? best : null;
}

export function draftCorpusLine(miss: IntakeMiss, actions: IntakeAction[]): CorpusDraft {
  const say = miss.sample.trim();
  const m = norm(say);
  const times = miss.times ?? 1;
  const isQuestion = say.trim().endsWith("?") || QUESTION_LEAD.test(m);
  if (HOWTO_SHAPE.test(m)) {
    return { say, cat: "how-to", no_ai: "none", ai: "answer", because: "a how-do-i question; write a basics rule if it recurs", times };
  }
  if (COUNT_SHAPE.test(m)) {
    return { say, cat: "my-data", no_ai: 'answer("my-data")', ai: "read:count_records", because: "a count of the person's own records", times };
  }
  if (WHERE_SHAPE.test(m)) {
    return { say, cat: "my-data", no_ai: 'answer("my-data")', ai: "read:search_records", because: "asks where something is", times };
  }
  if (isQuestion && GENERAL_SHAPE.test(m)) {
    return { say, cat: "general", no_ai: "none", ai: "answer", because: "general knowledge, not about the workspace", times };
  }
  if (!isQuestion && IMPERATIVE_LEAD.test(m)) {
    const a = bestAction(say, actions);
    if (a) return { say, cat: "workspace", no_ai: "neverOffer", ai: `action:${a.id}`, because: `an instruction; its words overlap the action's own phrasings`, times };
    if (/^(add|create|make|new)\b/.test(m)) return { say, cat: "write", no_ai: "neverOffer", ai: "create:record", because: "an instruction to add something", times };
    if (/^(delete|remove)\b/.test(m)) return { say, cat: "write", no_ai: "neverOffer", ai: "delete", because: "an instruction to remove something", times };
    return { say, cat: "write", no_ai: "neverOffer", ai: "update", because: "an instruction that changes something", times };
  }
  if (isQuestion) {
    return { say, cat: "my-data", no_ai: "none", ai: "read:list_records", because: "a question, probably about the person's own records", times };
  }
  return { say, cat: "general", no_ai: "none", ai: "clarify", because: "could not tell what it asks for; a model should ask", times };
}

/** The line as it would sit in chat-corpus.ts, with the reason as a comment. */
export function renderDraft(d: CorpusDraft): string {
  const no_ai = d.no_ai === "none" ? "none" : d.no_ai === "neverOffer" ? "neverOffer" : d.no_ai === "command" ? "command" : d.no_ai;
  return `  // asked ${d.times}x: ${d.because}\n  ...ph(${JSON.stringify(d.cat)}, ${no_ai}, ${JSON.stringify(d.ai)}, [${JSON.stringify(d.say)}]),`;
}
