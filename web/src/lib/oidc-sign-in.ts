// The browser's half of signing in through the instance's own provider
// (#4492). The api checks everything; this only remembers, across the trip to
// the provider, where the person was going and which provider signed them in
// (so Sign out can end that session too).
import { landingPath } from "./landing-path";

const NEXT = "cobblr.oidc.next";
const WITH = "cobblr.oidc.with";

/** Off to the provider, remembering where to land after. */
export function signInWith(slug: string, next: string | null): void {
  try {
    if (next) sessionStorage.setItem(NEXT, next);
  } catch {
    /* quiet: a private window lands on the home page instead */
  }
  window.location.assign(`/api/v1/auth/oidc/${encodeURIComponent(slug)}/start`);
}

/** Where to land, once: only a path landingPath allows. */
export function takeNext(): string {
  try {
    const n = sessionStorage.getItem(NEXT);
    sessionStorage.removeItem(NEXT);
    return landingPath(n) ?? "/";
  } catch {
    return "/";
  }
}

export function rememberSignedInWith(slug: string): void {
  try {
    localStorage.setItem(WITH, slug);
  } catch {
    /* quiet: sign out then ends only the Cobblr session */
  }
}
export function signedInWith(): string | null {
  try {
    return localStorage.getItem(WITH);
  } catch {
    return null;
  }
}
export function forgetSignedInWith(): void {
  try {
    localStorage.removeItem(WITH);
  } catch {
    /* quiet: nothing held */
  }
}
