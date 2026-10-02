// Resolves an image src for <img>. External URLs (or null) pass
// through. Internal /api/v1/... URLs are fetched with the SPA's
// Bearer token, converted to blob: URLs, and revoked on unmount.
//
// EntityThumb and EntityTile both use this so the photo handling
// stays consistent across list and gallery views.

import { useEffect, useState } from "react";
import { reportBrokenPicture } from "./brokenPictures";

const TOKEN_KEY = "cobblr.token";

function needsAuth(src: string): boolean {
  // /api/v1/public/... is the no-auth, token-gated public route — it must
  // load WITHOUT a Bearer token (the public /p/:token page holds none).
  // Pass it straight to <img>; only the authed /api/v1/... routes get the
  // token-fetch-to-blob treatment.
  const isPublic = (p: string) => p.startsWith("/api/v1/public/");
  if (src.startsWith("/api/v1/")) return !isPublic(src);
  try {
    const u = new URL(src, window.location.href);
    if (
      u.origin === window.location.origin &&
      u.pathname.startsWith("/api/v1/") &&
      !isPublic(u.pathname)
    ) {
      return true;
    }
  } catch {
    // Malformed URL — let <img> deal with it.
  }
  return false;
}

/** A picture fetched once and shared: every tile and every reopen of the same
 *  address reads the one copy, so a card does not go blank while it fetches
 *  again. Released a while after the last reader lets go. */
interface Held {
  url: string | null;
  pending: Promise<string | null> | null;
  readers: number;
  release: ReturnType<typeof setTimeout> | null;
  /** Asked for again past the browser's cache already: once is enough. */
  reloaded: boolean;
  listeners: Set<(url: string | null) => void>;
}
const held = new Map<string, Held>();
const KEEP_MS = 60_000;
/** A grid asks for many pictures at once; one that fails to come in that
 *  burst (a 429, a 503, a dropped connection) is asked again before the card
 *  settles on its letter. One that is genuinely gone (401, 403, 404) is not. */
const RETRY_DELAYS_MS = [400, 1_500];

async function fetchPicture(src: string, reload = false): Promise<string | null> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
  for (let attempt = 0; ; attempt++) {
    let again = false;
    try {
      const init: RequestInit = { headers: token ? { Authorization: `Bearer ${token}` } : {} };
      if (reload) init.cache = "reload";
      const res = await fetch(src, init);
      if (res.ok) {
        const blob = await res.blob();
        // A body shorter than it says it is was cut off on the way, and the
        // browser may hand that same short copy back on every revalidation:
        // a picture that "loads" and draws nothing, or half. Ask once more
        // past the cache.
        const said = Number(res.headers.get("content-length") ?? 0);
        if (!reload && said > 0 && blob.size < said) return fetchPicture(src, true);
        return URL.createObjectURL(blob);
      }
      again = res.status === 408 || res.status === 429 || res.status >= 500;
    } catch {
      again = true;
    }
    const wait = RETRY_DELAYS_MS[attempt];
    if (!again || wait === undefined) return null;
    await new Promise((r) => setTimeout(r, wait));
  }
}

function hold(src: string): Held {
  let h = held.get(src);
  if (!h) {
    h = { url: null, pending: null, readers: 0, release: null, reloaded: false, listeners: new Set() };
    held.set(src, h);
  }
  if (h.release) {
    clearTimeout(h.release);
    h.release = null;
  }
  h.readers++;
  if (!h.url && !h.pending) {
    const entry = h;
    entry.pending = fetchPicture(src).then((url) => {
      entry.pending = null;
      entry.url = url;
      // A failure is not kept: the next reader asks again.
      if (!url) {
        held.delete(src);
        reportBrokenPicture(src, "it would not load");
      }
      return url;
    });
  }
  return h;
}

function letGo(src: string, h: Held): void {
  h.readers--;
  if (h.readers > 0 || h.release) return;
  h.release = setTimeout(() => {
    if (h.readers > 0) return;
    if (h.url) URL.revokeObjectURL(h.url);
    if (held.get(src) === h) held.delete(src);
  }, KEEP_MS);
}

/** Ask for a picture again past the browser's cache, once: a copy that would
 *  not draw. Every tile showing it gets the new copy. False when it was asked
 *  again already (or is not a fetched picture), so the caller gives up. */
export function reloadPicture(src: string): boolean {
  const h = held.get(src);
  if (!h || h.reloaded || h.pending) return false;
  h.reloaded = true;
  const old = h.url;
  h.url = null;
  h.pending = fetchPicture(src, true).then((url) => {
    h.pending = null;
    h.url = url;
    if (old) URL.revokeObjectURL(old);
    if (!url) reportBrokenPicture(src, "it would not load again");
    for (const l of h.listeners) l(url);
    return url;
  });
  return true;
}

export function useImageSrc(src?: string | null): string | null {
  const [resolved, setResolved] = useState<string | null>(() => {
    if (!src) return null;
    if (!needsAuth(src)) return src;
    return held.get(src)?.url ?? null;
  });
  useEffect(() => {
    if (!src) {
      setResolved(null);
      return;
    }
    if (!needsAuth(src)) {
      setResolved(src);
      return;
    }
    let cancelled = false;
    const h = hold(src);
    const listen = (url: string | null) => {
      if (!cancelled) setResolved(url);
    };
    h.listeners.add(listen);
    if (h.url) setResolved(h.url);
    else {
      setResolved(null);
      void h.pending?.then((url) => {
        if (!cancelled) setResolved(url);
      });
    }
    return () => {
      cancelled = true;
      h.listeners.delete(listen);
      letGo(src, h);
    };
  }, [src]);
  return resolved;
}
