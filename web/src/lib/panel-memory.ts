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
// WHICH tab was showing. Separate key, same storage, same decay: the panel
// coming back on the wrong tab is its own papercut - you left it on Discussion
// mid-conversation, refreshed, and it handed you Cobb instead. Remembering
// "open" without remembering "open on WHAT" only solves half of it.
const TAB_KEY = "cobblr.chat.openTab";

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

/** The tab the panel was showing, or null. */
export function readOpenTab(s: MaybeStorage = storage()): string | null {
  try {
    const v = s?.getItem(TAB_KEY);
    // Tab ids are short slugs the tabs themselves declare. Anything else is
    // somebody else's key or a stale shape, and picking the default beats
    // trying to honour it.
    return v && /^[a-z0-9-]{1,40}$/i.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember (or forget) which tab the panel is showing. */
export function writeOpenTab(tab: string | null, s: MaybeStorage = storage()): void {
  try {
    if (tab) s?.setItem(TAB_KEY, tab);
    else s?.removeItem(TAB_KEY);
  } catch {
    /* storage full or blocked - the tab simply will not persist */
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
