// It did one thing and said it did another.
//
//   ledger: Created "Lemon Zinger".  Created "Tazo Wild Sweet Orange".
//   answer: "I've moved the tea items ... directly into your Tea section!"
//
// Nothing was moved. The cards were right there saying "Created", and the
// sentence under them said the opposite - and the sentence is what a person
// reads (2026-09-08). A wrong action is a mistake; a wrong action described as
// the right one is a mistake nobody will look for, because the report says the
// job is done.
//
// The loop knows exactly which tools ran. So a claim it can check, it checks:
// a turn that applied only creates cannot say it moved, renamed or deleted
// anything. It is handed back once to say what it actually did - which is also
// its chance to notice the mistake and fix it, since the wrong thing is still
// sitting in the workspace at that point.
//
// Only ever fires on a turn that APPLIED something. A turn that proposes ("I
// can move those - confirm?") is talking about the future and is not lying,
// and a turn that changed nothing has nothing to misreport.

/** The write tools, grouped by what a person would call them. */
export type WriteClass = "create" | "update" | "delete";

export function classOfTool(name: string): WriteClass | null {
  if (name === "create_record") return "create";
  if (name === "update_record") return "update";
  if (name === "delete_record") return "delete";
  return null;
}

/** Words that CLAIM a class, in the past tense. Present tense is a plan
 *  ("I can move those"), and only a claim about what already happened can be
 *  checked against what already happened. */
const CLAIMS: Array<{ cls: WriteClass; re: RegExp; word: string }> = [
  { cls: "update", re: /\b(moved|renamed|updated|edited|changed|re-?filed|relocated)\b/i, word: "moved" },
  { cls: "delete", re: /\b(deleted|removed|cleared out|got rid of)\b/i, word: "deleted" },
  { cls: "create", re: /\b(created|added)\b/i, word: "created" },
];

/** "I have NOT moved them" is not a claim that it moved them. */
const NEGATED = /\b(not|never|n't|nothing|without|unable to|could ?n?o?t|didn'?t|haven'?t|hasn'?t)\b[^.!?]{0,40}$/i;

function claimsClass(text: string, re: RegExp): boolean {
  for (const m of text.matchAll(new RegExp(re.source, "gi"))) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    if (!NEGATED.test(before)) return true;
  }
  return false;
}

/** The message to hand back, or null when the report matches the ledger. */
export function misreportedWrites(text: string, appliedTools: readonly string[]): string | null {
  if (!text.trim() || appliedTools.length === 0) return null;
  // An ACTION could legitimately have moved, renamed or removed something -
  // that is what actions are - and this cannot tell which. A turn that ran one
  // is outside what can be checked, so it is left alone rather than guessed at.
  if (appliedTools.some((t) => !classOfTool(t))) return null;
  const did = new Set(appliedTools.map(classOfTool).filter((c): c is WriteClass => !!c));
  if (did.size === 0) return null;
  for (const claim of CLAIMS) {
    if (did.has(claim.cls)) continue;
    if (!claimsClass(text, claim.re)) continue;
    const didWords = [...did].map((c) => (c === "create" ? "created records" : c === "update" ? "updated records" : "deleted records"));
    return (
      `Your answer says you ${claim.word} something, and this turn ${didWords.join(" and ")} - nothing else. ` +
      `Say what actually happened, in plain words. If the change they asked for has not been made, ` +
      `say that too and make it now: what you did is still there, and they will read your sentence ` +
      `rather than the list of changes above it.`
    );
  }
  return null;
}
