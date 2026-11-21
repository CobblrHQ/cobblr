// A live stream from the server that never leaves a gap (#4115).
//
// A stream says what changed the moment it lands; one that drops (a phone
// locked, a blip in the signal, the api restarting) hears nothing while it is
// down, and a change made in that gap is never said again. A phone locked for
// a few seconds came back to a teammate's rename that never showed, a minute
// later and until a reload: what it showed was read too recently to count as
// stale on the unlock. So every stream opens here, and:
//
// - back after a drop, it calls `back()`, which reads again what the stream
//   would have refreshed (what is on screen, never a half-typed form: a
//   field's own draft keeps it, use-field-draft.ts);
// - shown again after being hidden, or back in signal, it is opened again at
//   once, not after its wait (up to a minute): a hidden page's stream can die
//   without a word (iOS shuts a locked phone's connections), and one that did
//   say so would wait out its retry while the phone showed old numbers.
//
// A stream the server refuses (a member removed, or made a guest, while the
// phone was locked: its role is asked again on every open) stops for good and
// says so once, plainly (`refused`); it never loops asking for tickets it will
// not be given. Signed out (401) it stops quietly: the sign-in says that.
//
// EventSource cannot send an Authorization header, so each connect asks for a
// short ticket by an authed POST and puts it in the URL; a drop asks for a
// fresh one. lint:a-live-stream-never-leaves-a-gap holds every stream to it.

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export interface LiveStream {
  /** The stream's URL for a fresh ticket. */
  url(ticket: string): string;
  ticket(): Promise<{ ticket: string }>;
  /** Named events and what each does with its data. */
  on: Record<string, (data: string) => void>;
  /** Back after a drop: read again what a missed event would have refreshed. */
  back(): void;
  /** Up or down, for a caller that polls while it is down. */
  live?(up: boolean): void;
  /** Refused (403, 404): this person may no longer hear it. Called once. */
  refused?(): void;
}

/** A ticket the server will not give again: stop, never retry. */
const REFUSED = new Set([401, 403, 404]);

/** Opens the stream and keeps it open; returns what closes it. */
export function openLiveStream(s: LiveStream): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let wait = RETRY_MIN_MS;
  let dropped = false;
  let hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const down = () => {
    es?.close();
    es = null;
    if (!dropped) s.live?.(false);
    dropped = true;
  };
  const again = () => {
    if (closed) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect();
    }, wait);
    wait = Math.min(wait * 2, RETRY_MAX_MS);
  };
  const connect = async () => {
    let ticket: string;
    try {
      ticket = (await s.ticket()).ticket;
    } catch (e) {
      const status = (e as { status?: unknown } | null)?.status;
      if (typeof status === "number" && REFUSED.has(status)) {
        stopped();
        if (status !== 401) s.refused?.();
        return;
      }
      dropped = true;
      again();
      return;
    }
    if (closed) return;
    const mine = new EventSource(s.url(ticket));
    es = mine;
    mine.onopen = () => {
      if (es !== mine) return;
      wait = RETRY_MIN_MS;
      s.live?.(true);
      if (!dropped) return;
      dropped = false;
      s.back();
    };
    for (const [name, fn] of Object.entries(s.on)) mine.addEventListener(name, (e) => fn((e as MessageEvent<string> | undefined)?.data ?? ""));
    mine.onerror = () => {
      if (es !== mine) return;
      down();
      again();
    };
  };
  const wake = (e: Event) => {
    if (e.type === "visibilitychange") {
      const wasHidden = hidden;
      hidden = document.visibilityState === "hidden";
      if (hidden || !wasHidden) return;
    }
    if (closed || hidden) return;
    clearTimeout(retry);
    retry = undefined;
    down();
    wait = RETRY_MIN_MS;
    void connect();
  };
  function stopped() {
    closed = true;
    clearTimeout(retry);
    retry = undefined;
    es?.close();
    es = null;
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", wake);
    s.live?.(false);
  }
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);
  void connect();
  return stopped;
}

// The one plain notice a refused stream raises, for the shell to show.
let refusedNotice: string | null = null;
const noticeListeners = new Set<() => void>();
export const STREAM_REFUSED_SENTENCE =
  "You no longer have access to this workspace's live updates: your membership or role changed. What is on screen stops updating. Ask its owner if that is a mistake.";
export function raiseStreamRefused(): void {
  refusedNotice = STREAM_REFUSED_SENTENCE;
  noticeListeners.forEach((l) => l());
}
export function streamRefusedNotice(): string | null {
  return refusedNotice;
}
export function subscribeStreamRefused(l: () => void): () => void {
  noticeListeners.add(l);
  return () => noticeListeners.delete(l);
}

