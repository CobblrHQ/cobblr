// What a conversation keeps across a reload, per workspace, on this device.
//
// Plain data only: the words, what they were sent with, the records they
// name, and a plan card with which of its parts have run. Never a live
// confirm card (a proposal the model made is gone with the turn), never
// working state. A card that is half done comes back half done, with the
// same Undo handles, because the person left it that way.

export interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
  sentWith?: { label: string; kind?: string; ids?: string[]; text?: string };
  refs?: Array<{ kind: string; id: string; label: string }>;
  command?: unknown;
  sections?: Record<string, unknown>;
  resolved?: boolean;
}

/** The messages as they are stored: the last `max`, each slimmed. A message
 *  with nothing said and no plan card is dropped. */
export function slimForStore<M extends StoredChatMessage>(messages: M[], max: number): StoredChatMessage[] {
  return messages
    .filter((m) => (m.content && m.content.trim()) || m.command)
    .slice(-max)
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.sentWith ? { sentWith: m.sentWith } : {}),
      ...(m.refs?.length ? { refs: m.refs } : {}),
      // The plan card, with its parts' runs: a reload shows the same
      // half-done card, and its Undo handles still point at the ledger.
      ...(m.command ? { command: m.command } : {}),
      ...(m.sections && Object.keys(m.sections).length ? { sections: m.sections } : {}),
      ...(m.resolved ? { resolved: true } : {}),
    }));
}
