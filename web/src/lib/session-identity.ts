// Whose answers the page is holding (#6970). Signing out and signing in as
// someone else happens in the same document, without a reload, so anything
// kept in memory (the query cache, the dashboard's primed snapshot) would show
// the next account what the last one read. The session is named by the
// account its token is for and the View as grant riding with it: a fresh token
// for the same account (a password change, sign out everywhere) is the same
// session and keeps what it read. Kept import-light: api.ts reads it.

const listeners = new Set<() => void>();

/** The account a session token is for: its `sub`, or the token itself when it
 *  does not read as one (a station or share token in another shape). */
export function tokenSubject(token: string | null): string {
  if (!token) return "";
  try {
    const part = token.split(".")[1];
    if (!part) return token;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub ? sub : token;
  } catch {
    return token;
  }
}

export function sessionIdentityOf(token: string | null, impersonation: string | null): string {
  return `${tokenSubject(token)} ${impersonation ?? ""}`;
}

/** Hear when the page starts answering for someone else. */
export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function sessionChanged(): void {
  for (const l of [...listeners]) l();
}
