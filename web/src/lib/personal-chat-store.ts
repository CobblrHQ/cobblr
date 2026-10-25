// What the Ask Cobb panel keeps on this device is one person's: the
// conversation, the half-written question, the turn still running and the
// questions to recall with Up. So every key names the account as well as the
// workspace.
//
// They used to name only the workspace. Two members of one workspace sharing
// a browser then shared one conversation: the next one to sign in opened on
// the last one's private chat, and the panel saved it to their account on the
// server, where every device of theirs showed it (#7062). Keys from before
// carry no owner, so nobody can be told they are theirs; they are removed, not
// handed to whoever signs in next.
const PREFIX = "cobblr.mine.";

export type PersonalChatPart = "chat" | "chat.at" | "chat.cleared" | "draft" | "turn" | "input" | "waiting";

const UNOWNED_PREFIXES = ["cobblr.cobbchat.", "cobblr.cobbinput.", "cobblr.chat.draft.", "cobblr.chat.turn."];

/** The key for one part of one person's chat in one workspace; null until both are known. */
export function personalChatKey(part: PersonalChatPart, owner: string | null | undefined, slug: string | null | undefined): string | null {
  return owner && slug ? `${PREFIX}${owner}.${slug}.${part}` : null;
}

function removeWhere(match: (key: string) => boolean): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && match(k)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* storage disabled: there is nothing kept to remove */
  }
}

/** Removes chat kept before keys named their owner. */
export function forgetUnownedChat(): void {
  removeWhere((k) => UNOWNED_PREFIXES.some((p) => k.startsWith(p)));
}

/** Removes every person's chat from this device, at sign-out. The conversation
 *  itself is kept server-side and comes back at the next sign-in. */
export function forgetPersonalChat(): void {
  removeWhere((k) => k.startsWith(PREFIX) || UNOWNED_PREFIXES.some((p) => k.startsWith(p)));
}
