// What a calendar-raised notification is about, and what has already been said.
//
// Two producers that notice the same fact the same morning (a receipt's sweep
// and its purchase order's, a part's expiry and a re-run of the same sweep)
// raise the same subject. The notifier claims each subject once per person per
// day; a notice whose subjects were all claimed is dropped, and one that
// overlaps what was already said is narrowed to what is new, so the person
// reads each thing once, in one message, however many producers raised it.
import type { AttentionSubject, NotificationAction, NotificationCardRow } from "@cobblr/platform-contract";

/** One subject, as the text the claim ledger keys on. The line is the
 *  producer's words and is not part of what the thing IS. */
export function subjectClaimKey(s: { kind: string; id: string; question: string; line?: string }): string {
  return `${s.kind}/${s.id}/${s.question}`;
}

const plain = (line: string) => line.replace(/\*\*/g, "");

/** The same notice, saying only the subjects in `fresh`: its message is their
 *  lines, its card rows and the answers to them are the ones still named. What
 *  a card said as a whole (its heading, a count) is dropped, because it counted
 *  what is no longer there. */
export function narrowToWhatIsNew<
  T extends { message: string; card?: { heading?: string; body?: string; context?: string; rows?: NotificationCardRow[] }; actions?: NotificationAction[] },
>(p: T, fresh: readonly AttentionSubject[]): T {
  const lines = fresh.map((s) => s.line);
  const keep = new Set(lines);
  const out: T = { ...p, message: lines.map(plain).join("\n") };
  if (p.card) {
    const rows = p.card.rows?.filter((r) => keep.has(r.text));
    out.card = {
      ...(p.card.context ? { context: p.card.context } : {}),
      body: lines.map((l) => `• ${l}`).join("\n"),
      ...(rows?.length ? { rows } : {}),
    };
  }
  if (p.actions) {
    const named = new Set(p.card?.rows?.flatMap((r) => r.actions ?? []));
    const stillNamed = new Set(out.card?.rows?.flatMap((r) => r.actions ?? []));
    out.actions = p.actions.filter((a) => stillNamed.has(a.id) || !named.has(a.id));
  }
  return out;
}
