// A workspace's Ask Cobb conversation, kept on this device across a reload.
//
// The messages and the workspace they belong to are one piece of state, set
// together, and the conversation is only written when the two agree. So a
// workspace switch never writes the previous workspace's messages under the
// new key, and nothing is written before the stored conversation has been
// read back. That second half used to be a ref the load effect set before the
// loaded messages had rendered: when a hidden panel is shown, React reconnects
// its effects, the write saw "loaded" beside still-empty messages and removed
// the stored conversation (every page load in development, where StrictMode
// reconnects on mount).
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { slimForStore, type StoredChatMessage } from "./chat-store";

export const CHAT_STORE_PREFIX = "cobblr.cobbchat.";

export function chatStoreKey(slug: string | null | undefined): string | null {
  return slug ? `${CHAT_STORE_PREFIX}${slug}` : null;
}

export function useStoredConversation<M extends StoredChatMessage>(
  slug: string | null | undefined,
  max: number,
): [M[], Dispatch<SetStateAction<M[]>>] {
  const [messages, setMessages] = useState<M[]>([]);
  const [messagesFor, setMessagesFor] = useState<string | null>(null);

  useEffect(() => {
    if (messagesFor !== (slug ?? null)) return; // not yet read back for this workspace
    const key = chatStoreKey(slug);
    if (!key) return;
    try {
      // Plain data only (chat-store.ts): the words, the refs, a plan card with
      // which of its parts have run, where Save put an answer. Never a live
      // confirm card.
      const slim = slimForStore(messages, max);
      if (slim.length) localStorage.setItem(key, JSON.stringify(slim));
      else localStorage.removeItem(key);
    } catch {
      /* quota exceeded / storage disabled: history just won't persist */
    }
  }, [messages, slug, messagesFor, max]);

  useEffect(() => {
    const key = chatStoreKey(slug);
    let loaded: M[] = [];
    if (key) {
      try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        if (Array.isArray(parsed)) loaded = parsed as M[];
      } catch {
        loaded = [];
      }
    }
    setMessages(loaded);
    setMessagesFor(slug ?? null);
  }, [slug]);

  return [messages, setMessages];
}
