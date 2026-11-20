// A turn that failed is finished, not waiting (#9510).
//
// "Lend the DeWalt drill to Sam, due back Friday" was refused by the provider
// ("…usage limit. Try again in about 30 seconds. Nothing was changed."). The
// next message was a question, "Who has my drill, and when is it due back?",
// and it got a card to lend the drill: the model read the refusal, with its
// "try again", as the earlier request still to be done. The panel keeps the
// refusal in the conversation so the question is not left hanging (#8738);
// the model is told what the refusal means, in words that cannot be read as
// an errand.

export interface SentMessage {
  role: "user" | "assistant";
  content: string;
  /** The turn failed, and this message is why. */
  failed?: boolean | null;
}

/** The conversation as the model reads it: a failed turn says it is done. */
export function turnsForTheModel(messages: readonly SentMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.map((m) =>
    m.role === "assistant" && m.failed
      ? {
          role: "assistant",
          // changed-claim-ok: said to the model of a failed turn, and a turn ends failed only when it changed nothing (turns.ts finishTurn)
          content: `(That request did not go through, and nothing was changed: ${m.content.trim()} It is finished. Answer the person's newest message as it stands; carry out the earlier request only if they ask for it again.)`,
        }
      : { role: m.role, content: m.content },
  );
}
