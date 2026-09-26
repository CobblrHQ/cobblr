// The door to the Cobblr account service, and what rides through it.
//
// Every link to account.cobblr.xyz is built here, so the return address always
// carries what this surface needs back: the managed app a /start/<app> page
// asked for, and the source a sign-up link or QR named (`?source=3dp2026`).
// The account service keeps return_to's query intact through its whole
// journey, email confirmation included, and /auth/callback hands both to the
// api, which records the source on the new account's signed_up event.
/** The account service, as /auth/config names it. */
type Identity = { authorize_url: string; deployment: string; name?: string };

const SOURCE_KEY = "cobblr.signup.source";
const SOURCE_TTL_MS = 24 * 3_600_000;

/** A source label as the api accepts it, or null. */
export function cleanSource(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(s) ? s : null;
}

/** Keep `?source=` from the address this visit arrived on, for the sign-up it
 *  leads to. A later visit without one keeps the earlier source for a day. */
export function rememberSource(search: string, now: number = Date.now()): void {
  const s = cleanSource(new URLSearchParams(search).get("source"));
  if (!s) return;
  try {
    localStorage.setItem(SOURCE_KEY, JSON.stringify({ source: s, at: now }));
  } catch {
    /* storage refused: the source is lost, the sign-up is not */
  }
}

/** The remembered source, if it is less than a day old. */
export function rememberedSource(now: number = Date.now()): string | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SOURCE_KEY) || "null") as { source?: string; at?: number } | null;
    if (!raw?.source || typeof raw.at !== "number" || now - raw.at > SOURCE_TTL_MS) return null;
    return cleanSource(raw.source);
  } catch {
    return null;
  }
}

/** The link to the account service. `signup` opens it on Create account. */
export function authorizeHref(
  identity: Identity,
  opts: { signup?: boolean; app?: string; source?: string | null; origin?: string } = {},
): string {
  const back = new URL("/auth/callback", opts.origin ?? window.location.origin);
  if (opts.app) back.searchParams.set("app", opts.app);
  if (opts.source) back.searchParams.set("source", opts.source);
  const url = new URL(identity.authorize_url);
  url.searchParams.set("deployment", identity.deployment);
  url.searchParams.set("return_to", back.toString());
  if (opts.signup) url.searchParams.set("signup", "1");
  return url.toString();
}
