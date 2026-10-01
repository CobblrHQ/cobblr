// What a conversation keeps across a reload, per workspace, on this device.
//
// EVERYTHING a message showed, unless it is named below as moment-to-moment
// state. This used to be the other way round: a short list of what to keep,
// and every card left off it. A reply that offered to delete a record and to
// turn a feature off came back after a reload as one bare line, "Turn off a
// feature", with neither offer under it (the owner, 2026-10-01). Each new kind
// of card had to remember to add itself to the list, and the offer cards never
// had. Now a new field on a message is kept unless somebody says here why not.
//
// A card comes back in the state it was left: an offer not yet answered can
// still be answered (the server checks it again when it runs, as it does for
// any confirm), a confirmed one shows what it did with the same Undo, a
// cancelled one stays cancelled.

import { CHAT_HISTORY_MESSAGES } from "@cobblr/platform-contract";

/** What a message carries that a reload must NOT bring back, and why. */
export const NOT_KEPT_ACROSS_A_RELOAD = {
  // A whole-workspace build running in the background: the spinner belongs to
  // a poll that a reload does not restart, so it would spin forever. The
  // build's own result arrives as a message of its own.
  building: "a spinner for a poll a reload does not restart",
  buildDraftId: "which draft that poll is following",
} as const;

export interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
  sentWith?: { label: string; kind?: string; ids?: string[]; text?: string };
  refs?: Array<{ kind: string; id: string; label: string }>;
  command?: unknown;
  proposal?: unknown;
  sections?: Record<string, unknown>;
  resolved?: boolean;
  /** Where Save put this answer: the line under it says so, after a reload too. */
  savedTo?: { label: string; kind: string; id: string };
}

const dropped = new Set<string>(Object.keys(NOT_KEPT_ACROSS_A_RELOAD));

/** Something on screen besides the words: a card, an outcome, a chip. */
function showsSomething(m: object): boolean {
  return Object.entries(m).some(([k, v]) => k !== "role" && k !== "content" && !dropped.has(k) && v !== undefined && v !== null && v !== false);
}

/** The messages as they are stored: the last `max`, each without its
 *  moment-to-moment state. A message with nothing said and nothing shown is
 *  dropped. */
export function slimForStore<M extends StoredChatMessage>(messages: M[], max: number): StoredChatMessage[] {
  return messages
    .filter((m) => (m.content && m.content.trim()) || showsSomething(m))
    .slice(-max)
    .map((m) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(m)) {
        if (dropped.has(k) || v === undefined) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
        out[k] = v;
      }
      return out as unknown as StoredChatMessage;
    });
}

/** The conversation as it is SENT with a message: the newest messages up to
 *  the number the server keeps, each just its role and words. The whole
 *  scrollback stays on the device. */
export function historyToSend<M extends { role: "user" | "assistant"; content: string }>(messages: M[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.slice(-CHAT_HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
}
