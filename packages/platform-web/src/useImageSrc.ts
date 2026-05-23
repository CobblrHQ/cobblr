// Resolves an image src for <img>. External URLs (or null) pass
// through. Internal /api/v1/... URLs are fetched with the SPA's
// Bearer token, converted to blob: URLs, and revoked on unmount.
//
// EntityThumb and EntityTile both use this so the photo handling
// stays consistent across list and gallery views.

import { useEffect, useState } from "react";

const TOKEN_KEY = "cobblr.token";

function needsAuth(src: string): boolean {
  if (src.startsWith("/api/v1/")) return true;
  try {
    const u = new URL(src, window.location.href);
    if (u.origin === window.location.origin && u.pathname.startsWith("/api/v1/")) {
      return true;
    }
  } catch {
    // Malformed URL — let <img> deal with it.
  }
  return false;
}

export function useImageSrc(src?: string | null): string | null {
  const [resolved, setResolved] = useState<string | null>(
    src && !needsAuth(src) ? src : null,
  );
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
    let blobUrl: string | null = null;
    const token =
      typeof window !== "undefined"
        ? window.localStorage.getItem(TOKEN_KEY)
        : null;
    fetch(src, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        setResolved(blobUrl);
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [src]);
  return resolved;
}
