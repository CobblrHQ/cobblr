// "Make this yours on Cobblr": leave the sandbox for the hosted product with a
// grant to read it, where one sign-up makes an account and the sandbox is
// brought in (docs/design-decisions/trial-ledger.md). No email here and no
// keep first: the account is made on the other side, and the sandbox is held
// open until that side says the carry landed, when it ends.
import { api } from "./api";

/** The hosted product's /carry page, carrying the grant. */
export function carryUrl(cloudUrl: string | null, here: string, grant: { token: string; source: string }): string {
  const url = new URL("/carry", new URL(cloudUrl || "/", here));
  url.searchParams.set("token", grant.token);
  url.searchParams.set("from", grant.source);
  return url.toString();
}

/** Mint the grant and go. Throws when the grant cannot be had, for the caller
 *  to say so; on success the page is already leaving. */
export async function makeItYours(): Promise<void> {
  const [p, grant] = await Promise.all([api.sandboxPaths(), api.startCarry()]);
  window.location.assign(carryUrl(p.cloud_url, window.location.origin, grant));
}
