// A tab left open answers for whoever is signed in on this browser now. Every
// request reads the token from shared storage, so after a sign-out in another
// tab this one kept drawing the last person's data and writing what it held
// back to the device, and after someone else signed in it sent their token
// from the last person's page. Storage events fire only in the other tabs, so
// the tab that signed in or out is not reloaded under its own feet.
import { accountToken, getToken } from "./api";
import { TOKEN_KEY } from "./api/client";
import { tokenSubject } from "./session-identity";

type TokenChange = Pick<StorageEvent, "key" | "oldValue" | "newValue">;

/** Someone else now, or no one. A fresh token for the same account (a password
 *  change, sign out everywhere) is the same person, and a tab answering for a
 *  share or a station is not answering for the account at all. */
export function anotherTabChangedWhoIsSignedIn(e: TokenChange): boolean {
  if (e.key !== TOKEN_KEY) return false;
  if (tokenSubject(e.oldValue) === tokenSubject(e.newValue)) return false;
  return getToken() === accountToken();
}

export function followSignInsAcrossTabs(reload: () => void): () => void {
  let reloading = false;
  const onStorage = (e: StorageEvent) => {
    if (reloading || !anotherTabChangedWhoIsSignedIn(e)) return;
    reloading = true;
    reload();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
