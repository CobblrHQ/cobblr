// A page on this site that a sign-in or a join may send someone back to: a
// workspace page (the item they scanned), an invite, or a machine share.
// Anything else, and in
// particular another origin ("//evil.example", "https://…"), is not a place
// to land, so the caller falls back to its own default.
export function landingPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length > 500 || /\s/.test(raw)) return null;
  return /^\/(w|invite|join-machines)\/[^/\\]/.test(raw) ? raw : null;
}

/** The `?next=` a sign-in page was opened with ("/?next=/invite/…"), if it
 *  names a page to come back to. */
export function nextFromQuery(search: string): string | null {
  try {
    return landingPath(new URLSearchParams(search).get("next"));
  } catch {
    return null;
  }
}

/** Where the page the visitor is on now would have them come back to. */
export function hereAsLanding(): string | null {
  try {
    return nextFromQuery(window.location.search) ?? landingPath(window.location.pathname + window.location.search);
  } catch {
    return null;
  }
}
