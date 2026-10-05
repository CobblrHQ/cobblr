// Changing the address a person signs in with.
//
// A person asks with their password; a link goes to the NEW address and
// nothing changes until it is used, so nobody can move an account to an
// address they do not read. Using it switches the address, marks it verified,
// signs out every session (the old address may be how someone else got in),
// and sends the OLD address a link that undoes it for 7 days: the person the
// account belonged to can always take it back. Undoing it also makes them
// choose a new password, because whoever changed it knew the old one.
//
// An account signed in through the central account service has no address of
// its own here: it changes there, and this says so.
//
// What stops a takeover through this flow (#4184), each held by a test in
// api/tests/a-sign-in-address-change-cannot-take-an-account.test.ts:
//   - asking needs the person: their password, or (an account with none) a
//     sign-in in the last few minutes; never an API token or a shared view.
//     A few asks an hour at most, so nobody is flooded with confirm emails.
//   - confirming voids every link the OLD address still holds (a reset, a
//     magic sign-in, a verify): whoever reads that mailbox later cannot use
//     one to walk back in.
//   - undoing it does not trust the password at all, since whoever changed
//     the address knew it: the password is cleared, every API token and
//     connected app is revoked, a queued change is dropped, and the person
//     holding the old mailbox sets the new password from a fresh reset link.
//   - every link starts with the instance's public address (link-origin.ts),
//     never the Host header of the request that sent it.
//
// Links are single use and stored hashed (sha256), like every auth token here.
// With no email sender configured, non-production answers carry the link's
// token so the flow can be exercised (the way verify and reset do).

import { createHash, randomBytes } from "node:crypto";
import { meta } from "../db/meta.js";
import { verifyPassword } from "../auth/password.js";
import { sendAuthEmail } from "./hosted-seams.js";
import { blockDisposableEnabled, isDisposableEmail } from "./disposable-emails.js";

const CONFIRM_HOURS = 24;
const REVERT_DAYS = 7;
/** An account with no password proves it is the person by a sign-in this recent. */
const RECENT_SIGN_IN_SEC = 10 * 60;
/** Asks per account per hour: enough for a typo or two, not a flood. */
const ASKS_PER_HOUR = 5;

const hash = (plain: string) => createHash("sha256").update(plain).digest("hex");
function mint(): { plain: string; hashed: string } {
  const plain = randomBytes(32).toString("base64url");
  return { plain, hashed: hash(plain) };
}
/** Security-relevant, so logged where the person's activity is read: their
 *  first workspace, as a password change is. */
async function logAccountEvent(userId: string, action: string, diff: Record<string, unknown>): Promise<void> {
  const first = await meta.selectFrom("org_memberships").select("org_id").where("user_id", "=", userId).limit(1).executeTakeFirst();
  if (!first) return;
  const activity = await import("./activity.js");
  await activity
    .log({ orgId: first.org_id, userId, action, ref: { module: null, entityType: "user", entityId: userId }, diff })
    .catch((err) => console.error(`[email-change] activity log failed:`, (err as Error).message));
}
const devToken = (emailed: boolean, plain: string) => (!emailed && process.env.NODE_ENV !== "production" ? plain : undefined);

export type ChangeRefusal =
  | { code: "bad_current_password"; status: 403; message: string }
  | { code: "needs_you"; status: 403; message: string }
  | { code: "sign_in_again"; status: 403; message: string }
  | { code: "too_many"; status: 429; message: string }
  | { code: "address_moved"; status: 409; message: string }
  | { code: "change_at_identity"; status: 409; message: string }
  | { code: "email_taken"; status: 409; message: string }
  | { code: "same_email"; status: 400; message: string }
  | { code: "disposable_email"; status: 400; message: string }
  | { code: "invalid_link"; status: 404; message: string }
  | { code: "link_used"; status: 410; message: string }
  | { code: "link_expired"; status: 410; message: string };

/** Every session from before `at` ends, including one issued in the same
 *  second: a token's issue time is whole seconds and the session check keeps
 *  a same-second token (the password change re-mints the person's own that
 *  second). Nothing is re-minted here, so the cutoff is the next second. */
const revokeFrom = (at: Date) => new Date(Math.floor(at.getTime() / 1000) * 1000 + 1000);

const refuse = <C extends ChangeRefusal["code"]>(code: C, status: Extract<ChangeRefusal, { code: C }>["status"], message: string) =>
  ({ refused: { code, status, message } as ChangeRefusal }) as const;

async function addressTaken(email: string, exceptUser: string): Promise<boolean> {
  const row = await meta.selectFrom("users").select("id").where("email", "=", email).where("id", "!=", exceptUser).executeTakeFirst();
  return !!row;
}

/** Ask for the sign-in address to change. Sends the confirm link to the new
 *  address; changes nothing yet. */
/** Who is asking, as the session says: a person signed in, how recently,
 *  or something standing in for them. */
export interface Asker {
  auth_method: "session" | "api_token";
  /** The session's issue time in seconds; null for an API token. */
  issued_at?: number | null;
  /** Set while the request is a View as through a share. */
  share_view?: unknown;
  app_scope?: string | null;
}

