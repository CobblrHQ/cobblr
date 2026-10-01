// Resolves an image src for <img>. External URLs (or null) pass
// through. Internal /api/v1/... URLs are fetched with the SPA's
// Bearer token, converted to blob: URLs, and revoked on unmount.
//
// EntityThumb and EntityTile both use this so the photo handling
// stays consistent across list and gallery views.

import { useEffect, useState } from "react";

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
}
const held = new Map<string, Held>();
const KEEP_MS = 60_000;
/** A grid asks for many pictures at once; one that fails to come in that
 *  burst (a 429, a 503, a dropped connection) is asked again before the card
 *  settles on its letter. One that is genuinely gone (401, 403, 404) is not. */
const RETRY_DELAYS_MS = [400, 1_500];

async function fetchPicture(src: string): Promise<string | null> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
  for (let attempt = 0; ; attempt++) {
    let again = false;
    try {
      const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.ok) return URL.createObjectURL(await res.blob());
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
    h = { url: null, pending: null, readers: 0, release: null };
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
      if (!url) held.delete(src);
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
    if (h.url) setResolved(h.url);
    else {
      setResolved(null);
      void h.pending?.then((url) => {
        if (!cancelled) setResolved(url);
      });
    }
    return () => {
      cancelled = true;
      letGo(src, h);
    };
  }, [src]);
  return resolved;
}
