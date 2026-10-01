// The one door into Discussion.
//
// A record's Discuss button opened the side panel's Discussion tab and said
// nothing else, so the tab worked out what it was about from the URL. Most
// record views are modals that leave the URL alone, so a person who pressed
// Discuss on a bike landed in the workspace-wide room with no sign of the bike,
// and a message sent there was about nothing.
//
// So whoever opens Discussion says what about: `record` is the record, or null
// when the caller has none (the tab then shows the record in context, the one
// the page is about, or the workspace room). The record goes into the same
// context the Ask Cobb chip reads, so Cobb and Discussion are about one thing,
// and × on either chip drops it from both. `lint:discussion-opens-through-one-door`
// refuses any other way of opening the tab.

import { getChatSelection, publishRowSelection, type ChatSelection } from "./chat-context";

export interface DiscussionRecord {
  /** Entity kind id, "machines:machine". */
  kind: string;
  id: string;
  /** What a person calls it, for the chip. */
  label: string;
}

export function openDiscussion({ record }: { record: DiscussionRecord | null }): void {
  if (record) publishRowSelection({ label: record.label, kind: record.kind, ids: [record.id] });
  window.dispatchEvent(new CustomEvent("cobblr:open-rail", { detail: { tab: "discussion" } }));
}

/** The one record a context chip names, or null: several records, a highlight
 *  with no record behind it, or a kind that is not a record's are not a
 *  conversation's subject. */
export function discussionRecordOf(sel: ChatSelection | null = getChatSelection()): DiscussionRecord | null {
  if (!sel?.kind || sel.ids?.length !== 1) return null;
  const [module, type] = sel.kind.split(":");
  if (!module || !type) return null;
  return { kind: sel.kind, id: sel.ids[0]!, label: sel.label };
}
