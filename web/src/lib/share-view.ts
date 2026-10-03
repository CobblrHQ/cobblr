// A View as through a share, in this tab (docs/design-decisions/share-spaces.md §14).
//
// The grant the other Cobblr made rides in sessionStorage, so it is this tab's
// only and dies with it; while it is there it is the tab's token, in place of
// the account's own. Ending it (Exit, or the grant running out) clears it and
// nothing else: the account signed in on this browser stays signed in.

const KEY = "cobblr.shareView";

export function getShareViewToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setShareViewToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    // A browser that keeps nothing cannot hold a view; the page says so.
  }
}
