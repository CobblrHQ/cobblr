// A share invite opened signed out, held through the sign-in or sign-up in
// between (#4737; the shape of bring-pending.ts): a person with no account
// here signs up, verifies their email (which may land them back on "/"), and
// is taken back to the invite, ready to Accept.
const KEY = "cobblr.share-invite.pending";
/** An invite works for a week; nothing to hold past it. */
const MAX_AGE_MS = 8 * 86_400_000;

export function holdShareInvite(raw: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ raw, at: Date.now() }));
  } catch {
    /* private window: the address still carries it */
  }
}

/** The invite held from before, if any, without letting it go. */
export function pendingShareInvite(): string | null {
  try {
    const stored = localStorage.getItem(KEY);
    if (!stored) return null;
    const v = JSON.parse(stored) as { raw?: unknown; at?: unknown };
    if (typeof v.raw !== "string" || typeof v.at !== "number") return null;
    if (Date.now() - v.at > MAX_AGE_MS) {
      localStorage.removeItem(KEY);
      return null;
    }
    return v.raw;
  } catch {
    return null;
  }
}

/** Taken: the invite page has it again. */
export function dropShareInvite(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing held */
  }
}

/** The invite a sign-up is for: the page it will come back to, else the one held. */
export function shareInviteFor(search: string): string | null {
  try {
    const next = new URLSearchParams(search).get("next") ?? "";
    const m = /^\/share\/join#([A-Za-z0-9_-]{8,})$/.exec(next);
    return m ? m[1]! : pendingShareInvite();
  } catch {
    return pendingShareInvite();
  }
}
