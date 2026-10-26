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
  write: (messages: unknown[], owner: string, expectedAt: string | null) => Promise<string>;
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
): [M[], Dispatch<SetStateAction<M[]>>, () => void, string | null] {
  const scope = owner && slug ? `${owner}/${slug}` : null;
  const [messages, setMessages] = useState<M[]>([]);
  const [messagesFor, setMessagesFor] = useState<string | null>(null);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  // The server copy is only written once it has been READ, so an empty tab
  // opening never overwrites the conversation another device is having.
  const [remoteReadFor, setRemoteReadFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const server = useRef<{ scope: string | null; version: string | null; saved: string | null; stopped: boolean; active: boolean; tail: Promise<void> | null } | null>(null);

  const save = useCallback((slim: unknown[]) => {
    const r = remoteRef.current;
    const state = server.current;
    if (!r || !owner || !state || state.scope !== scope || state.stopped) return;
    const work = async () => {
      if (!state.active || state.stopped || state.saved === JSON.stringify(slim)) return;
      try {
        const at = await r.write(slim, owner, state.version);
        state.version = at;
        state.saved = JSON.stringify(slim);
        if (state.active) {
          setNotice(null);
          try {
            const local = localStorage.getItem(chatStoreKey(owner, slug)!) ?? "[]";
            if (local === JSON.stringify(slim)) {
              localStorage.setItem(personalChatKey("chat.server-at", owner, slug)!, at);
              localStorage.removeItem(personalChatKey("chat.unsaved", owner, slug)!);
            }
          } catch { /* storage disabled */ }
        }
      } catch (error) {
        if ((error as { code?: string }).code === "conversation_changed") state.stopped = true;
        if (state.active) setNotice(error instanceof Error ? error.message : "This conversation could not be saved. Your messages are kept on this device.");
      }
    };
    const pending = state.tail ? state.tail.then(work) : work();
    state.tail = pending;
    void pending.then(() => { if (state.tail === pending) state.tail = null; });
  }, [owner, slug, scope]);

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
      const state = server.current;
      const unsavedKey = personalChatKey("chat.unsaved", owner, slug)!;
      if (state?.saved === JSON.stringify(slim)) localStorage.removeItem(unsavedKey);
      else localStorage.setItem(unsavedKey, "true");
      if (state?.scope === scope && remoteReadFor === scope) {
        const versionKey = personalChatKey("chat.server-at", owner, slug)!;
        if (state.version) localStorage.setItem(versionKey, state.version);
        else localStorage.removeItem(versionKey);
      }
    } catch {
      /* quota exceeded / storage disabled: history just won't persist */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, scope, messagesFor, remoteReadFor, max]);

  // The same conversation, kept server-side, a moment after it settles.
  useEffect(() => {
    const r = remoteRef.current;
    if (!r || !owner || !scope || messagesFor !== scope || remoteReadFor !== scope) return;
    const slim = slimForStore(messages, max);
    const t = setTimeout(() => {
      save(slim);
    }, REMOTE_WRITE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, scope, messagesFor, remoteReadFor, max, save]);

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
    setNotice(null);
    const state = { scope, version: null as string | null, saved: null as string | null, stopped: false, active: true, tail: null as Promise<void> | null };
    server.current = state;
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
    let cachedVersion: string | null = null;
    let unsaved = false;
    try {
      cachedVersion = localStorage.getItem(personalChatKey("chat.server-at", owner, slug)!);
      unsaved = localStorage.getItem(personalChatKey("chat.unsaved", owner, slug)!) === "true";
    } catch { /* private mode */ }
    let clearedAt = "";
    try {
      clearedAt = localStorage.getItem(personalChatKey("chat.cleared", owner, slug)!) ?? "";
    } catch {
      /* private mode */
    }
    void r
      .read()
      .then((kept) => {
        if (cancelled) return;
        if (!kept) {
          state.saved = "[]";
          setRemoteReadFor(scope);
          return;
        }
        // A newer copy wins, an empty one too: another device cleared it. An
        // empty device takes the server's copy only when it was not cleared
        // after it: a clear whose write a reload cut off is still a clear (#7597).
        const newer = kept.updated_at > localAt;
        const unseen = !loaded.length && kept.messages.length > 0 && kept.updated_at > clearedAt;
        const same = JSON.stringify(slimForStore(loaded, max)) === JSON.stringify(kept.messages);
        if (((newer || unseen) && !unsaved) || same) {
          state.version = kept.updated_at;
          state.saved = JSON.stringify(kept.messages);
          try { localStorage.setItem(personalChatKey("chat.server-at", owner, slug)!, kept.updated_at); } catch { /* private mode */ }
          // A read requested before a local edit cannot replace that edit,
          // including a clear. Compare inside the updater so queued edits count.
          if (!same) setMessages((current) => current === loaded ? kept.messages as M[] : current);
        } else {
          state.version = cachedVersion;
        }
        setRemoteReadFor(scope);
      })
      .catch(() => {
        /* offline: this device's copy stands */
      });
    return () => {
      cancelled = true;
      state.active = false;
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
      save([]);
    }
  }, [owner, slug, scope, remoteReadFor, save]);

  return [messages, setMessages, clear, notice];
}
