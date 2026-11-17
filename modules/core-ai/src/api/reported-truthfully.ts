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

// It was told no, and said yes.
//
//   tool:   "paprika" matches 2 records ... Ask them which one before running
//           labels:print; do not pick one for them.
//   answer: "I've queued a label for Smoked paprika."
//
// Nothing was queued (the corpus nightly, #6562). The write was handed back
// before it ran, and the sentence under it said it had happened. A turn whose
// every write was handed back and that changed nothing has nothing it may
// claim: the person reads "queued" and walks to the printer.
const DONE = /\b(queued|printed|moved|renamed|updated|edited|changed|re-?filed|relocated|created|added|deleted|removed|cleared|labell?ed|logged|filed|placed|sent|marked|merged|installed|turned (?:on|off))\b/i;

/** The message to hand back when a turn that changed nothing says it did. */
export function claimedAfterHandBack(text: string): string | null {
  if (!text.trim() || !claimsClass(text, DONE)) return null;
  return (
    "Nothing was changed this turn: the write you tried was handed back before it ran, with the reason in its result. " +
    "Your answer says it happened. Say what the result asked for instead (usually a question for the person), and do not say anything was done."
  );
}

// It made nothing, and said it had.
//
//   asked:  "Add my Prusa MK4 printer, it sits on the Workbench."
//   answer: "Create a machine: “Prusa MK4” ✓ Created Prusa MK4."
//
// No tool ran: the model wrote the card and its tick in its own words, and
// the next turn said the Prusa "isn't recorded in the workspace yet" (#9508).
// claimedAfterHandBack only reads a turn whose write was handed back; this one
// tried nothing at all. Only a claim in the first person or under a tick is
// read, since a turn with no write is often a question about what was done
// ("you added the M4 bolts this week") and that is history, not a claim.
const CLAIMED_DONE = new RegExp(
  `(?:✓|✔|\\bI(?:['’]ve| have)?\\s+(?:just\\s+|now\\s+|also\\s+)?|\\bDone[:,!.]\\s*)[^.!?\\n]{0,40}?(?:${DONE.source}|\\b(?:lent|ordered|scheduled|recorded|set up)\\b)`,
  "i",
);

/** The message to hand back when a turn that ran no write says it made one. */
export function claimedWithNoWrite(text: string): string | null {
  const claims = [...text.matchAll(new RegExp(CLAIMED_DONE.source, "gi"))].filter((m) => !/\b(?:not|never|nothing)\b|n['’]t\b/i.test(m[0]));
  if (!text.trim() || claims.length === 0) return null;
  return (
    "Nothing was changed this turn: no write ran, and no change was proposed. Your answer says something was done. " +
    "If they asked for a change, make it now with the tool for it (it becomes a card they confirm); otherwise say plainly that it has not been done."
  );
}

// A turn whose every write was handed back, and that changed nothing, ends on
// words that say so. "Lend the cordless drill to Sam until Friday" was refused
// four rounds running and the turn ended "Lend cordless drill to Sam until
// Friday": the request said back, which reads as done. The next turn's model
// read it so, and told the person "Sam has the cordless drill" (#8738). No
// claim word, so claimedAfterHandBack let it through. When nothing ran,
// "Nothing was changed." is always true; it is added unless the answer says
// so already, or asks the person something.
const SAYS_NOT_DONE = /\b(nothing (?:was|has been|is) changed|didn['’]t|did not|couldn['’]t|could not|can['’]t|cannot|haven['’]t|have not|hasn['’]t|wasn['’]t|was not|not (?:been|done|made))\b/i;

export function endsHonestly(text: string, handedBack: boolean, appliedCount: number): string {
  if (!handedBack || appliedCount > 0) return text;
  const said = text.trim();
  if (!said || said.endsWith("?") || SAYS_NOT_DONE.test(said)) return text;
  return `${said.replace(/[.!]*$/, ".")} Nothing was changed.`;
}

/** What a create in this call is called, by the kind's title field. */
function namesMade(call: { name: string; args?: Record<string, unknown> | null }): string[] {
  const titleOf = (f: unknown): string | null => {
    if (!f || typeof f !== "object") return null;
    const r = f as Record<string, unknown>;
    const t = r.name ?? r.title;
    return typeof t === "string" && t.trim() ? t.trim() : null;
  };
  const a = (call.args ?? {}) as Record<string, unknown>;
  if (call.name === "create_record") {
    const t = titleOf(a.fields);
    return t ? [t] : [];
  }
  if (call.name === "create_records" && Array.isArray(a.records)) {
    return a.records.map((r) => titleOf((r as { fields?: unknown } | null)?.fields ?? r)).filter((t): t is string => !!t);
  }
  return [];
}

/** The things a turn asked to make that the card it ends on does not carry:
 *  each create handed back or held this turn, by name, unless a proposal on
 *  the card makes one by the same name (#9514). */
export function leftOffTheCard(
  notProposed: ReadonlyArray<{ name: string; args?: Record<string, unknown> | null }>,
  proposed: ReadonlyArray<{ name: string; args?: Record<string, unknown> | null }>,
): string[] {
  const onCard = new Set(proposed.flatMap(namesMade).map((n) => n.toLocaleLowerCase()));
  const out: string[] = [];
  for (const name of notProposed.flatMap(namesMade)) {
    const k = name.toLocaleLowerCase();
    if (onCard.has(k) || out.some((o) => o.toLocaleLowerCase() === k)) continue;
    out.push(name);
  }
  return out;
}