export async function requestEmailChange(
  userId: string,
  newEmailRaw: string,
  currentPassword: string | undefined,
  origin: string,
  asker: Asker,
): Promise<{ refused: ChangeRefusal } | { pending: string; expires_at: string; emailed: boolean; devToken?: string }> {
  // A token, an app or a borrowed view is not the person: how an account
  // signs in changes only from the person's own sign-in.
  if (asker.auth_method !== "session" || asker.share_view || asker.app_scope) {
    return refuse("needs_you", 403, "Changing the address you sign in with needs you, signed in yourself: not a token, an app or a shared view.");
  }
  const user = await meta
    .selectFrom("users")
    .select(["email", "password_hash", "identity_id"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  if (user.identity_id && user.password_hash.length === 0) {
    return refuse("change_at_identity", 409, "This account signs in through your Cobblr account, so its address changes there.");
  }
  if (user.password_hash.length === 0) {
    // No password to re-check (a magic-link account): a sign-in this recent
    // is the proof, the way a fresh link from their own mailbox is.
    const fresh = typeof asker.issued_at === "number" && Date.now() / 1000 - asker.issued_at <= RECENT_SIGN_IN_SEC;
    if (!fresh) return refuse("sign_in_again", 403, "To change your address, sign in again with a link to it first, then change it within 10 minutes.");
  } else if (!currentPassword || !(await verifyPassword(currentPassword, user.password_hash))) {
    return refuse("bad_current_password", 403, "Current password is incorrect.");
  }
  const recent = await meta
    .selectFrom("auth_email_change_tokens")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("user_id", "=", userId)
    .where("kind", "=", "confirm")
    .where("created_at", ">", new Date(Date.now() - 3_600_000))
    .executeTakeFirst();
  if (Number(recent?.n ?? 0) >= ASKS_PER_HOUR) {
    return refuse("too_many", 429, "That is several asks in an hour. Wait a while, then ask again.");
  }
  const newEmail = newEmailRaw.toLowerCase().trim();
  if (newEmail === user.email.toLowerCase()) return refuse("same_email", 400, "That is already your address.");
  if (blockDisposableEnabled() && isDisposableEmail(newEmail)) {
    return refuse("disposable_email", 400, "Use an address you will keep: throwaway addresses cannot sign in here.");
  }
  if (await addressTaken(newEmail, userId)) return refuse("email_taken", 409, "Another account already uses that address.");

  // One pending change at a time: asking again replaces the earlier link.
  await meta
    .updateTable("auth_email_change_tokens")
    .set({ consumed_at: new Date() })
    .where("user_id", "=", userId)
    .where("kind", "=", "confirm")
    .where("consumed_at", "is", null)
    .execute();
  const { plain, hashed } = mint();
  const expires = new Date(Date.now() + CONFIRM_HOURS * 3_600_000);
  // check-then-insert: the key is a random token minted here
  await meta
    .insertInto("auth_email_change_tokens")
    .values({ user_id: userId, kind: "confirm", old_email: user.email, new_email: newEmail, token_hash: hashed, expires_at: expires })
    .execute();
  const emailed = await sendAuthEmail({
    to: newEmail,
    subject: "Confirm your new Cobblr sign-in address",
    text:
      `Someone asked for this to become the address of a Cobblr account. To confirm it:\n\n${origin}/email-change/${plain}\n\n` +
      `Nothing changes until you open the link, and it expires in ${CONFIRM_HOURS} hours. If this was not you, ignore this email.`,
    kind: "notification",
  });
  return { pending: newEmail, expires_at: expires.toISOString(), emailed, devToken: devToken(emailed, plain) };
}

/** The change a person has asked for and not yet confirmed, if any. */
export async function pendingEmailChange(userId: string): Promise<{ email: string; expires_at: string } | null> {
  const row = await meta
    .selectFrom("auth_email_change_tokens")
    .select(["new_email", "expires_at"])
    .where("user_id", "=", userId)
    .where("kind", "=", "confirm")
    .where("consumed_at", "is", null)
    .where("expires_at", ">", new Date())
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row ? { email: row.new_email, expires_at: row.expires_at.toISOString() } : null;
}

async function takeLink(plain: string, kind: "confirm" | "revert") {
  const row = await meta
    .selectFrom("auth_email_change_tokens")
    .selectAll()
    .where("token_hash", "=", hash(plain))
    .where("kind", "=", kind)
    .executeTakeFirst();
  if (!row) return refuse("invalid_link", 404, "This link is not one we sent.");
  if (row.consumed_at) return refuse("link_used", 410, "This link was already used.");
  if (row.expires_at <= new Date()) return refuse("link_expired", 410, "This link has expired. Ask for the change again from your account.");
  return { row } as const;
}

/** The new address's link: the change happens here. Every session ends. */
export async function confirmEmailChange(
  plain: string,
  origin: string,
): Promise<{ refused: ChangeRefusal } | { email: string; revertDevToken?: string }> {
  const got = await takeLink(plain, "confirm");
  if ("refused" in got) return got;
  const { row } = got;
  // Taken since it was asked for: refuse rather than collide.
  if (await addressTaken(row.new_email, row.user_id)) return refuse("email_taken", 409, "Another account took that address in the meantime.");
  // The account's address changed some other way since this was asked for:
  // this link no longer describes a change from where the account is.
  const now = await meta.selectFrom("users").select("email").where("id", "=", row.user_id).executeTakeFirst();
  if (!now || now.email.toLowerCase() !== row.old_email.toLowerCase()) {
    return refuse("address_moved", 409, "The account's address changed since this was asked for. Ask again from your account.");
  }
  const at = new Date();
  await meta.transaction().execute(async (trx) => {
    await trx.updateTable("auth_email_change_tokens").set({ consumed_at: at }).where("id", "=", row.id).execute();
    await trx
      .updateTable("users")
      .set({ email: row.new_email, email_verified_at: at, tokens_valid_from: revokeFrom(at) })
      .where("id", "=", row.user_id)
      .execute();
    // The old mailbox keeps no way back in: a reset or verify link for this
    // account, or a sign-in link to the old address, sent before the change.
    await trx.updateTable("auth_password_reset_tokens").set({ consumed_at: at }).where("user_id", "=", row.user_id).where("consumed_at", "is", null).execute();
    await trx.updateTable("auth_email_verify_tokens").set({ consumed_at: at }).where("user_id", "=", row.user_id).where("consumed_at", "is", null).execute();
    await trx.updateTable("auth_magic_tokens").set({ consumed_at: at }).where("email", "=", row.old_email).where("consumed_at", "is", null).execute();
  });
  await logAccountEvent(row.user_id, "email_changed", { from: row.old_email, to: row.new_email });
  const { plain: revertPlain, hashed } = mint();
  await meta
    .insertInto("auth_email_change_tokens")
    .values({
      user_id: row.user_id,
      kind: "revert",
      old_email: row.old_email,
      new_email: row.new_email,
      token_hash: hashed,
      expires_at: new Date(Date.now() + REVERT_DAYS * 86_400_000),
    })
    .execute();
  const emailed = await sendAuthEmail({
    to: row.old_email,
    subject: "Your Cobblr sign-in address was changed",
    text:
      `The Cobblr account that used this address now signs in with ${row.new_email}, and every device was signed out.\n\n` +
      `If that was you, there is nothing to do. If it was not, take the account back within ${REVERT_DAYS} days:\n\n` +
      `${origin}/email-change/revert/${revertPlain}\n\nYou will then choose a new password.`,
    kind: "notification",
  });
  return { email: row.new_email, revertDevToken: devToken(emailed, revertPlain) };
}

/** The old address's link: the account goes back to it, and nothing the
 *  person who changed it holds still works. The password is cleared (they knew
 *  it), every session, API token and connected app is ended, a queued change
 *  is dropped, and the old mailbox's holder gets a fresh reset link to choose
 *  the new password. */
export async function revertEmailChange(plain: string): Promise<{ refused: ChangeRefusal } | { email: string; resetToken: string }> {
  const got = await takeLink(plain, "revert");
  if ("refused" in got) return got;
  const { row } = got;
  if (await addressTaken(row.old_email, row.user_id)) return refuse("email_taken", 409, "Another account now uses that address; ask whoever runs this instance for help.");
  const at = new Date();
  const reset = mint();
  await meta.transaction().execute(async (trx) => {
    await trx.updateTable("auth_email_change_tokens").set({ consumed_at: at }).where("id", "=", row.id).execute();
    // A change queued since (to yet another address) goes too.
    await trx.updateTable("auth_email_change_tokens").set({ consumed_at: at }).where("user_id", "=", row.user_id).where("kind", "=", "confirm").where("consumed_at", "is", null).execute();
    // No password survives: must_reset_password alone would let whoever knew
    // the old one sign in with it and choose the next. An empty hash matches
    // nothing; the reset link below sets the new one.
    await trx
      .updateTable("users")
      .set({ email: row.old_email, email_verified_at: at, tokens_valid_from: revokeFrom(at), password_hash: "", must_reset_password: false })
      .where("id", "=", row.user_id)
      .execute();
    // Credentials that never expire with a session: personal API tokens and
    // connected apps (their access tokens are API tokens too).
    await trx.updateTable("api_tokens").set({ revoked_at: at }).where("user_id", "=", row.user_id).where("revoked_at", "is", null).execute();
    await trx.updateTable("oauth_grants").set({ revoked_at: at }).where("user_id", "=", row.user_id).where("revoked_at", "is", null).execute();
    await trx.updateTable("auth_password_reset_tokens").set({ consumed_at: at }).where("user_id", "=", row.user_id).where("consumed_at", "is", null).execute();
    await trx.updateTable("auth_magic_tokens").set({ consumed_at: at }).where("email", "=", row.new_email).where("consumed_at", "is", null).execute();
    await trx.insertInto("auth_password_reset_tokens").values({ user_id: row.user_id, token_hash: reset.hashed, request_ip: null, request_ua: "email-change-revert" }).execute();
  });
  await logAccountEvent(row.user_id, "email_change_reverted", { back_to: row.old_email, from: row.new_email });
  return { email: row.old_email, resetToken: reset.plain };
}
