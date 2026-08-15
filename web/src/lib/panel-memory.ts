// Whether the Ask-Cobblr panel should come back after a refresh.
//
// It used to vanish, because its open state was plain component state. But the
// rule is narrower than "remember it was open": having it follow you onto every
// page afterwards is worse than losing it, since a panel that opens itself is
// something you have to keep closing.
//
// So what is remembered is WHERE it was open, and it comes back only there:
//
//   open on /scan, refresh /scan       -> comes back
//   open on /scan, refresh /inventory  -> stays closed
//   closed                             -> stays closed
//
// SESSION storage, not local, and that is the whole decay story. A refresh
// keeps the tab, so the panel returns. Close the tab and it is gone, so opening
// Cobblr fresh tomorrow does not greet you with a panel you opened once on
// Tuesday. Nobody has to prune anything.
//
// Paths are ROUTER paths ("/scan"), never window.location.pathname, which
// carries the `/w/<handle>` basename. Storing the raw location would mean the
// same page in two workspaces read as two different places.

const KEY = "cobblr.chat.openOn";

type MaybeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

function storage(): MaybeStorage {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Privacy modes throw on access rather than returning null.
    return null;
  }
}

/** The path the panel was open on, or null. */
export function readOpenOn(s: MaybeStorage = storage()): string | null {
  try {
    const v = s?.getItem(KEY);
    return v && v.startsWith("/") ? v : null;
  } catch {
    return null;
  }
}

/** Remember (or forget) where the panel is open. Null closes the memory. */
export function writeOpenOn(path: string | null, s: MaybeStorage = storage()): void {
  try {
    if (path) s?.setItem(KEY, path);
    else s?.removeItem(KEY);
  } catch {
    /* storage full or blocked — the panel simply will not persist */
  }
}

/**
 * Should the panel restore itself on this page?
 *
 * Compares the PATH only: a query string or hash is a different view of the
 * same page (a filter, an open row), and losing the panel because you refreshed
 * with a filter applied would be the same papercut in a smaller costume.
 */
export function restoresOn(storedPath: string | null, currentPath: string): boolean {
  if (!storedPath) return false;
  const strip = (p: string) => (p.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  return strip(storedPath) === strip(currentPath);
}
