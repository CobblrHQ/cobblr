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
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { slimForStore, type StoredChatMessage } from "./chat-store";

export const CHAT_STORE_PREFIX = "cobblr.cobbchat.";

export function chatStoreKey(slug: string | null | undefined): string | null {
  return slug ? `${CHAT_STORE_PREFIX}${slug}` : null;
}

/** Where the conversation is kept beyond this device: the server (so another
 *  tab or device opens on the same one). Optional, so the hook stays usable
 *  where there is none. */
export interface ConversationRemote {
  read: () => Promise<{ messages: unknown[]; updated_at: string } | null>;
  write: (messages: unknown[]) => Promise<string>;
}

/** How long the panel waits after the last change before keeping the
 *  conversation server-side: a turn's messages arrive in a burst. */
export const REMOTE_WRITE_DELAY_MS = 1500;

const stampKey = (key: string) => `${key}.at`;

export function useStoredConversation<M extends StoredChatMessage>(
  slug: string | null | undefined,
  max: number,
  remote?: ConversationRemote,
): [M[], Dispatch<SetStateAction<M[]>>] {
  const [messages, setMessages] = useState<M[]>([]);
  const [messagesFor, setMessagesFor] = useState<string | null>(null);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  // The server copy is only written once it has been READ, so an empty tab
  // opening never overwrites the conversation another device is having.
  const [remoteReadFor, setRemoteReadFor] = useState<string | null>(null);

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
      localStorage.setItem(stampKey(key), new Date().toISOString());
    } catch {
      /* quota exceeded / storage disabled: history just won't persist */
    }
  }, [messages, slug, messagesFor, max]);

  // The same conversation, kept server-side, a moment after it settles.
  useEffect(() => {
    const r = remoteRef.current;
    if (!r || messagesFor !== (slug ?? null) || remoteReadFor !== (slug ?? null)) return;
    const slim = slimForStore(messages, max);
    const t = setTimeout(() => {
      void r.write(slim).catch(() => {
        /* offline: this device still has it, and the next change tries again */
      });
    }, REMOTE_WRITE_DELAY_MS);
    return () => clearTimeout(t);
  }, [messages, slug, messagesFor, remoteReadFor, max]);

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
    setRemoteReadFor(null);
    // The server's copy, when it is newer than this device's: another tab or
    // device carried the conversation on.
    const r = remoteRef.current;
    if (!r || !key) {
      setRemoteReadFor(slug ?? null);
      return;
    }
    let cancelled = false;
    let localAt = "";
    try {
      localAt = localStorage.getItem(stampKey(key)) ?? "";
    } catch {
      /* private mode */
    }
    void r
      .read()
      .then((kept) => {
        if (cancelled) return;
        if (kept && kept.messages.length && (!loaded.length || kept.updated_at > localAt)) setMessages(kept.messages as M[]);
      })
      .catch(() => {
        /* offline: this device's copy stands */
      })
      .finally(() => {
        if (!cancelled) setRemoteReadFor(slug ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return [messages, setMessages];
}
