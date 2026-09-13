// The read rail's half of "every name is a chip".
//
// A write hands the widget the record it touched (chat-ledger.ts, `entity` and
// `touched`), and the panel draws the name as a chip that opens it. A read
// answer had nothing of the kind: the loop's tool results carry every record's
// kind, id and title, the model reads them, and the reply was prose. "The
// Hobbit by J.R.R. Tolkien (quantity: 2)." was correct and opened nothing (the
// 2026-09-13 new-user review; the owner said earlier fixes had not removed
// the class, and they had not: they covered the write rail).
//
// So the turn keeps every record its reads handed back, and the reply goes out
// with `mentions`: the ones its words actually name, by the one rule the
// widget also draws by (@cobblr/platform-contract/record-mentions). Nothing
// the turn did not read is ever a mention, and a title two records share is
// left as text. Proposals and their summaries are read the same way, so the
// three response shapes agree.

import { namedRecords, type RecordRef } from "@cobblr/platform-contract/record-mentions";

export type ChatMention = RecordRef;

/** A record, as a read tool returns one: a kind id, a record id (never itself
 *  kind-shaped, which is what tells a record from a kind or an action row),
 *  and what a person calls it. */
const KIND = /^[a-z0-9_-]+:[a-z0-9_-]+$/i;

/**
 * Every record in one read result, with kind, id and name. Shapes vary by
 * tool (a page of `items`, a bare record, a search hit, a record inside
 * another's resolved fields), so this walks rather than trusting one of them.
 * A row with a kind and an id but no name (a pairing) is not a record a
 * person can be shown; a row with a name and an id but no kind (a kind, an
 * action) is not a record at all.
 */
export function recordsFromToolResult(result: unknown): ChatMention[] {
  const out: ChatMention[] = [];
  const seen = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (!v || depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const rec = v as Record<string, unknown>;
    const kind = typeof rec.kind === "string" && KIND.test(rec.kind) ? rec.kind : null;
    const id = typeof rec.id === "string" && rec.id && !KIND.test(rec.id) ? rec.id : null;
    const label =
      typeof rec.title === "string" ? rec.title
      : typeof rec.name === "string" ? rec.name
      : typeof rec.label === "string" ? rec.label
      : null;
    if (kind && id && label?.trim()) {
      const key = `${kind} ${id}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind, id, label: label.trim() });
      }
    }
    for (const x of Object.values(rec)) visit(x, depth + 1);
  };
  visit(result, 0);
  return out;
}

/** The words of a response a person will read: the reply, a proposal's lead-in
 *  and its summary, each of several proposals' summaries. */
function proseOf(response: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof response.text === "string") parts.push(response.text);
  if (typeof response.summary === "string") parts.push(response.summary);
  for (const it of Array.isArray(response.items) ? response.items : []) {
    const s = (it as { summary?: unknown } | null)?.summary;
    if (typeof s === "string") parts.push(s);
  }
  return parts.join("\n");
}

/** The response with `mentions`: the records this turn read whose exact title
 *  its words carry. Absent when there are none, so a reply that names nothing
 *  is unchanged. */
export function withMentions<T extends Record<string, unknown>>(response: T, reads: readonly ChatMention[]): T & { mentions?: ChatMention[] } {
  if (reads.length === 0) return response;
  const { named } = namedRecords(proseOf(response), reads);
  return named.length ? { ...response, mentions: named } : response;
}
