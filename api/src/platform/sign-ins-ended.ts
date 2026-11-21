// Every sign-in an account had ended: signing out everywhere, a password
// changed or reset, an address changed back, the account deleted (#4115,
// #7921 class 8). Every request asks requireAuth, which refuses a token minted
// before tokens_valid_from or an inactive account. A stream is let in once, when
// it opens: a lost phone's open tab kept hearing which records changed after
// its owner signed out everywhere, and a ticket minted a minute before opened a
// new stream after it. So a stream remembers the sign-in it came from and asks
// again whether that still stands (openWorkspaceSse, openPersonSse).
//
// In-process, like the streams it closes. A door that does not announce is
// caught by the stream's own check before it sends, seconds later at most.
//
// A way back in still waiting to be used ends with them: a reset link in the
// inbox, a sign-in link, a phone's pairing code. Whoever read the inbox kept a
// reset link through the owner's "sign out everywhere" and chose the next
// password with it (#4115).
import type { Kysely, Updateable } from "kysely";
import { meta } from "../db/meta.js";
import type { MetaDB, UsersTable } from "../db/schema.js";

/** The sign-in a stream was opened by: whose, when its session token was
 *  minted (null for an API token), and the API token it was, if one. */
export interface SignIn {
  userId: string;
  issuedAt: number | null;
  apiTokenId: string | null;
}

/** End every sign-in this account had before `at`, and every way back in
 *  sent before it, in one transaction (the caller's, when it hands one in),
 *  writing `alsoSet` on the account with it. Every write of tokens_valid_from
 *  goes through here (code:sign-ins-end); the door then calls
 *  announceSignInsEnded once its write is committed. */
export async function endSignIns(db: Kysely<MetaDB>, userId: string, at: Date, alsoSet: Updateable<UsersTable> = {}): Promise<void> {
  const run = async (trx: Kysely<MetaDB>) => {
    // The address before alsoSet moves it: the links were sent to that one.
    const user = await trx.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirst();
    await trx.updateTable("users").set({ ...alsoSet, tokens_valid_from: at }).where("id", "=", userId).execute();
    await trx.updateTable("auth_password_reset_tokens").set({ consumed_at: at }).where("user_id", "=", userId).where("consumed_at", "is", null).execute();
    if (user) await trx.updateTable("auth_magic_tokens").set({ consumed_at: at }).where("email", "=", user.email.toLowerCase()).where("consumed_at", "is", null).execute();
    await trx.updateTable("auth_pair_codes").set({ revoked_at: at }).where("user_id", "=", userId).where("claimed_at", "is", null).where("revoked_at", "is", null).execute();
  };
  if (db.isTransaction) await run(db);
  else await db.transaction().execute(run);
}

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function onSignInsEnded(userId: string, fn: Listener): () => void {
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(userId);
  };
}

/** Every stream this account holds asks again whether its sign-in stands. */
export function announceSignInsEnded(userId: string): void {
  for (const fn of [...(listeners.get(userId) ?? [])]) {
    try {
      fn();
    } catch {
      // One stream that would not close must not keep the others open.
    }
  }
}

/** True while the sign-in still lets this person in: the account is active,
 *  its session token was minted after the account's last "end every sign-in",
 *  and the API token it was, if one, is neither revoked nor expired. */
export async function signInStands(s: SignIn): Promise<boolean> {
  const user = await meta.selectFrom("users").select(["active", "tokens_valid_from"]).where("id", "=", s.userId).executeTakeFirst();
  if (!user || !user.active) return false;
  if (s.issuedAt !== null && user.tokens_valid_from && s.issuedAt < new Date(user.tokens_valid_from).getTime() / 1000) return false;
  let tokenId = s.apiTokenId;
  for (let hop = 0; tokenId && hop < 8; hop++) {
    const t = await meta.selectFrom("api_tokens").select(["revoked_at", "expires_at", "parent_token_id"]).where("id", "=", tokenId).executeTakeFirst();
    if (!t || t.revoked_at || (t.expires_at && new Date(t.expires_at) < new Date())) return false;
    tokenId = t.parent_token_id;
  }
  return true;
}
