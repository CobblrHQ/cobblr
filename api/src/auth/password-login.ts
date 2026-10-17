// Who a password sign-in is for, and whether it may go on (#6910).
//
// The one field takes an email or a username: an "@" is an email, anything
// else a username (usernames never contain one). Whichever is typed, an
// existing account is ONE lockout bucket, its email, so trying a password as
// "demo" and as demo@example.com counts toward the same lock. An identifier
// that matches nobody is its own bucket, exactly as an unknown email always
// was, so the answers stay identical for registered and unregistered names.
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { isLocked, lockoutState } from "./lockout.js";
import { hashPassword, verifyPassword } from "./password.js";
import { identifierKind, normalizeUsername } from "../platform/usernames.js";

// A missing account spends the same ~bcrypt time as a real check, so latency
// says nothing about which names exist. (Audit 2026-06-26 P2.)
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword("cobblr-login-timing-equalizer");
  return dummyHash;
}

export interface SignInAccount {
  id: string;
  email: string;
  password_hash: string;
  active: boolean;
  email_verified_at: Date | null;
}

/** The account an identifier names, and the lockout bucket it counts in. */
export async function findSignInAccount(identifier: string): Promise<{ user: SignInAccount | null; bucket: string; kind: "email" | "username" }> {
  const typed = identifier.trim().toLowerCase();
  const kind = identifierKind(typed);
  const user = (await meta
    .selectFrom("users")
    .select(["id", "email", "password_hash", "active", "email_verified_at"])
    .where(kind === "email" ? "email" : "username", "=", kind === "email" ? typed : normalizeUsername(typed))
    .executeTakeFirst()) ?? null;
  return { user, bucket: user ? user.email.toLowerCase() : typed, kind };
}

/** The shared per-account lockout row for a bucket. */
export async function readLoginAttempt(bucket: string): Promise<{ failed_count: number; locked_until: Date | null } | undefined> {
  return meta.selectFrom("login_attempts").select(["failed_count", "locked_until"]).where("email", "=", bucket).executeTakeFirst();
}

/** One failed sign-in for a bucket: atomically bump the consecutive-failure
 *  count (shared across api instances) and lock once the backoff says so. */
export async function recordFailedLogin(bucket: string, now: Date): Promise<void> {
  const row = await meta
    .insertInto("login_attempts")
    .values({ email: bucket, failed_count: 1, last_failed_at: now, updated_at: now })
    .onConflict((oc) => oc.column("email").doUpdateSet({ failed_count: sql`login_attempts.failed_count + 1`, last_failed_at: now, updated_at: now }))
    .returning("failed_count")
    .executeTakeFirstOrThrow();
  const decision = lockoutState(row.failed_count, now);
  if (decision.locked) {
    await meta.updateTable("login_attempts").set({ locked_until: decision.lockedUntil, updated_at: now }).where("email", "=", bucket).execute();
  }
}

/** A proven-correct password clears the counter, so earlier typos never pile up. */
export async function clearLoginAttempts(bucket: string): Promise<void> {
  await meta.deleteFrom("login_attempts").where("email", "=", bucket).execute();
}

export type PasswordSignIn =
  | { outcome: "locked"; bucket: string; kind: "email" | "username" }
  | { outcome: "denied"; bucket: string; kind: "email" | "username"; user: SignInAccount | null; disabled?: true }
  | { outcome: "ok"; bucket: string; kind: "email" | "username"; user: SignInAccount };

/** The password half of signing in, with the lockout. `limits` is off only
 *  under the test rig, which signs the same accounts in thousands of times.
 *  A failure is NOT recorded here when the caller may still try the central
 *  account service; it records with `recordFailedLogin` once that says no. */
export async function attemptPasswordLogin(args: { identifier: string; password: string; now: Date; limits: boolean }): Promise<PasswordSignIn> {
  const { user, bucket, kind } = await findSignInAccount(args.identifier);
  // Checked before the password, so a locked account never reaches the hash.
  if (args.limits) {
    const attempt = await readLoginAttempt(bucket);
    if (attempt && isLocked(attempt.locked_until, args.now)) {
      await verifyPassword(args.password, await dummyPasswordHash());
      return { outcome: "locked", bucket, kind };
    }
  }
  // A disabled account is a decision somebody made; nothing reopens it.
  if (user && !user.active) {
    await verifyPassword(args.password, await dummyPasswordHash());
    return { outcome: "denied", bucket, kind, user: null, disabled: true };
  }
  const ok = user ? await verifyPassword(args.password, user.password_hash) : (await verifyPassword(args.password, await dummyPasswordHash()), false);
  if (!ok || !user) return { outcome: "denied", bucket, kind, user };
  if (args.limits) await clearLoginAttempts(bucket);
  return { outcome: "ok", bucket, kind, user };
}
