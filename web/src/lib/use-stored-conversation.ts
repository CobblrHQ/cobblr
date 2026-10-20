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
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { slimForStore, type StoredChatMessage } from "./chat-store";
import { forgetUnownedChat, personalChatKey } from "./personal-chat-store";

export function chatStoreKey(owner: string | null | undefined, slug: string | null | undefined): string | null {
  return personalChatKey("chat", owner, slug);
}

/** Where the conversation is kept beyond this device: the server (so another
 *  tab or device opens on the same one). Optional, so the hook stays usable
 *  where there is none. */
export interface ConversationRemote {
  read: () => Promise<{ messages: unknown[]; updated_at: string } | null>;
  /** `owner` is the account the messages were read for: the server refuses
   *  them for anyone else. */
  write: (messages: unknown[], owner: string) => Promise<string>;
}

/** How long the panel waits after the last change before keeping the
 *  conversation server-side: a turn's messages arrive in a burst. */
export const REMOTE_WRITE_DELAY_MS = 1500;

/** Everything here is one person's in one workspace (personal-chat-store.ts):
 *  the scope is both, and the messages are only ever read, kept and written
 *  for the scope they were read back for. Signing in as someone else is a new
 *  scope exactly as switching workspace is, and cancels a write still pending
 *  for the last one. */
export function useStoredConversation<M extends StoredChatMessage>(
  owner: string | null | undefined,
  slug: string | null | undefined,
  max: number,
  remote?: ConversationRemote,
): [M[], Dispatch<SetStateAction<M[]>>, () => void] {
  const scope = owner && slug ? `${owner}/${slug}` : null;
  const [messages, setMessages] = useState<M[]>([]);
  const [messagesFor, setMessagesFor] = useState<string | null>(null);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  // The server copy is only written once it has been READ, so an empty tab
  // opening never overwrites the conversation another device is having.
  const [remoteReadFor, setRemoteReadFor] = useState<string | null>(null);

  useEffect(() => {
    if (messagesFor !== scope) return; // not yet read back for this person in this workspace
    const key = chatStoreKey(owner, slug);
    if (!key) return;
    try {
      // Plain data only (chat-store.ts): the words, the refs, a plan card with
      // which of its parts have run, where Save put an answer. Never a live
      // confirm card.
      const slim = slimForStore(messages, max);
      if (slim.length) localStorage.setItem(key, JSON.stringify(slim));
      else localStorage.removeItem(key);
      localStorage.setItem(personalChatKey("chat.at", owner, slug)!, new Date().toISOString());
    } catch {
      /* quota exceeded / storage disabled: history just won't persist */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, scope, messagesFor, max]);

  // The same conversation, kept server-side, a moment after it settles.
  useEffect(() => {
    const r = remoteRef.current;
    if (!r || !owner || !scope || messagesFor !== scope || remoteReadFor !== scope) return;
    const slim = slimForStore(messages, max);
    const t = setTimeout(() => {
      void r.write(slim, owner).catch(() => {
        /* offline: this device still has it, and the next change tries again */
      });
    }, REMOTE_WRITE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, scope, messagesFor, remoteReadFor, max]);

  useEffect(() => {
    forgetUnownedChat();
    const key = chatStoreKey(owner, slug);
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
    setMessagesFor(scope);
    setRemoteReadFor(null);
    // The server's copy, when it is newer than this device's: another tab or
    // device carried the conversation on.
    const r = remoteRef.current;
    if (!r || !key) {
      setRemoteReadFor(scope);
      return;
    }
    let cancelled = false;
    let localAt = "";
    try {
      localAt = localStorage.getItem(personalChatKey("chat.at", owner, slug)!) ?? "";
    } catch {
      /* private mode */
    }
    let clearedAt = "";
    try {
      clearedAt = localStorage.getItem(personalChatKey("chat.cleared", owner, slug)!) ?? "";
    } catch {
      /* private mode */
    }
    void r
      .read()
      .then((kept) => {
        if (cancelled || !kept) return;
        // A newer copy wins, an empty one too: another device cleared it. An
        // empty device takes the server's copy only when it was not cleared
        // after it: a clear whose write a reload cut off is still a clear (#7597).
        const newer = kept.updated_at > localAt;
        const unseen = !loaded.length && kept.messages.length > 0 && kept.updated_at > clearedAt;
        if (newer || unseen) setMessages(kept.messages as M[]);
      })
      .catch(() => {
        /* offline: this device's copy stands */
      })
      .finally(() => {
        if (!cancelled) setRemoteReadFor(scope);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  /** Clear the conversation for good: here, at once on the server rather
   *  after the usual pause (a reload in that pause cancelled the write, and
   *  the old conversation came back), and marked on this device so a reload
   *  never reads the cleared one back in (#7597). */
  const clear = useCallback(() => {
    setMessages([]);
    try {
      const at = personalChatKey("chat.cleared", owner, slug);
      if (at) localStorage.setItem(at, new Date().toISOString());
      const key = chatStoreKey(owner, slug);
      if (key) localStorage.removeItem(key);
    } catch {
      /* private mode: the server write below still clears it */
    }
    const r = remoteRef.current;
    if (r && owner && scope && remoteReadFor === scope) {
      void r.write([], owner).catch(() => {
        /* offline: the mark above keeps it cleared here, and the next change writes again */
      });
    }
  }, [owner, slug, scope, remoteReadFor]);

  return [messages, setMessages, clear];
}
